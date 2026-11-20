import { z } from "zod";
import { CommandSchema } from "../state/commands.js";
import { ErrorCodeSchema } from "../state/errors.js";
import { ServerEventSchema } from "../state/filter.js";
import { IdSchema } from "../state/schema.js";
import { CampaignViewSchema } from "../state/view.js";
import {
  ChatMessageSchema,
  ChatSendSchema,
  DiceErrorCodeSchema,
  HistoryMessageSchema,
  HistoryRequestSchema,
  RollRequestSchema,
  RollResultSchema,
} from "./chat.js";
import {
  EphemeralClearSchema,
  EphemeralClearedSchema,
  EphemeralShowSchema,
  EphemeralShownSchema,
  InitiativeRollSchema,
} from "./ephemeral.js";

/**
 * Protocollo WebSocket di Lanterna, versione 1. Messaggi JSON, uno per frame.
 * Documentazione completa in `docs/PROTOCOL.md`.
 */
export const PROTOCOL_VERSION = 1;

/** Dimensione massima di un messaggio client (byte UTF-8 / caratteri). */
export const MAX_CLIENT_MESSAGE_SIZE = 64 * 1024;

export const RequestIdSchema = IdSchema;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** Primo messaggio dopo l'apertura del socket (e a ogni riconnessione). */
export const HelloSchema = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.number().int(),
  campaignId: IdSchema,
  /** Ultima versione vista dal client, `null` alla prima connessione. */
  lastVersion: z.number().int().min(0).nullable(),
  /** Epoca dello stato vista dal client (cambia se il server riparte da un backup). */
  epoch: z.string().max(64).nullable(),
});

export const CommandMessageSchema = z.strictObject({
  type: z.literal("command"),
  requestId: RequestIdSchema,
  command: CommandSchema,
});

export const UndoMessageSchema = z.strictObject({
  type: z.literal("undo"),
  requestId: RequestIdSchema,
});

export const RedoMessageSchema = z.strictObject({
  type: z.literal("redo"),
  requestId: RequestIdSchema,
});

export const PingSchema = z.strictObject({ type: z.literal("ping") });

export const ClientMessageSchema = z.discriminatedUnion("type", [
  HelloSchema,
  CommandMessageSchema,
  UndoMessageSchema,
  RedoMessageSchema,
  ChatSendSchema,
  RollRequestSchema,
  HistoryRequestSchema,
  EphemeralShowSchema,
  EphemeralClearSchema,
  InitiativeRollSchema,
  PingSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Stato completo già filtrato per l'utente (`viewFor`). */
export const SnapshotMessageSchema = z.strictObject({
  type: z.literal("snapshot"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  epoch: z.string(),
  version: z.number().int().min(0),
  view: CampaignViewSchema,
});

/**
 * Modifiche dalla versione `fromVersion` (esclusa) a `toVersion` (inclusa),
 * già filtrate per l'utente. Il client le applica solo se `fromVersion`
 * coincide con la sua versione; altrimenti si riconnette con `hello`.
 */
export const DeltaMessageSchema = z.strictObject({
  type: z.literal("delta"),
  epoch: z.string(),
  fromVersion: z.number().int().min(0),
  toVersion: z.number().int().min(0),
  events: z.array(ServerEventSchema),
});

export const AckMessageSchema = z.strictObject({
  type: z.literal("ack"),
  requestId: RequestIdSchema,
  /** Versione dello stato dopo il comando. */
  version: z.number().int().min(0),
});

export const ErrorMessageSchema = z.strictObject({
  type: z.literal("error"),
  /** `null` per errori non legati a una richiesta (es. messaggio illeggibile). */
  requestId: RequestIdSchema.nullable(),
  code: ErrorCodeSchema,
  message: z.string(),
  /** Dettaglio facoltativo: per una formula non valida, il codice del parser dei dadi. */
  reason: DiceErrorCodeSchema.optional(),
});

export const PongSchema = z.strictObject({ type: z.literal("pong") });

export const ServerMessageSchema = z.discriminatedUnion("type", [
  SnapshotMessageSchema,
  DeltaMessageSchema,
  AckMessageSchema,
  ErrorMessageSchema,
  ChatMessageSchema,
  RollResultSchema,
  HistoryMessageSchema,
  EphemeralShownSchema,
  EphemeralClearedSchema,
  PongSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type SnapshotMessage = z.infer<typeof SnapshotMessageSchema>;
export type DeltaMessage = z.infer<typeof DeltaMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

export type ClientParseResult = { ok: true; message: ClientMessage } | { ok: false; error: ErrorMessage };

/**
 * Decodifica e valida un messaggio grezzo dal socket. Non lancia mai.
 * In caso d'errore restituisce il messaggio d'errore da rispedire,
 * con il `requestId` se è leggibile.
 */
export function parseClientMessage(raw: string): ClientParseResult {
  const invalid = (requestId: string | null, message: string): ClientParseResult => ({
    ok: false,
    error: { type: "error", requestId, code: "INVALID", message },
  });
  if (typeof raw !== "string") return invalid(null, "messaggio non testuale");
  if (raw.length > MAX_CLIENT_MESSAGE_SIZE) return invalid(null, "messaggio troppo grande");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return invalid(null, "JSON non valido");
  }
  const parsed = ClientMessageSchema.safeParse(data);
  if (parsed.success) return { ok: true, message: parsed.data };
  const rid =
    typeof data === "object" && data !== null && "requestId" in data
      ? RequestIdSchema.safeParse((data as { requestId: unknown }).requestId)
      : null;
  return invalid(rid?.success ? rid.data : null, "messaggio non valido");
}
