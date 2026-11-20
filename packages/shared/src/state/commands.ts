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
  TokenVisionSchema,
} from "./schema.js";
import { FogLightingSchema, FogSchema, FogShapeSchema, FogStateSchema, FogTargetSchema } from "./fog.js";
import { WallSchema } from "./walls.js";

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
    vision: TokenVisionSchema.nullable(),
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

// ---------------------------------------------------------------------------
// Nebbia di guerra (M6): tutti solo GM
// ---------------------------------------------------------------------------

/**
 * Attiva la nebbia sulla scena. `initial`: stato iniziale per tutti ("covered" = tutto coperto,
 * "revealed" = tutto scoperto). La griglia della nebbia è quella della scena, salvo override.
 */
export const FogEnableSchema = z.strictObject({
  type: z.literal("fog.enable"),
  sceneId: IdSchema,
  initial: FogStateSchema,
  lighting: FogLightingSchema.optional(),
  cellSize: z.number().min(LIMITS.cellMinSize).max(LIMITS.cellMaxSize).optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
});

/** Toglie la nebbia (la scena torna visibile a tutti come prima di M6). */
export const FogDisableSchema = z.strictObject({ type: z.literal("fog.disable"), sceneId: IdSchema });

/** Imposta la nebbia completa di una scena: è l'inverso usato da annulla/ripeti. */
export const FogRestoreSchema = z.strictObject({ type: z.literal("fog.restore"), fog: FogSchema });

export const FogRevealSchema = z.strictObject({
  type: z.literal("fog.reveal"),
  sceneId: IdSchema,
  shape: FogShapeSchema,
  target: FogTargetSchema,
});

export const FogCoverSchema = z.strictObject({
  type: z.literal("fog.cover"),
  sceneId: IdSchema,
  shape: FogShapeSchema,
  target: FogTargetSchema,
});

export const FogRevealAllSchema = z.strictObject({
  type: z.literal("fog.revealAll"),
  sceneId: IdSchema,
  target: FogTargetSchema,
});

export const FogCoverAllSchema = z.strictObject({
  type: z.literal("fog.coverAll"),
  sceneId: IdSchema,
  target: FogTargetSchema,
});

export const FogSetLightingSchema = z.strictObject({
  type: z.literal("fog.setLighting"),
  sceneId: IdSchema,
  lighting: FogLightingSchema,
});

// ---------------------------------------------------------------------------
// Muri e porte (M6): solo GM
// ---------------------------------------------------------------------------

export const WallAddSchema = z.strictObject({ type: z.literal("wall.add"), wall: WallSchema });

const finiteCoord = z.number().refine(Number.isFinite, "numero non finito");
export const WallPatchSchema = z
  .strictObject({
    x1: finiteCoord,
    y1: finiteCoord,
    x2: finiteCoord,
    y2: finiteCoord,
    door: z.boolean(),
    open: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "patch vuota" });
export type WallPatch = z.infer<typeof WallPatchSchema>;

export const WallUpdateSchema = z.strictObject({
  type: z.literal("wall.update"),
  wallId: IdSchema,
  patch: WallPatchSchema,
});

export const WallRemoveSchema = z.strictObject({ type: z.literal("wall.remove"), wallId: IdSchema });

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
  FogEnableSchema,
  FogDisableSchema,
  FogRestoreSchema,
  FogRevealSchema,
  FogCoverSchema,
  FogRevealAllSchema,
  FogCoverAllSchema,
  FogSetLightingSchema,
  WallAddSchema,
  WallUpdateSchema,
  WallRemoveSchema,
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command["type"];
