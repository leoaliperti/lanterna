import type { ChatLogEntry, EntryVisibility, Member, RollEntry } from "@lanterna/shared";
import type { CommandResult, RealtimeClient, RollOptions } from "../realtime/RealtimeClient";
import { applyLatestHistory, applyLiveEntry, applyOlderHistory } from "./chatLog";
import { announcement } from "./describe";

export type AdvantageMode = "normal" | "advantage" | "disadvantage";

/** Stato dei campi di scrittura: vive qui (non nel pannello) perche' le schede si smontano quando non sono visibili. */
export interface Composer {
  text: string;
  /** Destinatario del whisper, `null` = tutti. */
  recipient: string | null;
  formula: string;
  label: string;
  visibility: EntryVisibility;
  advantage: AdvantageMode;
}

export interface ChatState {
  entries: readonly ChatLogEntry[];
  hasMore: boolean;
  loadingOlder: boolean;
  /** Voci altrui arrivate mentre la chat non era visibile. */
  unread: number;
  panelVisible: boolean;
  /** Qualcuno ha chiesto di mettere il cursore nel campo di chat (scorciatoia). */
  pendingFocus: boolean;
  focusNonce: number;
  /** Ultima voce da annunciare agli screen reader (una alla volta, per non essere rumorosi). */
  live: { n: number; text: string } | null;
  composer: Composer;
}

export interface ChatStoreOptions {
  client: RealtimeClient;
  selfId: string;
  getMembers: () => readonly Member[];
}

const INITIAL_COMPOSER: Composer = { text: "", recipient: null, formula: "", label: "", visibility: "public", advantage: "normal" };

/**
 * Cronologia di chat e tiri della campagna. Non dipende da React. L'esito dei tiri viene
 * sempre e solo dal server (`roll.result`): qui si conservano e si mostrano, mai si calcolano.
 */
export class ChatStore {
  private state: ChatState = {
    entries: [],
    hasMore: false,
    loadingOlder: false,
    unread: 0,
    panelVisible: false,
    pendingFocus: false,
    focusNonce: 0,
    live: null,
    composer: INITIAL_COMPOSER
  };
  private readonly listeners = new Set<() => void>();
  private readonly rollListeners = new Set<(entry: RollEntry) => void>();
  private liveCounter = 0;
  private readonly client: RealtimeClient;
  private readonly selfId: string;
  private readonly getMembers: () => readonly Member[];

  constructor(options: ChatStoreOptions) {
    this.client = options.client;
    this.selfId = options.selfId;
    this.getMembers = options.getMembers;
  }

  getState = (): ChatState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  /** Ascolta i tiri arrivati dal vivo (non quelli della cronologia): serve all'animazione. */
  onRoll(l: (entry: RollEntry) => void): () => void {
    this.rollListeners.add(l);
    return () => {
      this.rollListeners.delete(l);
    };
  }

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }

  /** Si collega al client WebSocket. Restituisce la funzione per scollegarsi. */
  attach(): () => void {
    return this.client.onEvent((e) => {
      if (e.type !== "message") return;
      const m = e.message;
      if (m.type === "chat.message" || m.type === "roll.result") this.onLive(m.entry, m.type === "roll.result");
      else if (m.type === "history") this.onHistory(m.requestId, m.entries, m.hasMore);
    });
  }

  private onLive(entry: ChatLogEntry, isRoll: boolean): void {
    const next = applyLiveEntry(this.state, entry);
    if (next === this.state) return; // già nota (dedup per id)
    const mine = entry.authorId === this.selfId;
    const notice = !mine && !this.state.panelVisible;
    this.set({
      entries: next.entries,
      hasMore: next.hasMore,
      unread: notice ? this.state.unread + 1 : this.state.unread,
      live: mine ? this.state.live : { n: ++this.liveCounter, text: announcement(entry, this.selfId, this.getMembers()) }
    });
    if (isRoll && entry.kind === "roll") for (const l of [...this.rollListeners]) l(entry);
  }

  private onHistory(requestId: string | null, entries: readonly ChatLogEntry[], hasMore: boolean): void {
    if (requestId === null) {
      const next = applyLatestHistory(this.state, entries, hasMore);
      this.set({ entries: next.entries, hasMore: next.hasMore });
    } else {
      const next = applyOlderHistory(this.state, entries, hasMore);
      this.set({ entries: next.entries, hasMore: next.hasMore, loadingOlder: false });
    }
  }

  /** Chiede la pagina piu' vecchia, con cursore = id della prima voce mostrata. */
  async loadOlder(): Promise<void> {
    const first = this.state.entries[0];
    if (!first || !this.state.hasMore || this.state.loadingOlder) return;
    this.set({ loadingOlder: true });
    const r = await this.client.requestHistory(first.id);
    if (!r.ok) this.set({ loadingOlder: false, ...(r.code === "NOT_FOUND" ? { hasMore: false } : {}) });
    else if (this.state.loadingOlder) this.set({ loadingOlder: false });
  }

  setPanelVisible(visible: boolean): void {
    if (visible === this.state.panelVisible && !(visible && this.state.unread)) return;
    this.set({ panelVisible: visible, ...(visible ? { unread: 0 } : {}) });
  }

  requestFocus(): void {
    this.set({ pendingFocus: true, focusNonce: this.state.focusNonce + 1 });
  }

  consumeFocus(): void {
    if (this.state.pendingFocus) this.set({ pendingFocus: false });
  }

  patchComposer(patch: Partial<Composer>): void {
    this.set({ composer: { ...this.state.composer, ...patch } });
  }

  sendChat(text: string, whisperTo?: string): Promise<CommandResult> {
    return this.client.sendChat(text, whisperTo);
  }

  sendRoll(options: RollOptions): Promise<CommandResult> {
    return this.client.sendRoll(options);
  }
}
