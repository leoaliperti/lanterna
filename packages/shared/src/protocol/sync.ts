import type { StateChange } from "../state/changes.js";
import { filterEventsFor } from "../state/filter.js";
import { createHistory, execute, redo, undo, type History } from "../state/history.js";
import type { Actor, CampaignState } from "../state/schema.js";
import { viewFor } from "../state/view.js";
import {
  PROTOCOL_VERSION,
  type DeltaMessage,
  type ErrorMessage,
  type ServerMessage,
  type SnapshotMessage,
} from "./messages.js";

/**
 * Sincronizzazione e riconnessione (logica pura, senza rete).
 *
 * Il server tiene un registro circolare degli ultimi cambiamenti interni
 * (`EventLog`), uno per versione. Alla (ri)connessione il client invia
 * `hello { lastVersion, epoch }` e il server risponde:
 * - `delta` con gli eventi filtrati da `lastVersion` a quella attuale, se il
 *   registro copre l'intervallo e l'epoca coincide;
 * - `snapshot` (vista completa filtrata) in tutti gli altri casi.
 */

export interface LogEntry {
  /** Versione raggiunta dopo questi cambiamenti. */
  version: number;
  changes: StateChange[];
}

export interface EventLog {
  /** Identifica la "linea" dello stato: cambia se lo stato riparte da un backup. */
  epoch: string;
  entries: LogEntry[];
  capacity: number;
}

export function createEventLog(epoch: string, capacity = 500): EventLog {
  return { epoch, entries: [], capacity };
}

export function appendToLog(log: EventLog, version: number, changes: StateChange[]): EventLog {
  const last = log.entries[log.entries.length - 1];
  // Versioni non consecutive: il registro non è più affidabile, si riparte da capo.
  const base = last && last.version + 1 !== version ? [] : log.entries;
  const entries = [...base, { version, changes }];
  return { ...log, entries: entries.length > log.capacity ? entries.slice(entries.length - log.capacity) : entries };
}

/** Snapshot completo filtrato per `viewer`. */
export function snapshotFor(state: CampaignState, viewer: Actor, epoch: string): SnapshotMessage {
  return { type: "snapshot", protocolVersion: PROTOCOL_VERSION, epoch, version: state.version, view: viewFor(state, viewer) };
}

/**
 * Delta filtrato per `viewer`. Restituisce `null` se il viewer non deve ricevere
 * nulla (il server allora non invia niente e non avanza la versione "inviata" a
 * quel client).
 */
export function deltaFor(
  viewer: Actor,
  epoch: string,
  fromVersion: number,
  toVersion: number,
  changes: readonly StateChange[],
): DeltaMessage | null {
  const events = filterEventsFor(changes, viewer);
  if (events.length === 0) return null;
  return { type: "delta", epoch, fromVersion, toVersion, events };
}

export interface ResyncRequest {
  lastVersion: number | null;
  epoch: string | null;
}

/** Oltre questo numero di eventi conviene uno snapshot. */
export const MAX_DELTA_EVENTS = 1000;

/** Decide la risposta a un `hello`: delta se possibile, altrimenti snapshot. */
export function planResync(state: CampaignState, log: EventLog, viewer: Actor, req: ResyncRequest): ServerMessage {
  const snapshot = (): SnapshotMessage => snapshotFor(state, viewer, log.epoch);
  const last = req.lastVersion;
  if (last === null || req.epoch !== log.epoch || last > state.version) return snapshot();
  if (last === state.version) {
    return { type: "delta", epoch: log.epoch, fromVersion: last, toVersion: last, events: [] };
  }
  const first = log.entries[0];
  const newest = log.entries[log.entries.length - 1];
  // Il registro deve coprire (last, state.version] senza buchi.
  if (!first || !newest || first.version > last + 1 || newest.version !== state.version) return snapshot();
  const needed = log.entries.filter((e) => e.version > last);
  const events = filterEventsFor(needed.flatMap((e) => e.changes), viewer);
  if (events.length > MAX_DELTA_EVENTS) return snapshot();
  return { type: "delta", epoch: log.epoch, fromVersion: last, toVersion: state.version, events };
}

// ---------------------------------------------------------------------------
// Nucleo di una campagna: stato + cronologia + registro
// ---------------------------------------------------------------------------

export interface CampaignCore {
  state: CampaignState;
  history: History;
  log: EventLog;
}

export function createCore(state: CampaignState, epoch: string): CampaignCore {
  return { state, history: createHistory(), log: createEventLog(epoch) };
}

export type DispatchInput =
  | { type: "command"; requestId: string; command: unknown }
  | { type: "undo"; requestId: string }
  | { type: "redo"; requestId: string };

export interface DispatchResult {
  core: CampaignCore;
  /** Risposta per chi ha inviato il comando (ack o errore). */
  reply: { type: "ack"; requestId: string; version: number } | ErrorMessage;
  /** Cambiamenti interni da filtrare con `deltaFor` per ogni client connesso. */
  changes: StateChange[];
  fromVersion: number;
  toVersion: number;
}

/**
 * Applica un comando / annulla / ripeti a nome di `actor`.
 * Il server poi invia `deltaFor(...)` a ogni client (incluso il mittente, prima dell'ack).
 */
export function dispatch(core: CampaignCore, actor: Actor, input: DispatchInput): DispatchResult {
  const r =
    input.type === "command"
      ? execute(core.state, core.history, input.command, actor)
      : input.type === "undo"
        ? undo(core.state, core.history, actor)
        : redo(core.state, core.history, actor);
  const fromVersion = core.state.version;
  if (!r.ok) {
    return {
      core,
      reply: { type: "error", requestId: input.requestId, code: r.error.code, message: r.error.message },
      changes: [],
      fromVersion,
      toVersion: fromVersion,
    };
  }
  const log = r.changes.length > 0 ? appendToLog(core.log, r.state.version, r.changes) : core.log;
  return {
    core: { state: r.state, history: r.history, log },
    reply: { type: "ack", requestId: input.requestId, version: r.state.version },
    changes: r.changes,
    fromVersion,
    toVersion: r.state.version,
  };
}
