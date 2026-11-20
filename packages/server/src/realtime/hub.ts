import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import {
  PROTOCOL_VERSION,
  createEventLog,
  createHistory,
  deltaFor,
  dispatch,
  planResync,
  resolveActor,
  snapshotFor,
  type Actor,
  type CampaignCore,
  type DispatchInput,
  type DispatchResult,
  type ErrorMessage,
  type ServerMessage,
  type Token,
} from "@lanterna/shared";
import type { z } from "zod";
import type { HelloSchema } from "@lanterna/shared";
import {
  LOG_CAPACITY,
  campaignIdsOf,
  listCampaignIds,
  loadCampaign,
  loadMembers,
  persistChanges,
  persistReset,
} from "../campaigns/store.js";
import type { Db } from "../db/client.js";

type Hello = z.infer<typeof HelloSchema>;

/** Codici di chiusura WebSocket usati dal server (4000-4999: riservati alle applicazioni). */
export const CLOSE = {
  goingAway: 1001,
  policy: 1008,
  badProtocol: 4400,
  sessionEnded: 4401,
  permissionsChanged: 4403,
  notFound: 4404,
  helloTimeout: 4408,
} as const;

/** Una connessione WebSocket autenticata, vista dall'hub. */
export interface Peer {
  readonly id: string;
  /** Dalla sessione cookie dell'upgrade: mai da un messaggio del client. */
  readonly userId: string;
  readonly sessionId: string;
  /** Impostati dopo un `hello` valido. */
  actor: Actor | null;
  campaignId: string | null;
  /** Ultima versione inviata a questo client (snapshot o delta). */
  lastSent: number;
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

interface Room {
  core: CampaignCore;
  peers: Set<Peer>;
  /** Coda delle operazioni: comandi e cambi di membri si applicano uno alla volta. */
  queue: Promise<void>;
}

function errorMessage(requestId: string | null, code: ErrorMessage["code"], message: string): ErrorMessage {
  return { type: "error", requestId, code, message };
}

/**
 * Stanze per campagna: stato in memoria (unica fonte di verità a runtime), salvato su
 * SQLite dopo ogni comando accettato PRIMA di essere applicato e inviato ai client.
 */
export class Hub {
  private readonly rooms = new Map<string, Room>();
  private readonly peers = new Set<Peer>();

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Carica tutte le campagne salvate (all'avvio). */
  async loadAll(): Promise<void> {
    for (const id of await listCampaignIds(this.db)) await this.loadRoom(id);
  }

  async loadRoom(id: string): Promise<void> {
    const loaded = await loadCampaign(this.db, id);
    if (!loaded) return;
    let { epoch } = loaded;
    if (loaded.sanitized) {
      epoch = randomUUID();
      await persistReset(this.db, loaded.state, epoch, loaded.state.tokens.map((t) => t.id));
    }
    const log = { ...createEventLog(epoch, LOG_CAPACITY), entries: loaded.log };
    this.rooms.set(id, { core: { state: loaded.state, history: createHistory(), log }, peers: new Set(), queue: Promise.resolve() });
  }

  /** Stato completo (solo per test e diagnostica lato server). */
  stateOf(campaignId: string) {
    return this.rooms.get(campaignId)?.core;
  }

  addPeer(peer: Peer): void {
    this.peers.add(peer);
  }

  removePeer(peer: Peer): void {
    this.peers.delete(peer);
    if (peer.campaignId) this.rooms.get(peer.campaignId)?.peers.delete(peer);
  }

  allPeers(): ReadonlySet<Peer> {
    return this.peers;
  }

  connectionsOf(userId: string): number {
    let n = 0;
    for (const p of this.peers) if (p.userId === userId) n++;
    return n;
  }

  /** `hello`: entra nella stanza e riceve delta o snapshot (`planResync`). */
  hello(peer: Peer, msg: Hello): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      peer.send(errorMessage(null, "INVALID", "versione del protocollo non supportata"));
      peer.close(CLOSE.badProtocol, "protocollo");
      return;
    }
    const room = this.rooms.get(msg.campaignId);
    const actor = room ? resolveActor(room.core.state, peer.userId) : null;
    if (!room || !actor) {
      // Campagna inesistente o utente non membro: stessa risposta.
      peer.send(errorMessage(null, "NOT_FOUND", "campagna non trovata"));
      peer.close(CLOSE.notFound, "campagna");
      return;
    }
    if (peer.campaignId && peer.campaignId !== msg.campaignId) this.rooms.get(peer.campaignId)?.peers.delete(peer);
    peer.actor = actor;
    peer.campaignId = msg.campaignId;
    room.peers.add(peer);
    const { state, log } = room.core;
    peer.send(planResync(state, log, actor, { lastVersion: msg.lastVersion, epoch: msg.epoch }));
    peer.lastSent = state.version;
  }

