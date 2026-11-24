import type { StateChange } from "./changes.js";
import type { Command } from "./commands.js";
import { err, MESSAGES, type CommandError } from "./errors.js";
import { deepEqual } from "./filter.js";
import { applyCommand, applyCommands } from "./reducer.js";
import type { Actor, CampaignState, Scene, Token } from "./schema.js";
import { canSeeToken, isGm } from "./view.js";
import { DEFAULT_CLOCK, combatOf, fogOf } from "./schema.js";
import type { Wall } from "./walls.js";

/**
 * Annulla/ripeti per utente, come logica pura sopra il riduttore.
 *
 * - Ogni azione riuscita registra i comandi applicati (`forward`) e il loro inverso.
 * - Un giocatore annulla/ripete solo le PROPRIE azioni; il GM qualsiasi azione.
 * - Annullare applica l'inverso con i permessi di chi annulla: se nel frattempo
 *   il giocatore ha perso il token (o è stato nascosto) l'annullamento fallisce.
 * - Prima di annullare si controlla che i campi toccati siano ancora come li
 *   aveva lasciati l'azione (`expect`): se qualcun altro li ha cambiati => CONFLICT.
 * - Una nuova azione di un utente cancella i "ripeti" disponibili per quell'utente.
 */

export interface HistoryEntry {
  id: number;
  /** Autore dell'azione originale. */
  actorUserId: string;
  forward: Command[];
  inverse: Command[];
  /** Cambiamenti prodotti dall'ultima applicazione (forward o inverse): servono a rilevare conflitti. */
  expect: StateChange[];
  status: "done" | "undone";
  /** Chi l'ha annullata (solo con status "undone"). */
  undoneBy: string | null;
  /** Ordine dell'ultimo cambio di stato: determina quale voce annullare/ripetere per prima. */
  seq: number;
}

export interface History {
  entries: HistoryEntry[];
  nextId: number;
  nextSeq: number;
  limit: number;
}

export function createHistory(limit = 200): History {
  return { entries: [], nextId: 1, nextSeq: 1, limit };
}

export type HistoryResult =
  | { ok: true; state: CampaignState; history: History; changes: StateChange[] }
  | { ok: false; error: CommandError };

/**
 * Esegue un comando e, se cambia lo stato, lo registra nella cronologia.
 * È il punto d'ingresso consigliato per il server.
 */
export function execute(
  state: CampaignState,
  history: History,
  command: unknown,
  actor: Actor,
): HistoryResult {
  const r = applyCommand(state, command, actor);
  if (!r.ok) return r;
  if (r.changes.length === 0) return { ok: true, state, history, changes: [] };
  // `applyCommand` ha già validato: il comando è un `Command`.
  return { ok: true, state: r.state, history: record(history, actor, [command as Command], r.inverse, r.changes), changes: r.changes };
}

export function record(
  history: History,
  actor: Actor,
  forward: Command[],
  inverse: Command[],
  expect: StateChange[],
): History {
  // Una nuova azione cancella i "ripeti" di chi la compie.
  let entries = history.entries.filter((e) => !(e.status === "undone" && e.undoneBy === actor.userId));
  entries = [
    ...entries,
    {
      id: history.nextId,
      actorUserId: actor.userId,
      forward,
      inverse,
      expect,
      status: "done",
      undoneBy: null,
      seq: history.nextSeq,
    },
  ];
  if (entries.length > history.limit) entries = entries.slice(entries.length - history.limit);
  return { ...history, entries, nextId: history.nextId + 1, nextSeq: history.nextSeq + 1 };
}

function latest(entries: HistoryEntry[], pred: (e: HistoryEntry) => boolean): HistoryEntry | undefined {
  let best: HistoryEntry | undefined;
  for (const e of entries) if (pred(e) && (!best || e.seq > best.seq)) best = e;
  return best;
}

function changedKeys<T extends object>(before: T | null, after: T | null): (keyof T)[] {
  if (!before || !after) return [];
  return (Object.keys(after) as (keyof T)[]).filter((k) => !deepEqual(before[k], after[k]));
}

/**
 * Lo stato attuale è ancora quello lasciato dai cambiamenti `expect`?
 * Per un giocatore i token che non può vedere risultano NOT_FOUND (mai CONFLICT),
 * così il controllo non rivela nulla.
 */
