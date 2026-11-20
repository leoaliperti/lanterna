import {
  MAX_CHAT_TEXT_LENGTH,
  parseFormula,
  roll,
  sanitizeChatText,
  sanitizeLabel,
  type Actor,
  type CampaignState,
  type ChatEntry,
  type ChatSend,
  type DiceErrorCode,
  type ErrorCode,
  type RandomInt,
  type RollEntry,
  type RollRequest,
} from "@lanterna/shared";

/**
 * Costruzione delle voci di chat e dei tiri a partire da una richiesta del client.
 * Logica pura (niente rete né database): permessi, sanificazione e tiro con l'RNG iniettato.
 * L'esito di un tiro viene SOLO da `randomInt` (in produzione `crypto.randomInt`).
 */

export interface EntryError {
  code: ErrorCode;
  message: string;
  reason?: DiceErrorCode;
}

export type Built<T> = { ok: true; entry: T } | { ok: false; error: EntryError };

/** Messaggi d'errore fissi (non contengono id né dati). */
export const CHAT_MESSAGES = {
  empty: "messaggio vuoto",
  recipientNotFound: "destinatario non trovato",
  selfWhisper: "non puoi sussurrare a te stesso",
  playerWhisper: "i giocatori possono sussurrare solo al GM",
  gmOnlyRoll: "solo il GM può fare tiri segreti",
  missingRecipient: "manca il destinatario del sussurro",
  unexpectedRecipient: "il destinatario si indica solo con visibilità whisper",
  rollFailed: "tiro non riuscito",
} as const;

const fail = (code: ErrorCode, message: string, reason?: DiceErrorCode): { ok: false; error: EntryError } => ({
  ok: false,
  error: reason ? { code, message, reason } : { code, message },
});

interface Context {
  state: CampaignState;
  actor: Actor;
  id: string;
  now: number;
}

/** Destinatario di un whisper: membro della campagna, non se stessi; il giocatore solo verso un GM. */
function checkRecipient(ctx: Context, to: string): EntryError | null {
  const target = ctx.state.members.find((m) => m.userId === to);
  if (!target) return { code: "NOT_FOUND", message: CHAT_MESSAGES.recipientNotFound };
  if (to === ctx.actor.userId) return { code: "INVALID", message: CHAT_MESSAGES.selfWhisper };
  if (ctx.actor.role !== "admin" && target.role !== "admin") {
    return { code: "FORBIDDEN", message: CHAT_MESSAGES.playerWhisper };
  }
  return null;
}

function authorName(ctx: Context): string {
  return ctx.state.members.find((m) => m.userId === ctx.actor.userId)?.displayName ?? "?";
}

export function buildChatEntry(ctx: Context, msg: ChatSend): Built<ChatEntry> {
  if (msg.whisperTo !== undefined) {
    const e = checkRecipient(ctx, msg.whisperTo);
    if (e) return { ok: false, error: e };
  }
  const text = sanitizeChatText(msg.text).slice(0, MAX_CHAT_TEXT_LENGTH);
  if (text.length === 0) return fail("INVALID", CHAT_MESSAGES.empty);
  return {
    ok: true,
    entry: {
      kind: "message",
      id: ctx.id,
      authorId: ctx.actor.userId,
      authorName: authorName(ctx),
      at: ctx.now,
      visibility: msg.whisperTo === undefined ? "public" : "whisper",
      whisperTo: msg.whisperTo ?? null,
      text,
    },
  };
}

/**
 * Ordine dei controlli: permesso sulla visibilità (FORBIDDEN prima di tutto) → destinatario →
 * formula (errore con il messaggio italiano del parser e il suo codice in `reason`) → tiro.
 */
export function buildRollEntry(ctx: Context, msg: RollRequest, randomInt: RandomInt): Built<RollEntry> {
  if (msg.visibility === "gm" && ctx.actor.role !== "admin") return fail("FORBIDDEN", CHAT_MESSAGES.gmOnlyRoll);
  if (msg.visibility === "whisper") {
    if (msg.whisperTo === undefined) return fail("INVALID", CHAT_MESSAGES.missingRecipient);
    const e = checkRecipient(ctx, msg.whisperTo);
    if (e) return { ok: false, error: e };
  } else if (msg.whisperTo !== undefined) {
    return fail("INVALID", CHAT_MESSAGES.unexpectedRecipient);
  }
  const parsed = parseFormula(msg.formula);
  if (!parsed.ok) return fail("INVALID", parsed.error.message, parsed.error.code);
  let result;
  try {
    result = roll(parsed.formula, randomInt);
  } catch {
    return fail("INVALID", CHAT_MESSAGES.rollFailed);
  }
  const label = msg.label === undefined ? "" : sanitizeLabel(msg.label);
  return {
    ok: true,
    entry: {
      kind: "roll",
      id: ctx.id,
      authorId: ctx.actor.userId,
      authorName: authorName(ctx),
      at: ctx.now,
      visibility: msg.visibility,
      whisperTo: msg.visibility === "whisper" ? (msg.whisperTo ?? null) : null,
      label: label.length > 0 ? label : null,
      formula: result.formula,
      advantage: result.advantage,
      terms: result.terms,
      total: result.total,
      detail: result.detail,
      critical: result.critical,
      criticalFailure: result.criticalFailure,
    },
  };
}
