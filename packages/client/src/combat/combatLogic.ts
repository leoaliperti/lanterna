import { LIMITS, type CampaignView, type Command, type CombatView, type InitiativeMode, type ParticipantView, type TokenView } from "@lanterna/shared";
import type { InitiativeRollOptions } from "../realtime/RealtimeClient";

/**
 * Logica pura del tracker dell'iniziativa: nessun React, nessun DOM. La UI chiama queste funzioni e invia i
 * comandi; il server decide (tiro compreso) e rimanda il combattimento gia' filtrato per l'utente.
 */

export function combatOf(view: CampaignView, sceneId: string | null): CombatView | null {
  if (!sceneId) return null;
  return view.combats?.find((c) => c.sceneId === sceneId) ?? null;
}

/** Token della scena che non sono ancora nel combattimento. */
export function tokensToAdd(tokens: readonly TokenView[], sceneId: string, combat: CombatView | null): TokenView[] {
  const taken = new Set(combat?.participants.flatMap((p) => (p.tokenId ? [p.tokenId] : [])) ?? []);
  return tokens.filter((t) => t.sceneId === sceneId && !taken.has(t.id));
}

export function addTokenCommand(id: string, sceneId: string, tokenId: string, initiative: number | null = null): Command {
  return { type: "combat.add", sceneId, participant: { id, tokenId, name: null, initiative, hidden: false, hideInitiative: false } };
}

/** Voce libera (trappola, evento). `hidden`: nasce gia' nascosta ai giocatori, senza un istante in cui la vedono. */
export function addEntryCommand(id: string, sceneId: string, name: string, initiative: number | null, hidden = false): Command | null {
  const clean = name.trim();
  if (!clean || clean.length > LIMITS.nameMaxLength) return null;
  return { type: "combat.add", sceneId, participant: { id, tokenId: null, name: clean, initiative, hidden, hideInitiative: false } };
}

/**
 * Valore di iniziativa scritto a mano. Vuoto = nessun valore (`null`), un numero tra i limiti = valore,
 * altro = `"invalid"`. Accetta la virgola decimale.
 */
export function parseInitiative(text: string): number | null | "invalid" {
  const t = text.trim().replace(",", ".");
  if (t === "") return null;
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return "invalid";
  const n = Number(t);
  return n >= LIMITS.initiativeMin && n <= LIMITS.initiativeMax ? n : "invalid";
}

export function formatInitiative(n: number | null): string {
  if (n === null) return "";
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}

export function setInitiativeCommand(sceneId: string, participantId: string, initiative: number): Command {
  return { type: "combat.setInitiative", sceneId, values: [{ participantId, initiative }] };
}

export function clearInitiativeCommand(sceneId: string, participantId: string): Command {
  return { type: "combat.update", sceneId, participantId, patch: { initiative: null } };
}

export function reorderCommand(sceneId: string, participantId: string, toIndex: number): Command {
  return { type: "combat.reorder", sceneId, participantId, toIndex };
}

/** Nuova posizione dopo uno spostamento di `delta` posti (tastiera), `null` se non cambia nulla. */
export function movedIndex(index: number, delta: number, length: number): number | null {
  const to = Math.max(0, Math.min(length - 1, index + delta));
  return to === index ? null : to;
}

/**
 * Posizione di rilascio durante il trascinamento: `rows` sono i rettangoli (top, altezza) delle righe nell'ordine
 * attuale; il puntatore a `y` decide in quale riga cade (prima della prima = 0, dopo l'ultima = ultima).
 */
export function dropIndex(rows: ReadonlyArray<{ top: number; height: number }>, y: number): number {
  if (rows.length === 0) return 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (y < r.top + r.height) return i;
  }
  return rows.length - 1;
}

/** Ordine mostrato durante il trascinamento (anteprima): sposta `from` in `to` senza modificare l'originale. */
export function previewOrder<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(to, 0, moved);
  return next;
}

export interface RollChoice {
  bonus: number;
  mode: InitiativeMode;
}

/** Richiesta di tiro per i partecipanti scelti; il bonus e la modalita' valgono per tutti. */
export function rollRequest(sceneId: string, participantIds: readonly string[], choice: RollChoice, sort: boolean): InitiativeRollOptions | null {
  if (participantIds.length === 0) return null;
  return {
    sceneId,
    rolls: participantIds.map((participantId) => ({ participantId, bonus: choice.bonus, ...(choice.mode !== "normal" ? { mode: choice.mode } : {}) })),
    ...(sort ? { sort: true } : {})
  };
}

/** Bonus scritto a mano: intero tra -50 e 50 (vuoto = 0). */
export function parseBonus(text: string): number | "invalid" {
  const t = text.trim();
  if (t === "") return 0;
  if (!/^[+-]?\d+$/.test(t)) return "invalid";
  const n = Number(t);
  return n >= -50 && n <= 50 ? n : "invalid";
}

export function turnParticipant(combat: CombatView | null): ParticipantView | null {
  if (!combat?.started || !combat.turnId) return null;
  return combat.participants.find((p) => p.id === combat.turnId) ?? null;
}

/** Riga di stato del tracker, ad esempio "Round 3, turno di Aldo". */
export function statusLine(combat: CombatView | null): string {
  if (!combat) return "Nessun combattimento";
  if (!combat.started) return combat.participants.length === 0 ? "Nessun partecipante" : "Non ancora iniziato";
  const turn = turnParticipant(combat);
  return turn ? `Round ${combat.round}, turno di ${turn.name}` : `Round ${combat.round}`;
}

/** Chi ha ancora bisogno di un tiro (senza valore di iniziativa). */
export function withoutInitiative(combat: CombatView | null): ParticipantView[] {
  return combat?.participants.filter((p) => p.initiative === null) ?? [];
}

/** Il token del partecipante di turno (per la mappa), se il giocatore lo conosce. */
export function turnTokenId(combat: CombatView | null): string | null {
  return turnParticipant(combat)?.tokenId ?? null;
}
