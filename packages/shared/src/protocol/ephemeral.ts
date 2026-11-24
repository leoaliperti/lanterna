import { z } from "zod";
import { InitiativeModeSchema } from "../state/combat.js";
import { err, MESSAGES, type CommandError } from "../state/errors.js";
import { IdSchema, LIMITS } from "../state/limits.js";
import { isInsideScene } from "../state/grid.js";
import type { Actor, CampaignState, Scene } from "../state/schema.js";
import { ShapeSchema, ShownShapeSchema, shapePoints, type Shape } from "../state/shapes.js";
import { canSeeScene } from "../state/view.js";

/**
 * Misurazioni, frecce di intenzione e ping (M7): messaggi EFFIMERI, mai salvati né rimessi in coda alla
 * riconnessione. Il server li inoltra ai soli destinatari consentiti, ciascuno con la forma ritagliata per la
 * sua nebbia (`shapeForViewer`). Una misura PRIVATA (`audience: "private"`) resta sul client: se il client la
 * manda comunque, il server risponde `ack` e non la inoltra a nessuno.
 */

/** Tempo di vita predefinito, in millisecondi, se il client non lo indica. */
export function defaultTtlMs(shape: Shape): number {
  switch (shape.kind) {
    case "ping":
      return 4000;
    case "arrow":
      return 6000;
    case "ruler":
      // Il righello è una misura da leggere e lasciare: sparisce in fretta.
      return 2000;
    default:
      return 10_000;
  }
}

export const MIN_EPHEMERAL_TTL_MS = 500;

/** Chi vede la forma: nessuno (resta sul client), solo il GM, tutti quelli che vedono la scena. */
export const EphemeralAudienceSchema = z.enum(["private", "gm", "all"]);
export type EphemeralAudience = z.infer<typeof EphemeralAudienceSchema>;

const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colore non valido");

/**
 * `id`: lo sceglie il client; rimandare lo stesso `id` sostituisce la forma precedente dello stesso autore
 * (si usa per trascinare un righello). Ogni utente ha al più `MAX_LIVE_EPHEMERALS` forme vive.
 */
export const EphemeralShowSchema = z.strictObject({
  type: z.literal("ephemeral.show"),
  requestId: IdSchema,
  id: IdSchema,
  sceneId: IdSchema,
  audience: EphemeralAudienceSchema,
  ttlMs: z.number().int().min(MIN_EPHEMERAL_TTL_MS).max(LIMITS.maxEphemeralTtlMs).optional(),
  shape: ShapeSchema,
  color: ColorSchema.optional(),
});
export type EphemeralShow = z.infer<typeof EphemeralShowSchema>;

export const EphemeralClearSchema = z.strictObject({
  type: z.literal("ephemeral.clear"),
  requestId: IdSchema,
  id: IdSchema,
});
export type EphemeralClear = z.infer<typeof EphemeralClearSchema>;

/** Forme vive per utente: oltre, la più vecchia viene tolta. */
export const MAX_LIVE_EPHEMERALS = 8;

/** Tiro dell'iniziativa: il server tira d20 + bonus con l'RNG sicuro e imposta i valori (solo GM). */
export const InitiativeRollSchema = z.strictObject({
  type: z.literal("initiative.roll"),
  requestId: IdSchema,
  sceneId: IdSchema,
  rolls: z
    .array(
      z.strictObject({
        participantId: IdSchema,
        bonus: z.number().int().min(-50).max(50),
        mode: InitiativeModeSchema.optional(),
      }),
    )
    .min(1)
    .max(LIMITS.maxParticipants),
  /** Riordina i partecipanti per iniziativa dopo il tiro. */
  sort: z.boolean().optional(),
});
export type InitiativeRollRequest = z.infer<typeof InitiativeRollSchema>;

/** Forma (o ritaglio) in arrivo: `authorId` serve a sostituire/togliere forme dello stesso autore. */
export const EphemeralShownSchema = z.strictObject({
  type: z.literal("ephemeral.shown"),
  id: IdSchema,
  authorId: IdSchema,
  sceneId: IdSchema,
  /** Quanto resta da vivere, in millisecondi (non un orario: gli orologi dei client sono diversi). */
  ttlMs: z.number().int().min(0),
  shape: ShownShapeSchema,
  color: ColorSchema.optional(),
});
export type EphemeralShown = z.infer<typeof EphemeralShownSchema>;

export const EphemeralClearedSchema = z.strictObject({
  type: z.literal("ephemeral.cleared"),
  id: IdSchema,
  authorId: IdSchema,
});
export type EphemeralCleared = z.infer<typeof EphemeralClearedSchema>;

/**
 * Controlla se `actor` può mostrare la forma sulla scena. Il GM su qualsiasi scena; il giocatore solo sulla
 * scena attiva (un'altra scena è NOT_FOUND, come se non esistesse). I punti devono stare dentro la mappa.
 */
export function validateEphemeral(
  state: CampaignState,
  actor: Actor,
  msg: Pick<EphemeralShow, "sceneId" | "shape">,
): { ok: true; scene: Scene } | { ok: false; error: CommandError } {
  const scene = state.scenes.find((s) => s.id === msg.sceneId);
  if (!scene || !canSeeScene(scene, actor, state.activeSceneId)) return err("NOT_FOUND", MESSAGES.sceneNotFound);
  if (!shapePoints(msg.shape).every((p) => isInsideScene(p.x, p.y, scene))) return err("INVALID", MESSAGES.outOfBounds);
  return { ok: true, scene };
}
