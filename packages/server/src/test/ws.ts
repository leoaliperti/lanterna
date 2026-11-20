import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import type { ServerMessage } from "@lanterna/shared";
import type { TestContext } from "./helpers.js";

/** Avvia il server su una porta libera e restituisce la porta. */
export async function listen(ctx: TestContext): Promise<number> {
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  return (ctx.app.server.address() as AddressInfo).port;
}

export interface WsOptions {
  cookie?: string;
  origin?: string | null;
  path?: string;
  autoPong?: boolean;
}

/**
 * Client WebSocket reale per i test: registra TUTTO il traffico ricevuto (testo grezzo),
 * così i test anti-fuga cercano le stringhe segrete nei byte effettivamente arrivati.
 */
export class WsClient {
  readonly frames: string[] = [];
  readonly messages: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private cursor = 0;
  private waiters: (() => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const text = (data as Buffer).toString("utf8");
      this.frames.push(text);
      this.messages.push(JSON.parse(text) as ServerMessage);
      this.wake();
    });
    ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.wake();
    });
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  static connect(port: number, opts: WsOptions = {}): Promise<WsClient> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    const origin = opts.origin === undefined ? "http://localhost:3000" : opts.origin;
    if (origin !== null) headers.origin = origin;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? "/ws"}`, {
      headers,
      autoPong: opts.autoPong ?? true,
    });
    const client = new WsClient(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(client));
      ws.once("unexpected-response", (_req, res) => {
        reject(new UpgradeRejected(res.statusCode ?? 0));
        ws.terminate();
      });
      ws.once("error", (err) => reject(err));
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(data: string | Buffer, binary = false): void {
    this.ws.send(data, { binary });
  }

  /** Tutto il traffico ricevuto, per le ricerche di stringhe segrete. */
  traffic(): string {
    return this.frames.join("\n");
  }

  /** Prossimo messaggio (dopo il cursore) che soddisfa `pred`. */
  async next<T extends ServerMessage = ServerMessage>(
    pred: (m: ServerMessage) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.messages.length) {
        const m = this.messages[this.cursor++]!;
        if (pred(m)) return m as T;
      }
      if (this.closed) throw new Error(`socket chiuso (${this.closed.code}) in attesa di un messaggio`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timeout in attesa di un messaggio");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  nextOfType<K extends ServerMessage["type"]>(type: K, timeoutMs?: number) {
    return this.next<Extract<ServerMessage, { type: K }>>((m) => m.type === type, timeoutMs);
  }

  /** Salta i messaggi già ricevuti. */
  skip(): void {
    this.cursor = this.messages.length;
  }

  async waitClose(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timeout in attesa della chiusura");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return this.closed;
  }

  close(): void {
    this.ws.close();
  }
}

export class UpgradeRejected extends Error {
  constructor(readonly status: number) {
    super(`upgrade rifiutato: ${status}`);
  }
}

/** Status HTTP con cui il server rifiuta l'upgrade (o 101 se lo accetta). */
export async function upgradeStatus(port: number, opts: WsOptions = {}): Promise<number> {
  try {
    const c = await WsClient.connect(port, opts);
    c.close();
    return 101;
  } catch (err) {
    if (err instanceof UpgradeRejected) return err.status;
    throw err;
  }
}

/** Breve attesa per verificare che NON arrivi nulla. */
export const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
