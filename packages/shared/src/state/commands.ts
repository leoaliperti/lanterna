import { z } from "zod";
import {
  ConditionsSchema,
  HealthSchema,
  IdSchema,
  ImageUrlSchema,
  LIMITS,
  MapImageSchema,
  NameSchema,
  ScaleSchema,
  SceneSchema,
  TokenKindSchema,
  TokenSchema,
} from "./schema.js";

/**
 * Comandi che mutano lo stato. Sono l'unico modo di cambiare una campagna:
 * il server li valida con questi schemi e li passa ad `applyCommand`.
 * Tutti gli oggetti sono "strict": campi sconosciuti => INVALID.
 */

const coord = z.number();

export const MoveTokenSchema = z.strictObject({
  type: z.literal("token.move"),
  tokenId: IdSchema,
  x: coord,
  y: coord,
  /** Aggancio alla griglia: se assente vale l'impostazione della scena. `false` = posizione libera. */
  snap: z.boolean().optional(),
});

export const CreateTokenSchema = z.strictObject({
  type: z.literal("token.create"),
  /** L'id lo sceglie il client (UUID): così l'inverso per annulla/ripeti è deterministico. */
  token: TokenSchema,
});

/** Campi modificabili di un token (non `id`, non `sceneId`, non la posizione: per quella c'è `token.move`). */
export const TokenPatchSchema = z
  .strictObject({
    name: NameSchema,
    imageUrl: ImageUrlSchema.nullable(),
    size: z.number().min(LIMITS.tokenMinSize).max(LIMITS.tokenMaxSize),
    rotation: z.number(),
    ownerUserId: IdSchema.nullable(),
    kind: TokenKindSchema,
    hidden: z.boolean(),
    conditions: ConditionsSchema,
    health: HealthSchema.nullable(),
    gmNotes: z.string().max(LIMITS.notesMaxLength),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "patch vuota" });
export type TokenPatch = z.infer<typeof TokenPatchSchema>;

export const UpdateTokenSchema = z.strictObject({
  type: z.literal("token.update"),
  tokenId: IdSchema,
  patch: TokenPatchSchema,
});

export const DeleteTokenSchema = z.strictObject({
  type: z.literal("token.delete"),
  tokenId: IdSchema,
});

export const CreateSceneSchema = z.strictObject({
  type: z.literal("scene.create"),
  scene: SceneSchema,
});

export const ScenePatchSchema = z
  .strictObject({
    name: NameSchema,
    map: MapImageSchema.nullable(),
    width: z.number().int().min(LIMITS.sceneMinSize).max(LIMITS.sceneMaxSize),
    height: z.number().int().min(LIMITS.sceneMinSize).max(LIMITS.sceneMaxSize),
    scale: ScaleSchema,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "patch vuota" });
export type ScenePatch = z.infer<typeof ScenePatchSchema>;

export const UpdateSceneSchema = z.strictObject({
  type: z.literal("scene.update"),
  sceneId: IdSchema,
  patch: ScenePatchSchema,
});

/** Modifica parziale della griglia (la validità complessiva si controlla dopo la fusione). */
export const GridPatchSchema = z
  .strictObject({
    cellSize: z.number().min(LIMITS.cellMinSize).max(LIMITS.cellMaxSize),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    opacity: z.number().min(0).max(1),
    offsetX: z.number(),
    offsetY: z.number(),
    snap: z.boolean(),
    visible: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "patch vuota" });
export type GridPatch = z.infer<typeof GridPatchSchema>;

export const SetSceneGridSchema = z.strictObject({
  type: z.literal("scene.setGrid"),
  sceneId: IdSchema,
  grid: GridPatchSchema,
});

export const DeleteSceneSchema = z.strictObject({
  type: z.literal("scene.delete"),
  sceneId: IdSchema,
});

/** Cambia la scena attiva (quella che vedono i giocatori). `null` = nessuna scena. */
export const ChangeSceneSchema = z.strictObject({
  type: z.literal("scene.activate"),
  sceneId: IdSchema.nullable(),
});

export const CommandSchema = z.discriminatedUnion("type", [
  MoveTokenSchema,
  CreateTokenSchema,
  UpdateTokenSchema,
  DeleteTokenSchema,
  CreateSceneSchema,
  UpdateSceneSchema,
  SetSceneGridSchema,
  DeleteSceneSchema,
  ChangeSceneSchema,
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command["type"];
