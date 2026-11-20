import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  applyDelta,
  type CampaignView,
  type Command,
  type EntryVisibility,
  type ErrorCode,
  type ServerMessage
} from "@lanterna/shared";

/**
 * Client WebSocket di Lanterna. Non dipende da React: lo stato e' un oggetto immutabile che si
 * sostituisce a ogni cambiamento (compatibile con `useSyncExternalStore`).
 *
 * Il server decide: i comandi non modificano mai lo stato locale. La vista cambia solo quando
 * arrivano snapshot e delta, che qui si applicano con `applyDelta` (logica condivisa).
 */

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline" | "failed";

/** Perche' la connessione e' stata abbandonata (nessun nuovo tentativo automatico). */
export type FailureReason = "session" | "not-member" | "protocol";

export interface RealtimeState {
  status: ConnectionStatus;
  /** Ultima vista nota. Resta mostrata anche durante la riconnessione. */
  view: CampaignView | null;
  epoch: string | null;
  failure: FailureReason | null;
  /** Tentativi di riconnessione consecutivi (0 se connesso). */
  attempt: number;
}

export type CommandResult =
  | { ok: true; version: number }
  | {
      ok: false;
      code: ErrorCode | "OFFLINE" | "TIMEOUT";
      message: string;
      /** Codice del parser dei dadi, presente quando la formula non e' valida. */
      reason?: string;
    };

/** Richiesta di un tiro: il client manda solo la formula, l'esito lo decide il server. */
export interface RollOptions {
  formula: string;
  visibility: EntryVisibility;
  whisperTo?: string;
  label?: string;
}

export type RealtimeEvent =
  /** Errore non legato a una richiesta (messaggio illeggibile, rate limit). */
  | { type: "error"; code: ErrorCode; message: string }
  /** Messaggi che il client non interpreta qui (chat, tiri): li ascolta chi ne ha bisogno. */
  | { type: "message"; message: ServerMessage }
  /** La sessione non e' piu' valida: tornare al login. */
  | { type: "session-ended" };

/** Parte di `WebSocket` che serve al client (permette un server finto nei test). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface RealtimeOptions {
  campaignId: string;
  /** Dove connettersi (ws://.../api/ws). */
  url: string;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  /** Primo ritardo e tetto del backoff esponenziale, in ms. */
  backoff?: { baseMs: number; maxMs: number };
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  commandTimeoutMs?: number;
  isOnline?: () => boolean;
  /**
   * Chiamato dopo ogni 3 tentativi falliti di fila: se risponde `false` la sessione e' scaduta
   * (il browser non distingue un 401 dell'upgrade da un'altra caduta) e si smette di riprovare.
   */
  verifySession?: () => Promise<boolean>;
}

const OPEN = 1;