function checkExpect(state: CampaignState, expect: StateChange[], actor: Actor): CommandError | null {
  for (const c of expect) {
    if (c.type === "notice") continue;
    if (c.type === "combat") {
      // Cambiamento solo di visibilità (il combattimento non è cambiato): non dice nulla su cosa ha lasciato l'azione.
      if (deepEqual(c.before, c.after)) continue;
      if (!deepEqual(combatOf(state, c.sceneId), c.after)) return { code: "CONFLICT", message: MESSAGES.stale };
    } else if (c.type === "group") {
      const id = (c.after ?? c.before)?.id;
      const cur = (state.groups ?? []).find((g) => g.id === id) ?? null;
      if (!deepEqual(cur, c.after)) return { code: "CONFLICT", message: MESSAGES.stale };
    } else if (c.type === "token") {
      const id = (c.after ?? c.before)?.id;
      if (!id) continue;
      const cur: Token | undefined = state.tokens.find((t) => t.id === id);
      if (cur && !canSeeToken(cur, actor, state.activeSceneId, fogOf(state, cur.sceneId))) {
        return { code: "NOT_FOUND", message: MESSAGES.tokenNotFound };
      }
      if (c.after === null) {
        if (cur) return { code: "CONFLICT", message: MESSAGES.stale };
        continue;
      }
      if (!cur) return { code: isGm(actor) ? "CONFLICT" : "NOT_FOUND", message: isGm(actor) ? MESSAGES.stale : MESSAGES.tokenNotFound };
      const keys = c.before === null ? [] : changedKeys(c.before, c.after);
      if (keys.some((k) => !deepEqual(cur[k], c.after?.[k]))) return { code: "CONFLICT", message: MESSAGES.stale };
    } else if (c.type === "scene") {
      const id = (c.after ?? c.before)?.id;
      const cur: Scene | undefined = state.scenes.find((s) => s.id === id);
      if (c.after === null) {
        if (cur) return { code: "CONFLICT", message: MESSAGES.stale };
        continue;
      }
      if (!cur) return { code: "CONFLICT", message: MESSAGES.stale };
      const keys = c.before === null ? [] : changedKeys(c.before, c.after);
      if (keys.some((k) => !deepEqual(cur[k], c.after?.[k]))) return { code: "CONFLICT", message: MESSAGES.stale };
    } else if (c.type === "wall") {
      const id = (c.after ?? c.before)?.id;
      const cur: Wall | undefined = (state.walls ?? []).find((w) => w.id === id);
      if (c.after === null) {
        if (cur) return { code: "CONFLICT", message: MESSAGES.stale };
        continue;
      }
      if (!cur) return { code: "CONFLICT", message: MESSAGES.stale };
      const keys = c.before === null ? [] : changedKeys(c.before, c.after);
      if (keys.some((k) => !deepEqual(cur[k], c.after?.[k]))) return { code: "CONFLICT", message: MESSAGES.stale };
    } else if (c.type === "fog") {
      // La nebbia è un oggetto unico: deve essere esattamente quella lasciata dall'azione.
      if (!deepEqual(fogOf(state, c.sceneId), c.after)) return { code: "CONFLICT", message: MESSAGES.stale };
    } else if (c.type === "clock") {
      // L'orologio deve essere ancora quello lasciato dall'azione (o quello di default, se non è mai stato impostato).
      if (!deepEqual(state.clock ?? DEFAULT_CLOCK, c.after)) return { code: "CONFLICT", message: MESSAGES.stale };
    } else if (state.activeSceneId !== c.after) {
      return { code: "CONFLICT", message: MESSAGES.stale };
    }
  }
  return null;
}

function replaceEntry(history: History, entry: HistoryEntry): History {
  return {
    ...history,
    entries: history.entries.map((e) => (e.id === entry.id ? entry : e)),
    nextSeq: history.nextSeq + 1,
  };
}

/** Il giocatore può agire solo sulle proprie voci; il GM su tutte. */
function mayTouch(entry: HistoryEntry, actor: Actor): boolean {
  return isGm(actor) || entry.actorUserId === actor.userId;
}

/**
 * Annulla l'ultima azione annullabile da `actor` (o quella con id `entryId`).
 * Giocatore: la sua ultima azione. GM: l'ultima azione di chiunque.
 */
export function undo(
  state: CampaignState,
  history: History,
  actor: Actor,
  entryId?: number,
): HistoryResult {
  const entry =
    entryId === undefined
      ? latest(history.entries, (e) => e.status === "done" && mayTouch(e, actor))
      : history.entries.find((e) => e.id === entryId && e.status === "done" && mayTouch(e, actor));
  if (!entry) return err("NOT_FOUND", MESSAGES.nothingToUndo);
  const conflict = checkExpect(state, entry.expect, actor);
  if (conflict) return { ok: false, error: conflict };
  const r = applyCommands(state, entry.inverse, actor);
  if (!r.ok) return r;
  const next: HistoryEntry = {
    ...entry,
    expect: r.changes,
    status: "undone",
    undoneBy: actor.userId,
    seq: history.nextSeq,
  };
  return { ok: true, state: r.state, history: replaceEntry(history, next), changes: r.changes };
}

/** Ripete l'ultima azione annullata da `actor`. */
export function redo(state: CampaignState, history: History, actor: Actor): HistoryResult {
  const entry = latest(history.entries, (e) => e.status === "undone" && e.undoneBy === actor.userId);
  if (!entry || !mayTouch(entry, actor)) return err("NOT_FOUND", MESSAGES.nothingToRedo);
  const conflict = checkExpect(state, entry.expect, actor);
  if (conflict) return { ok: false, error: conflict };
  const r = applyCommands(state, entry.forward, actor);
  if (!r.ok) return r;
  const next: HistoryEntry = {
    ...entry,
    inverse: r.inverse,
    expect: r.changes,
    status: "done",
    undoneBy: null,
    seq: history.nextSeq,
  };
  return { ok: true, state: r.state, history: replaceEntry(history, next), changes: r.changes };
}