  /** Comando / annulla / ripeti, con l'attore della connessione (mai dati del client). */
  submit(peer: Peer, input: DispatchInput): Promise<void> {
    const room = peer.campaignId ? this.rooms.get(peer.campaignId) : undefined;
    if (!room || !peer.actor) {
      peer.send(errorMessage(input.requestId, "INVALID", "serve prima hello"));
      return Promise.resolve();
    }
    return this.enqueue(room, async () => {
      // La connessione potrebbe essere stata chiusa o spostata mentre era in coda.
      if (!peer.actor || !room.peers.has(peer)) return;
      const r = dispatch(room.core, peer.actor, input);
      if (r.changes.length > 0) {
        try {
          await persistChanges(this.db, r.core.state, r.changes);
        } catch (err) {
          this.log.error({ err }, "salvataggio della campagna non riuscito");
          peer.send(errorMessage(input.requestId, "CONFLICT", "salvataggio non riuscito, riprova"));
          return;
        }
      }
      room.core = r.core;
      if (r.changes.length > 0) this.broadcast(room, r);
      peer.send(r.reply);
    });
  }

  private broadcast(room: Room, r: DispatchResult): void {
    const epoch = room.core.log.epoch;
    for (const p of room.peers) {
      if (!p.actor) continue;
      const d = deltaFor(p.actor, epoch, p.lastSent, r.toVersion, r.changes);
      if (!d) continue;
      p.send(d);
      p.lastSent = r.toVersion;
    }
  }

  private enqueue(room: Room, fn: () => Promise<void>): Promise<void> {
    const next = room.queue.then(fn).catch((err: unknown) => {
      this.log.error({ err }, "errore nella coda della campagna");
    });
    room.queue = next;
    return next;
  }

  /**
   * Ricarica i membri dal database (aggiunta/rimozione, cambio ruolo, utente eliminato).
   * Lo stato cambia fuori dai comandi: nuova epoca e snapshot a tutti; chi non è più membro
   * o ha cambiato ruolo viene disconnesso.
   */
  refreshMembers(campaignId: string): Promise<void> {
    const room = this.rooms.get(campaignId);
    if (!room) return Promise.resolve();
    return this.enqueue(room, async () => {
      const members = await loadMembers(this.db, campaignId);
      const memberIds = new Set(members.map((m) => m.userId));
      const touched: string[] = [];
      const tokens: Token[] = room.core.state.tokens.map((t) => {
        if (t.ownerUserId === null || memberIds.has(t.ownerUserId)) return t;
        touched.push(t.id);
        return { ...t, ownerUserId: null };
      });
      const state = { ...room.core.state, members, tokens };
      const epoch = randomUUID();
      await persistReset(this.db, state, epoch, touched);
      room.core = { state, history: createHistory(), log: createEventLog(epoch, LOG_CAPACITY) };
      for (const p of [...room.peers]) {
        const actor = resolveActor(state, p.userId);
        if (!actor || !p.actor || actor.role !== p.actor.role) {
          room.peers.delete(p);
          p.actor = null;
          p.close(CLOSE.permissionsChanged, "permessi cambiati");
          continue;
        }
        p.actor = actor;
        p.send(snapshotFor(state, actor, epoch));
        p.lastSent = state.version;
      }
    });
  }

  /** Chiude tutte le connessioni di un utente (ruolo cambiato, eliminato, password reimpostata). */
  closeUser(userId: string, code: number, reason: string): void {
    for (const p of [...this.peers]) {
      if (p.userId !== userId) continue;
      this.removePeer(p);
      p.actor = null;
      p.close(code, reason);
    }
  }

  /** Ruolo cambiato o utente eliminato: chiude le sue connessioni e aggiorna i membri delle sue campagne. */
  async userChanged(userId: string): Promise<void> {
    this.closeUser(userId, CLOSE.permissionsChanged, "permessi cambiati");
    const ids = new Set(await campaignIdsOf(this.db, userId));
    for (const [id, room] of this.rooms) {
      if (room.core.state.members.some((m) => m.userId === userId)) ids.add(id);
    }
    for (const id of ids) await this.refreshMembers(id);
  }

  /** Chiude tutte le connessioni e attende che i salvataggi in coda finiscano. */
  async shutdown(): Promise<void> {
    for (const p of [...this.peers]) {
      this.removePeer(p);
      p.close(CLOSE.goingAway, "arresto del server");
    }
    await Promise.all([...this.rooms.values()].map((r) => r.queue));
  }
}
