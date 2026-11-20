import { z } from "zod";
import type { DiceErrorCode } from "../dice/types.js";
import { IdSchema } from "../state/schema.js";

/**
 * Chat, tiri di dado e cronologia (M4). Il server calcola l'esito dei tiri con
 * `crypto.randomInt` e invia ogni voce solo a chi può vederla (`canSeeEntry`).
 * Documentazione completa in `docs/PROTOCOL.md`, sezione "Chat e dadi".
 */

/** Lunghezza massima del testo di un messaggio di chat, dopo la sanificazione. */
export const MAX_CHAT_TEXT_LENGTH = 2000;
/** Lunghezza massima dell'etichetta di un tiro (es. "Attacco con spada"). */
export const MAX_ROLL_LABEL_LENGTH = 100;
/** Lunghezza massima della formula accettata dal protocollo (il parser poi applica i suoi limiti, più stretti). */
export const MAX_ROLL_FORMULA_INPUT = 1000;
/** Voci massime per pagina di cronologia. */
export const MAX_HISTORY_PAGE = 100;

/** Codici del parser dei dadi, inviati in `error.reason` per una formula non valida. */
export const DiceErrorCodeSchema = z.enum([
  "FORMULA_VUOTA",
  "FORMULA_TROPPO_LUNGA",
  "CARATTERE_NON_VALIDO",
  "SINTASSI_NON_VALIDA",
  "DADI_FUORI_LIMITE",
  "TROPPI_DADI",
  "TROPPI_TERMINI",
  "COSTANTE_FUORI_LIMITE",
  "KEEP_NON_VALIDO",
  "VANTAGGIO_NON_APPLICABILE",
  "VANTAGGIO_CONFLITTO",
]);
// Controllo a tempo di compilazione: l'enum e il tipo del parser devono coincidere.
type _SameCodes = [DiceErrorCode] extends [z.infer<typeof DiceErrorCodeSchema>]
  ? [z.infer<typeof DiceErrorCodeSchema>] extends [DiceErrorCode]
    ? true
    : never
  : never;
const _sameCodes: _SameCodes = true;
void _sameCodes;

/**
 * Visibilità di una voce:
 * - `public`: tutti i membri;
 * - `gm`: solo i GM (solo un GM può tirare con questa visibilità);
 * - `whisper`: solo autore e destinatario (`whisperTo`). Un giocatore può sussurrare solo a un GM.
 */
export const EntryVisibilitySchema = z.enum(["public", "gm", "whisper"]);
export type EntryVisibility = z.infer<typeof EntryVisibilitySchema>;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** Messaggio di chat. Testo semplice: mai interpretato come HTML. */
export const ChatSendSchema = z.strictObject({
  type: z.literal("chat.send"),
  requestId: IdSchema,
  text: z.string().min(1).max(MAX_CHAT_TEXT_LENGTH),
  /** Destinatario del whisper (userId); assente = messaggio pubblico. */
  whisperTo: IdSchema.optional(),
});
export type ChatSend = z.infer<typeof ChatSendSchema>;

/** Richiesta di tiro: il client manda solo la formula, mai un esito. */
export const RollRequestSchema = z.strictObject({
  type: z.literal("roll.request"),
  requestId: IdSchema,
  formula: z.string().max(MAX_ROLL_FORMULA_INPUT),
  visibility: EntryVisibilitySchema,
  /** Obbligatorio con `visibility: "whisper"`, vietato altrimenti. */
  whisperTo: IdSchema.optional(),
  label: z.string().max(MAX_ROLL_LABEL_LENGTH).optional(),
});
export type RollRequest = z.infer<typeof RollRequestSchema>;

/** Pagina di cronologia più vecchia della voce `before` (id), o le ultime se `before` è null. */
export const HistoryRequestSchema = z.strictObject({
  type: z.literal("history.request"),
  requestId: IdSchema,
  before: IdSchema.nullable(),
  limit: z.number().int().min(1).max(MAX_HISTORY_PAGE).optional(),
});
export type HistoryRequest = z.infer<typeof HistoryRequestSchema>;

// ---------------------------------------------------------------------------
// Voci del log (chat e tiri)
// ---------------------------------------------------------------------------

const EntryBase = {
  id: IdSchema,
  authorId: IdSchema,
  /** Nome visualizzato dell'autore al momento dell'invio. */
  authorName: z.string().max(64),
  /** Millisecondi dall'epoca Unix (orologio del server). */
  at: z.number().int().min(0),
  visibility: EntryVisibilitySchema,
  /** Destinatario se `visibility` è `whisper`, altrimenti null. */
  whisperTo: IdSchema.nullable(),
};

export const ChatEntrySchema = z.strictObject({
  kind: z.literal("message"),
  ...EntryBase,
  text: z.string().max(MAX_CHAT_TEXT_LENGTH),
});
export type ChatEntry = z.infer<typeof ChatEntrySchema>;