/** Ritardo prima del tentativo `attempt` (0, 1, 2...): esponenziale con tetto e jitter ("equal jitter"). */
export function backoffDelay(attempt: number, base: number, max: number, random: () => number): number {
  const cap = Math.min(max, base * 2 ** Math.min(attempt, 30));
  return Math.round(cap / 2 + random() * (cap / 2));
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

interface Pending {
  resolve: (r: CommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CLOSE_SESSION = 4401;
const CLOSE_NOT_MEMBER = 4404;
const CLOSE_PROTOCOL = 4400;
const CLOSE_PING_TIMEOUT = 4000;

type ResolvedOptions = Required<Omit<RealtimeOptions, "verifySession">> & Pick<RealtimeOptions, "verifySession">;

export class RealtimeClient {
  private readonly opts: ResolvedOptions;
  private state: RealtimeState = { status: "connecting", view: null, epoch: null, failure: null, attempt: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(e: RealtimeEvent) => void>();
  private readonly pending = new Map<string, Pending>();
  private socket: SocketLike | null = null;
  private running = false;
  private resyncing = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor(options: RealtimeOptions) {
    this.opts = {
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      random: Math.random,
      backoff: { baseMs: 500, maxMs: 15_000 },
      pingIntervalMs: 25_000,
      pongTimeoutMs: 10_000,
      commandTimeoutMs: 10_000,
      isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
      ...options
    };
  }

  /* ---------- store ---------- */

  getState = (): RealtimeState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onEvent(listener: (e: RealtimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private set(patch: Partial<RealtimeState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }

  private emit(e: RealtimeEvent): void {
    for (const l of [...this.eventListeners]) l(e);
  }

  /* ---------- ciclo di vita ---------- */

  start(): void {
    if (this.running) return;
    this.running = true;
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      window.addEventListener("offline", this.onOffline);
    }
    this.failures = 0;
    const online = this.opts.isOnline();
    this.set({ status: online ? "connecting" : "offline", failure: null, attempt: 0 });
    if (online) this.connect();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
    }
    this.clearTimers();
    this.detach(1000, "chiusura");
    this.rejectAll("Connessione chiusa");
  }

  /** Riprova subito (tornata la rete, pulsante "Riprova"). */
  retryNow(): void {
    if (!this.running || this.state.failure) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (!this.socket) this.connect();
  }

  private readonly onOnline = (): void => {
    this.retryNow();
  };

  private readonly onOffline = (): void => {
    if (!this.running || this.state.failure) return;
    this.set({ status: "offline" });
  };

  private connect(): void {
    if (!this.running || this.socket) return;
    let socket: SocketLike;
    try {
      socket = this.opts.createSocket(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.resyncing = false;
      this.sendHello(false);
      this.startPing();
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.handleRaw(ev.data);
    };
    socket.onerror = () => undefined; // l'esito arriva da onclose
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.handleClose(ev.code);
    };
  }

  /** Stacca e chiude il socket corrente senza far scattare la riconnessione. */
  private detach(code: number, reason: string): void {
    const s = this.socket;
    this.socket = null;
    this.stopPing();
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close(code, reason);
    } catch {
      /* gia' chiuso */
    }
  }

  private sendHello(forceSnapshot: boolean): void {
    this.rawSend({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      campaignId: this.opts.campaignId,
      lastVersion: forceSnapshot ? null : (this.state.view?.version ?? null),
      epoch: forceSnapshot ? null : this.state.epoch
    });
  }

  private rawSend(message: object): boolean {
    const s = this.socket;
    if (!s || s.readyState !== OPEN) return false;
    try {
      s.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /* ---------- ricezione ---------- */

  private handleRaw(data: unknown): void {
    if (typeof data !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) return; // messaggio di un'altra versione del protocollo: lo si ignora
    this.handle(parsed.data);
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "snapshot":
        this.resyncing = false;
        this.failures = 0;
        this.set({ view: msg.view, epoch: msg.epoch, status: "connected", attempt: 0 });
        return;
      case "delta": {
        const view = this.state.view;
        if (this.resyncing) return; // in attesa dello snapshot: i delta successivi hanno un buco
        if (!view) {
          this.requestSnapshot();
          return;
        }
        if (msg.epoch === this.state.epoch && msg.toVersion === view.version && msg.fromVersion === view.version) {
          this.markConnected(); // "sei gia' aggiornato" dopo una riconnessione
          return;
        }
        const r = applyDelta(view, this.state.epoch ?? "", msg);
        if (!r.ok) {
          this.requestSnapshot();
          return;
        }
        this.failures = 0;
        this.set({ view: r.view, status: "connected", attempt: 0 });
        return;
      }
      case "ack":
        this.settle(msg.requestId, { ok: true, version: msg.version });
        return;
      case "error":
        if (msg.requestId && this.settle(msg.requestId, { ok: false, code: msg.code, message: msg.message, reason: msg.reason })) return;
        this.emit({ type: "error", code: msg.code, message: msg.message });
        return;
      case "pong":
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      case "chat.message":
      case "roll.result":
      case "history":
        // Con `requestId` e' la conferma della richiesta fatta da questa connessione.
        if (msg.requestId) this.settle(msg.requestId, { ok: true, version: this.state.view?.version ?? 0 });
        this.emit({ type: "message", message: msg });
        return;
      default:
        this.emit({ type: "message", message: msg });
    }
  }

  private markConnected(): void {
    this.failures = 0;
    if (this.state.status !== "connected" || this.state.attempt !== 0) this.set({ status: "connected", attempt: 0 });
  }

  /** Buco di versione o epoca diversa: si chiede uno stato completo. */
  private requestSnapshot(): void {
    this.resyncing = true;
    this.sendHello(true);
  }

  /* ---------- chiusura e riconnessione ---------- */

  private handleClose(code: number): void {
    this.stopPing();
    this.rejectAll("Connessione interrotta");
    if (!this.running) return;
    if (code === CLOSE_SESSION) return this.fail("session");
    if (code === CLOSE_NOT_MEMBER) return this.fail("not-member");
    if (code === CLOSE_PROTOCOL) return this.fail("protocol");
    this.scheduleReconnect();
  }

  private fail(reason: FailureReason): void {
    this.clearTimers();
    this.set({ status: "failed", failure: reason });
    if (reason === "session") this.emit({ type: "session-ended" });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const attempt = this.state.attempt;
    const delay = backoffDelay(attempt, this.opts.backoff.baseMs, this.opts.backoff.maxMs, this.opts.random);
    this.failures += 1;
    this.set({ status: this.opts.isOnline() ? "reconnecting" : "offline", attempt: attempt + 1 });
    const verify = this.failures % 3 === 0 ? this.opts.verifySession : undefined;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      if (verify) {
        void verify().then(
          (valid) => {
            if (!this.running) return;
            if (!valid) this.fail("session");
            else this.connect();
          },
          () => this.connect()
        );
        return;
      }
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
  }

  /* ---------- ping ---------- */

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.rawSend({ type: "ping" })) return;
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        // Connessione "mezza morta": si abbandona il socket e si riconnette.
        this.detach(CLOSE_PING_TIMEOUT, "pong mancante");
        this.handleClose(CLOSE_PING_TIMEOUT);
      }, this.opts.pongTimeoutMs);
    }, this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  /* ---------- comandi ---------- */

  private request(build: (requestId: string) => object): Promise<CommandResult> {
    const requestId = newRequestId();
    if (!this.socket || this.state.status !== "connected" || !this.rawSend(build(requestId))) {
      return Promise.resolve({ ok: false, code: "OFFLINE", message: "Non sei connesso al server" });
    }
    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, code: "TIMEOUT", message: "Il server non ha risposto" });
      }, this.opts.commandTimeoutMs);
      this.pending.set(requestId, { resolve, timer });
    });
  }

  /** Invia un comando. Nessun effetto ottimistico: la vista cambia quando il server manda il delta. */
  sendCommand(command: Command): Promise<CommandResult> {
    return this.request((requestId) => ({ type: "command", requestId, command }));
  }

  undo(): Promise<CommandResult> {
    return this.request((requestId) => ({ type: "undo", requestId }));
  }

  redo(): Promise<CommandResult> {
    return this.request((requestId) => ({ type: "redo", requestId }));
  }

  /** Messaggio di chat (testo semplice). `whisperTo` = userId del destinatario. */
  sendChat(text: string, whisperTo?: string): Promise<CommandResult> {
    return this.request((requestId) => ({ type: "chat.send", requestId, text, ...(whisperTo ? { whisperTo } : {}) }));
  }

  /** Chiede un tiro. L'esito arriva come `roll.result` dal server: qui non si calcola nulla. */
  sendRoll(options: RollOptions): Promise<CommandResult> {
    const { formula, visibility, whisperTo, label } = options;
    return this.request((requestId) => ({
      type: "roll.request",
      requestId,
      formula,
      visibility,
      ...(whisperTo ? { whisperTo } : {}),
      ...(label ? { label } : {})
    }));
  }

  /** Pagina di cronologia piu' vecchia della voce `before` (id). La pagina arriva come evento `history`. */
  requestHistory(before: string | null, limit?: number): Promise<CommandResult> {
    return this.request((requestId) => ({ type: "history.request", requestId, before, ...(limit ? { limit } : {}) }));
  }

  private settle(requestId: string, result: CommandResult): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(result);
    return true;
  }

  private rejectAll(message: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { ok: false, code: "OFFLINE", message });
  }
}
