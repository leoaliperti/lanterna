import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import {
  PROTOCOL_VERSION,
  describeChanges,
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
  withMembers,
  canSeeToken,
  fogOf,
  isGm,
  maskFor,
  canSeeScene,
  defaultTtlMs,
  rollInitiative,
  shapeForViewer,
  validateEphemeral,
  MAX_LIVE_EPHEMERALS,
  type EphemeralClear,
  type EphemeralShow,
  type InitiativeRollRequest,
  type Fog,
  type FogMask,
  type Scene,
} from "@lanterna/shared";
import type { z } from "zod";
import {
  MAX_HISTORY_PAGE,
  canSeeEntry,
  type ChatLogEntry,
  type ChatSend,
  type HelloSchema,
  type HistoryRequest,
  type RandomInt,
  type RollRequest,
} from "@lanterna/shared";
import { buildChatEntry, buildRollEntry, type Built, type EntryError } from "../chat/entries.js";
import { insertEntry, loadPage } from "../chat/store.js";
import { writeGameLog } from "../gamelog/store.js";
import type { AppConfig } from "../config.js";
import { TokenBucket } from "./rate.js";
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
  /**
   * Finestre multiple (M9): utente di cui questa connessione riceve la vista (`null` = se stessa).
   * Solo un GM della campagna può guardare come un altro membro; `actor` è allora quello del membro,
   * così filtri, nebbia, chat ed effimeri sono esattamente quelli che riceve lui.
   */
  readonly viewAs: string | null;
  /** Nessun comando, annulla, chat, tiro, iniziativa o effimero (vero sempre con `viewAs`). */
  readonly readOnly: boolean;
  /** Impostati dopo un `hello` valido. Con `viewAs` è l'attore del membro guardato, non di chi guarda. */
  actor: Actor | null;
  campaignId: string | null;
  /** Ultima versione inviata a questo client (snapshot o delta). */
  lastSent: number;
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** Forma effimera ancora viva (M7): non viene mai salvata, vive solo in memoria finché non scade. */
interface LiveEphemeral {
  authorId: string;
  id: string;
  expiresAt: number;
  /** Chi l'ha ricevuta: a loro, e solo a loro, si manda l'eventuale `ephemeral.cleared`. */
  recipients: Set<Peer>;
}

interface Room {
  core: CampaignCore;
  peers: Set<Peer>;
  /** Coda delle operazioni: comandi e cambi di membri si applicano uno alla volta. */
  queue: Promise<void>;
  /** Forme effimere vive, per `autore:id`. */
  ephemerals: Map<string, LiveEphemeral>;
}

type ViewerResult = { ok: true; actor: Actor } | { ok: false; reason: "not-member" | "forbidden" | "target" };

/**
 * Attore con cui filtrare tutto ciò che riceve una connessione (M9). Senza `viewAs` (o con se stessi)
 * è l'utente della sessione. Con `viewAs` chi guarda deve essere GM della campagna (`forbidden`
 * altrimenti) e il guardato un suo membro (`target`): l'attore è quello del guardato.
 */
export function viewerActor(state: CampaignCore["state"], userId: string, viewAs: string | null): ViewerResult {
  const real = resolveActor(state, userId);
  if (!real) return { ok: false, reason: "not-member" };
  if (viewAs === null || viewAs === userId) return { ok: true, actor: real };
  if (!isGm(real)) return { ok: false, reason: "forbidden" };
  const target = resolveActor(state, viewAs);
  return target ? { ok: true, actor: target } : { ok: false, reason: "target" };
}

function errorMessage(requestId: string | null, code: ErrorMessage["code"], message: string): ErrorMessage {
  return { type: "error", requestId, code, message };
}

function entryError(requestId: string, e: EntryError): ErrorMessage {
  return e.reason
    ? { type: "error", requestId, code: e.code, message: e.message, reason: e.reason }
    : errorMessage(requestId, e.code, e.message);
}

export interface HubOptions {
  /** Generatore dei tiri. In produzione `crypto.randomInt` (`dice/crypto-rng.ts`); i test possono iniettarne uno. */
  rng: RandomInt;
  chat: AppConfig["chat"];
  ephemeral: AppConfig["ephemeral"];
}

/** Limiti di chat e tiri di un utente (condivisi fra tutte le sue connessioni). */
interface UserLimits {
  chat: TokenBucket;
  roll: TokenBucket;
  ephemeral: TokenBucket;
}

/**
 * Stanze per campagna: stato in memoria (unica fonte di verità a runtime), salvato su
 * SQLite dopo ogni comando accettato PRIMA di essere applicato e inviato ai client.
 */