const DieResultSchema = z.strictObject({
  face: z.number().int().min(2),
  value: z.number().int().min(1),
  kept: z.boolean(),
});

const KeepSchema = z.strictObject({ mode: z.enum(["highest", "lowest"]), count: z.number().int().min(1) });
const SignSchema = z.union([z.literal(1), z.literal(-1)]);

export const RollTermResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("dice"),
    sign: SignSchema,
    count: z.number().int().min(1),
    sides: z.number().int().min(2),
    keep: KeepSchema.optional(),
    dice: z.array(DieResultSchema),
    signedValue: z.number().int(),
  }),
  z.strictObject({
    kind: z.literal("constant"),
    sign: SignSchema,
    value: z.number().int().min(0),
    signedValue: z.number().int(),
  }),
]);

export const RollEntrySchema = z.strictObject({
  kind: z.literal("roll"),
  ...EntryBase,
  label: z.string().max(MAX_ROLL_LABEL_LENGTH).nullable(),
  /** Formula in forma canonica (`2d6+3`, `1d20 adv`). */
  formula: z.string(),
  advantage: z.enum(["normal", "advantage", "disadvantage"]),
  /** Termini con i dadi usciti (per l'animazione: `face` = facce del dado, `value` = esito). */
  terms: z.array(RollTermResultSchema),
  total: z.number().int(),
  /** Testo leggibile, es. `2d6+3 → [4, 5] + 3 = 12`. */
  detail: z.string(),
  critical: z.boolean(),
  criticalFailure: z.boolean(),
});
export type RollEntry = z.infer<typeof RollEntrySchema>;

export const LogEntrySchema = z.discriminatedUnion("kind", [ChatEntrySchema, RollEntrySchema]);
/** Voce del log di sessione (chat o tiro). Nome distinto da `LogEntry` del registro dei delta. */
export type ChatLogEntry = z.infer<typeof LogEntrySchema>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Nuovo messaggio di chat. `requestId` è valorizzato solo sulla connessione che l'ha inviato. */
export const ChatMessageSchema = z.strictObject({
  type: z.literal("chat.message"),
  requestId: IdSchema.nullable(),
  entry: ChatEntrySchema,
});

/** Esito di un tiro calcolato sul server. `requestId` solo sulla connessione che l'ha chiesto. */
export const RollResultSchema = z.strictObject({
  type: z.literal("roll.result"),
  requestId: IdSchema.nullable(),
  entry: RollEntrySchema,
});

/**
 * Pagina di cronologia, già filtrata per l'utente, in ordine cronologico (dalla più vecchia).
 * Inviata con `requestId: null` dopo ogni `hello` (ultime voci) e in risposta a `history.request`.
 */
export const HistoryMessageSchema = z.strictObject({
  type: z.literal("history"),
  requestId: IdSchema.nullable(),
  entries: z.array(LogEntrySchema),
  /** Esistono voci più vecchie visibili: chiederle con `before` = id della prima voce. */
  hasMore: z.boolean(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

// ---------------------------------------------------------------------------
// Regole condivise
// ---------------------------------------------------------------------------

/** Chi può vedere una voce. Unica regola, usata dal server per invio live, cronologia ed esportazione. */
export function canSeeEntry(
  entry: Pick<ChatLogEntry, "visibility" | "authorId" | "whisperTo">,
  viewer: { userId: string; role: "admin" | "player" },
): boolean {
  switch (entry.visibility) {
    case "public":
      return true;
    case "gm":
      return viewer.role === "admin";
    case "whisper":
      return entry.authorId === viewer.userId || entry.whisperTo === viewer.userId;
  }
}

// Caratteri di controllo (tranne \t e \n), C1, a capo Unicode, override/isolamento bidirezionali,
// spazi a larghezza zero e BOM. ZWJ/ZWNJ (U+200C/D) restano: servono a emoji e scritture.
// eslint-disable-next-line no-control-regex
const STRIPPED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/g;
// Surrogati UTF-16 isolati (JSON.parse li accetta): non sono testo valido.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Sanifica il testo di chat: è testo semplice, non HTML. Non si fa escaping (il client deve
 * mostrarlo come testo, es. `textContent` o nodi di testo React, mai `innerHTML`); si tolgono
 * caratteri di controllo e di direzione (spoofing), surrogati isolati, si normalizzano gli a capo
 * (al massimo una riga vuota di fila) e gli spazi ai bordi. Il risultato può essere vuoto.
 */
export function sanitizeChatText(raw: string): string {
  return raw
    .replace(LONE_SURROGATE, "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(STRIPPED, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Come `sanitizeChatText`, ma su una sola riga (etichette dei tiri). */
export function sanitizeLabel(raw: string): string {
  return sanitizeChatText(raw.replace(/[\r\n\t]+/g, " ")).replace(/ {2,}/g, " ");
}