export class Hub {
  private readonly rooms = new Map<string, Room>();
  private readonly peers = new Set<Peer>();
  private readonly limits = new Map<string, UserLimits>();
  /** Generatore usato per ogni tiro (esposto per i test). */
  readonly rng: RandomInt;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly options: HubOptions,
  ) {
    this.rng = options.rng;
  }

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
      await persistReset(this.db, loaded.state, epoch, loaded.touchedTokenIds, loaded.touchedFogSceneIds);
    }
    const log = { ...createEventLog(epoch, LOG_CAPACITY), entries: loaded.log };
    this.rooms.set(id, { core: { state: loaded.state, history: createHistory(), log }, peers: new Set(), queue: Promise.resolve(), ephemerals: new Map() });
  }

  /** Stato completo (solo per test e diagnostica lato server). */
  stateOf(campaignId: string) {
    return this.rooms.get(campaignId)?.core;
  }

  // -------------------------------------------------------------------------
  // Nebbia (M6): chi può scaricare cosa (tessere e file caricati)
  // -------------------------------------------------------------------------

  /**
   * Contesto per servire le tessere della mappa di una scena a `userId`, oppure `null`
   * (campagna inesistente, non membro, scena non visibile, nebbia assente, mappa assente:
   * il chiamante risponde con lo stesso 404 in tutti i casi).
   * GM: `mask: null` (vede tutto). Giocatore: solo la scena attiva con nebbia, con la sua maschera.
   */
  tileContext(
    userId: string,
    campaignId: string,
    sceneId: string,
    /** M9: tessere come le riceve questo membro (solo un GM della campagna può chiederlo). */
    viewAs: string | null = null,
  ): { scene: Scene; fog: Fog | null; mask: FogMask | null } | null | "forbidden" {
    const state = this.rooms.get(campaignId)?.core.state;
    if (!state) return null;
    const viewer = viewerActor(state, userId, viewAs);
    if (!viewer.ok) return viewer.reason === "forbidden" ? "forbidden" : null;
    const actor = viewer.actor;
    const scene = state.scenes.find((s) => s.id === sceneId);
    if (!scene || !scene.map) return null;
    const fog = fogOf(state, sceneId);
    if (isGm(actor)) return { scene, fog, mask: null };
    if (state.activeSceneId !== sceneId || !fog) return null;
    return { scene, fog, mask: maskFor(fog, actor.userId) };
  }

  /**
   * Un giocatore può scaricare l'asset `assetId` (servito come `url`) da `/assets`?
   * Un asset usato come mappa di una scena CON nebbia è protetto: lo si serve a un non-admin
   * solo se lo vede anche altrove, senza nebbia (immagine di un token visibile o mappa della
   * scena attiva senza nebbia di una sua campagna). Tutti gli altri asset: come prima.
   */
  assetAllowed(userId: string, assetId: string, url: string): boolean {
    const uses = (s: Scene) => s.map !== null && (s.map.assetId === assetId || s.map.url === url);
    let protectedAsset = false;
    for (const room of this.rooms.values()) {
      const st = room.core.state;
      if (st.scenes.some((s) => uses(s) && fogOf(st, s.id))) {
        protectedAsset = true;
        break;
      }
    }
    if (!protectedAsset) return true;
    for (const room of this.rooms.values()) {
      const st = room.core.state;
      const actor = resolveActor(st, userId);
      if (!actor) continue;
      const active = st.scenes.find((s) => s.id === st.activeSceneId);
      if (active && uses(active) && !fogOf(st, active.id)) return true;
      const tokenUses = st.tokens.some(
        (t) => t.imageUrl === url && canSeeToken(t, actor, st.activeSceneId, fogOf(st, t.sceneId)),
      );
      if (tokenUses) return true;
    }
    return false;
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
    const viewer = room ? viewerActor(room.core.state, peer.userId, peer.viewAs) : null;
    if (!room || !viewer || (!viewer.ok && viewer.reason === "not-member")) {
      // Campagna inesistente o utente non membro: stessa risposta.
      peer.send(errorMessage(null, "NOT_FOUND", "campagna non trovata"));
      peer.close(CLOSE.notFound, "campagna");
      return;
    }
    if (!viewer.ok) {
      // Vista come un altro utente (M9): solo il GM della campagna, e solo verso un suo membro.
      // Il messaggio è fisso: non dice se l'utente guardato esiste.
      if (peer.campaignId) this.rooms.get(peer.campaignId)?.peers.delete(peer);
      peer.actor = null;
      peer.send(errorMessage(null, "FORBIDDEN", "vista non consentita"));
      peer.close(CLOSE.permissionsChanged, "vista non consentita");
      return;
    }
    const actor = viewer.actor;
    if (peer.campaignId && peer.campaignId !== msg.campaignId) this.rooms.get(peer.campaignId)?.peers.delete(peer);
    peer.actor = actor;
    peer.campaignId = msg.campaignId;
    room.peers.add(peer);
    const { state, log } = room.core;
    peer.send(planResync(state, log, actor, { lastVersion: msg.lastVersion, epoch: msg.epoch }));
    peer.lastSent = state.version;
    // Poi le ultime voci di chat e tiri visibili, in coda: una voce salvata dopo arriva dopo.
    void this.enqueue(room, async () => {
      if (!peer.actor || !room.peers.has(peer)) return;
      const page = await loadPage(this.db, msg.campaignId, peer.actor, null, this.options.chat.historyOnConnect);
      if (page) peer.send({ type: "history", requestId: null, entries: page.entries, hasMore: page.hasMore });
    });
  }

  // -------------------------------------------------------------------------
  // Chat, tiri e cronologia (M4)
  // -------------------------------------------------------------------------

  private limitsOf(userId: string): UserLimits {
    let l = this.limits.get(userId);
    if (!l) {
      const c = this.options.chat;
      l = {
        chat: new TokenBucket(c.messagesPerMinute / 60, c.messageBurst),
        roll: new TokenBucket(c.rollsPerMinute / 60, c.rollBurst),
        ephemeral: new TokenBucket(this.options.ephemeral.perSecond, this.options.ephemeral.burst),
      };
      this.limits.set(userId, l);
    }
    return l;
  }

  /**
   * Connessione in sola lettura (M9: vista come un altro utente o finestra del proiettore): ogni
   * richiesta che cambierebbe qualcosa (comandi, annulla/ripeti, chat, tiri, iniziativa, effimeri)
   * riceve `FORBIDDEN` prima di guardare lo stato. Nulla viene mai inviato "come" il membro guardato.
   */
  private rejectReadOnly(peer: Peer, requestId: string): boolean {
    if (!peer.readOnly) return false;
    peer.send(errorMessage(requestId, "FORBIDDEN", "connessione in sola lettura"));
    return true;
  }

  /** Stanza della connessione dopo `hello`, oppure errore già inviato. `read`: richiesta di sola lettura. */
  private roomOf(peer: Peer, requestId: string, read = false): Room | null {
    if (!read && this.rejectReadOnly(peer, requestId)) return null;
    const room = peer.campaignId ? this.rooms.get(peer.campaignId) : undefined;
    if (!room || !peer.actor) {
      peer.send(errorMessage(requestId, "INVALID", "serve prima hello"));
      return null;
    }
    return room;
  }

  /** Messaggio di chat (pubblico o whisper). */
  chat(peer: Peer, msg: ChatSend): Promise<void> {
    return this.publish(peer, msg.requestId, "chat", (ctx) => buildChatEntry(ctx, msg));
  }

  /** Tiro: l'esito si calcola qui, con `this.rng` (crypto in produzione). Il client manda solo la formula. */
  roll(peer: Peer, msg: RollRequest): Promise<void> {
    return this.publish(peer, msg.requestId, "roll", (ctx) => buildRollEntry(ctx, msg, this.rng));
  }

  /**
   * Costruisce la voce con l'attore della connessione, la salva su SQLite e solo dopo la invia
   * a chi può vederla (`canSeeEntry`). Il `requestId` arriva solo alla connessione richiedente.
   */
  private publish(
    peer: Peer,
    requestId: string,
    kind: "chat" | "roll",
    build: (ctx: { state: CampaignCore["state"]; actor: Actor; id: string; now: number }) => Built<ChatLogEntry>,
  ): Promise<void> {
    const room = this.roomOf(peer, requestId);
    if (!room) return Promise.resolve();
    if (!this.limitsOf(peer.userId)[kind].take()) {
      peer.send(
        errorMessage(requestId, "RATE_LIMITED", kind === "chat" ? "troppi messaggi, riprova tra poco" : "troppi tiri, riprova tra poco"),
      );
      return Promise.resolve();
    }
    return this.enqueue(room, async () => {
      if (!peer.actor || !room.peers.has(peer)) return;
      const r = build({ state: room.core.state, actor: peer.actor, id: randomUUID(), now: Date.now() });
      if (!r.ok) {
        peer.send(entryError(requestId, r.error));
        return;
      }
      try {
        await insertEntry(this.db, room.core.state.campaignId, r.entry);
      } catch (err) {
        this.log.error({ err }, "salvataggio del log di sessione non riuscito");
        peer.send(errorMessage(requestId, "CONFLICT", "salvataggio non riuscito, riprova"));
        return;
      }
      const entry = r.entry;
      for (const p of room.peers) {
        if (!p.actor || !canSeeEntry(entry, p.actor)) continue;
        const rid = p === peer ? requestId : null;
        p.send(entry.kind === "message" ? { type: "chat.message", requestId: rid, entry } : { type: "roll.result", requestId: rid, entry });
      }
    });
  }

  /** Pagina di cronologia più vecchia di `before`, filtrata per l'utente. */
  history(peer: Peer, msg: HistoryRequest): Promise<void> {
    const room = this.roomOf(peer, msg.requestId, true);
    if (!room) return Promise.resolve();
    return this.enqueue(room, async () => {
      if (!peer.actor || !room.peers.has(peer)) return;
      const page = await loadPage(this.db, room.core.state.campaignId, peer.actor, msg.before, msg.limit ?? MAX_HISTORY_PAGE);
      if (!page) {
        peer.send(errorMessage(msg.requestId, "NOT_FOUND", "voce non trovata"));
        return;
      }
      peer.send({ type: "history", requestId: msg.requestId, entries: page.entries, hasMore: page.hasMore });
    });
  }

  /** Comando / annulla / ripeti, con l'attore della connessione (mai dati del client). */
  submit(peer: Peer, input: DispatchInput): Promise<void> {
    if (this.rejectReadOnly(peer, input.requestId)) return Promise.resolve();
    const room = peer.campaignId ? this.rooms.get(peer.campaignId) : undefined;
    if (!room || !peer.actor) {
      peer.send(errorMessage(input.requestId, "INVALID", "serve prima hello"));
      return Promise.resolve();
    }
    return this.enqueue(room, () => this.runInput(room, peer, input));
  }

  /** Applica un comando / annulla / ripeti DENTRO la coda della stanza: salva, poi invia i delta. */
  private async runInput(room: Room, peer: Peer, input: DispatchInput): Promise<void> {
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
      // Registro di gioco (solo GM): una voce per comando. Se la scrittura fallisce il comando resta valido.
      const lines = describeChanges(r.changes);
      if (lines.length > 0) {
        const actor = r.core.state.members.find((m) => m.userId === peer.actor!.userId)?.displayName ?? "Sconosciuto";
        try {
          await writeGameLog(this.db, r.core.state.campaignId, r.core.state.version, actor, lines);
        } catch (err) {
          this.log.error({ err }, "registro di gioco non salvato");
        }
      }
    }
    room.core = r.core;
    if (r.changes.length > 0) this.broadcast(room, r);
    peer.send(r.reply);
  }

  // -------------------------------------------------------------------------
  // Iniziativa tirata dal server (M7)
  // -------------------------------------------------------------------------

  /**
   * Tiro dell'iniziativa: solo il GM. L'esito lo decide il server (`this.rng`, `crypto.randomInt` in
   * produzione): d20 + bonus, con vantaggio/svantaggio. I valori entrano nello stato con un solo comando
   * `combat.setInitiative` (un'unica azione annullabile), che passa dal riduttore come ogni altro.
   */
  initiativeRoll(peer: Peer, msg: InitiativeRollRequest): Promise<void> {
    const room = this.roomOf(peer, msg.requestId);
    if (!room) return Promise.resolve();
    // Il permesso si controlla prima di guardare lo stato (e prima di consumare il limite).
    if (!isGm(peer.actor!)) {
      peer.send(errorMessage(msg.requestId, "FORBIDDEN", "azione riservata al GM"));
      return Promise.resolve();
    }
    if (!this.limitsOf(peer.userId).roll.take()) {
      peer.send(errorMessage(msg.requestId, "RATE_LIMITED", "troppi tiri, riprova tra poco"));
      return Promise.resolve();
    }
    return this.enqueue(room, async () => {
      const values = msg.rolls.map((r) => ({
        participantId: r.participantId,
        initiative: rollInitiative(this.rng, r.bonus, r.mode ?? "normal").total,
      }));
      await this.runInput(room, peer, {
        type: "command",
        requestId: msg.requestId,
        command: { type: "combat.setInitiative", sceneId: msg.sceneId, values, ...(msg.sort ? { sort: true } : {}) },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Misurazioni, frecce e ping effimeri (M7): mai salvati
  // -------------------------------------------------------------------------

  private pruneEphemerals(room: Room, now: number): void {
    for (const [key, e] of room.ephemerals) if (e.expiresAt <= now) room.ephemerals.delete(key);
  }

  /**
   * Mostra una forma effimera. Ogni destinatario riceve la forma ritagliata per la SUA nebbia (`shapeForViewer`):
   * chi non vede nulla di ciò che copre non riceve nemmeno il messaggio. `private` non invia nulla a nessuno.
   */
  ephemeralShow(peer: Peer, msg: EphemeralShow): void {
    const room = this.roomOf(peer, msg.requestId);
    if (!room) return;
    const actor = peer.actor!;
    if (!this.limitsOf(peer.userId).ephemeral.take()) {
      peer.send(errorMessage(msg.requestId, "RATE_LIMITED", "troppi messaggi, riprova tra poco"));
      return;
    }
    const state = room.core.state;
    const v = validateEphemeral(state, actor, msg);
    if (!v.ok) {
      peer.send(errorMessage(msg.requestId, v.error.code, v.error.message));
      return;
    }
    const ack = { type: "ack", requestId: msg.requestId, version: state.version } as const;
    if (msg.audience === "private") {
      // Le misure private restano sul client: nessun evento.
      peer.send(ack);
      return;
    }
    const now = Date.now();
    this.pruneEphemerals(room, now);
    const key = `${peer.userId}:${msg.id}`;
    const old = room.ephemerals.get(key);
    // Al massimo `MAX_LIVE_EPHEMERALS` forme vive per utente: oltre, si toglie la più vecchia.
    const mine = [...room.ephemerals.entries()].filter(([k, e]) => e.authorId === peer.userId && k !== key);
    if (mine.length >= MAX_LIVE_EPHEMERALS) {
      mine.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      const [oldKey, oldest] = mine[0]!;
      room.ephemerals.delete(oldKey);
      for (const p of oldest.recipients) p.send({ type: "ephemeral.cleared", id: oldest.id, authorId: oldest.authorId });
    }
    const ttlMs = msg.ttlMs ?? defaultTtlMs(msg.shape);
    const fog = fogOf(state, v.scene.id);
    const recipients = new Set<Peer>();
    for (const p of room.peers) {
      if (p === peer || !p.actor) continue;
      if (msg.audience === "gm" && !isGm(p.actor)) continue;
      if (!canSeeScene(v.scene, p.actor, state.activeSceneId)) continue;
      const shape = shapeForViewer(msg.shape, v.scene, fog, p.actor);
      if (!shape) continue;
      p.send({
        type: "ephemeral.shown",
        id: msg.id,
        authorId: peer.userId,
        sceneId: v.scene.id,
        ttlMs,
        shape,
        ...(msg.color ? { color: msg.color } : {}),
      });
      recipients.add(p);
    }
    // Chi aveva ricevuto la versione precedente e ora non riceve più nulla deve togliere la vecchia.
    if (old) for (const p of old.recipients) if (!recipients.has(p)) p.send({ type: "ephemeral.cleared", id: msg.id, authorId: peer.userId });
    room.ephemerals.set(key, { authorId: peer.userId, id: msg.id, expiresAt: now + ttlMs, recipients });
    peer.send(ack);
  }

  /** L'autore toglie una sua forma effimera: l'avviso va solo a chi l'aveva ricevuta. Idempotente. */
  ephemeralClear(peer: Peer, msg: EphemeralClear): void {
    const room = this.roomOf(peer, msg.requestId);
    if (!room) return;
    const key = `${peer.userId}:${msg.id}`;
    const live = room.ephemerals.get(key);
    if (live) {
      room.ephemerals.delete(key);
      for (const p of live.recipients) p.send({ type: "ephemeral.cleared", id: live.id, authorId: live.authorId });
    }
    peer.send({ type: "ack", requestId: msg.requestId, version: room.core.state.version });
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
      // Token senza più proprietario e maschere di nebbia di chi non è più giocatore.
      const { state, touchedTokenIds, touchedFogSceneIds } = withMembers(room.core.state, members);
      const epoch = randomUUID();
      await persistReset(this.db, state, epoch, touchedTokenIds, touchedFogSceneIds);
      room.core = { state, history: createHistory(), log: createEventLog(epoch, LOG_CAPACITY) };
      for (const p of [...room.peers]) {
        // Con `viewAs` (M9) si ricontrolla anche che chi guarda sia ancora GM e il guardato ancora membro.
        const viewer = viewerActor(state, p.userId, p.viewAs);
        const actor = viewer.ok ? viewer.actor : null;
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
