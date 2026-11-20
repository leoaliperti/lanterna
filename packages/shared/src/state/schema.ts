import { z } from "zod";

/**
 * Modello di stato di una campagna. È la forma "completa" (vista del GM)
 * che vive solo sul server. Ai giocatori arriva sempre e solo una
 * proiezione filtrata (vedi `viewFor` in `view.ts`).
 */

/** Limiti condivisi: usati sia dagli schemi sia dai test. */
export const LIMITS = {
  idMaxLength: 64,
  nameMaxLength: 64,
  urlMaxLength: 2048,
  notesMaxLength: 10_000,
  sceneMinSize: 1,
  sceneMaxSize: 20_000,
  cellMinSize: 4,
  cellMaxSize: 1024,
  tokenMinSize: 0.25,
  tokenMaxSize: 32,
  maxConditions: 32,
  hpMax: 100_000,
  unitsPerCellMax: 1000,
  unitMaxLength: 16,
  maxTokens: 2000,
  maxScenes: 200,
} as const;

/** Identificatore opaco (UUID o simile). Mai contatori: non devono rivelare quanti oggetti esistono. */
export const IdSchema = z
  .string()
  .min(1)
  .max(LIMITS.idMaxLength)
  .regex(/^[A-Za-z0-9_-]+$/, "id non valido");
export type Id = z.infer<typeof IdSchema>;

export const NameSchema = z.string().trim().min(1).max(LIMITS.nameMaxLength);

/** URL di un'immagine: solo percorsi relativi al server o http(s). Niente `javascript:`/`data:`. */
export const ImageUrlSchema = z
  .string()
  .max(LIMITS.urlMaxLength)
  .regex(/^(https?:\/\/|\/)[^\s"'<>\\]*$/, "url non valido");

export const RoleSchema = z.enum(["admin", "player"]);
export type Role = z.infer<typeof RoleSchema>;

export const MemberSchema = z.strictObject({
  userId: IdSchema,
  displayName: NameSchema,
  role: RoleSchema,
});
export type Member = z.infer<typeof MemberSchema>;

export const GridSchema = z
  .strictObject({
    /** Lato della cella in pixel della mappa. */
    cellSize: z.number().min(LIMITS.cellMinSize).max(LIMITS.cellMaxSize),
    /** Colore `#rrggbb`. */
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "colore non valido"),
    opacity: z.number().min(0).max(1),
    offsetX: z.number(),
    offsetY: z.number(),
    snap: z.boolean(),
    visible: z.boolean(),
  })
  .refine((g) => Math.abs(g.offsetX) < g.cellSize && Math.abs(g.offsetY) < g.cellSize, {
    message: "l'offset deve essere minore della cella",
  });
export type Grid = z.infer<typeof GridSchema>;

/** Scala: 1 cella = `unitsPerCell` `unit` (es. 5 ft). */
export const ScaleSchema = z.strictObject({
  unitsPerCell: z.number().positive().max(LIMITS.unitsPerCellMax),
  unit: z.string().trim().min(1).max(LIMITS.unitMaxLength),
});
export type Scale = z.infer<typeof ScaleSchema>;

export const MapImageSchema = z.strictObject({
  assetId: IdSchema,
  url: ImageUrlSchema,
});
export type MapImage = z.infer<typeof MapImageSchema>;

const sceneSize = z.number().int().min(LIMITS.sceneMinSize).max(LIMITS.sceneMaxSize);

export const SceneSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  map: MapImageSchema.nullable(),
  /** Dimensioni della mappa in pixel (coordinate mappa). */
  width: sceneSize,
  height: sceneSize,
  grid: GridSchema,
  scale: ScaleSchema,
});
export type Scene = z.infer<typeof SceneSchema>;

export const TokenKindSchema = z.enum(["pc", "monster", "object"]);
export type TokenKind = z.infer<typeof TokenKindSchema>;

export const TokenConditionSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
});
export type TokenCondition = z.infer<typeof TokenConditionSchema>;

export const ConditionsSchema = z
  .array(TokenConditionSchema)
  .max(LIMITS.maxConditions)
  .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, {
    message: "condizioni duplicate",
  });

const hpInt = z.number().int().min(0).max(LIMITS.hpMax);

export const HealthSchema = z
  .strictObject({ current: hpInt, max: hpInt, temp: hpInt })
  .refine((h) => h.current <= h.max, { message: "vita attuale oltre il massimo" });
export type Health = z.infer<typeof HealthSchema>;

export const TokenSchema = z.strictObject({
  id: IdSchema,
  sceneId: IdSchema,
  name: NameSchema,
  imageUrl: ImageUrlSchema.nullable(),
  /** Centro del token in coordinate mappa (pixel). */
  x: z.number(),
  y: z.number(),
  /** Lato in celle (1 = medio, 2 = grande, 0.5 = minuscolo). */
  size: z.number().min(LIMITS.tokenMinSize).max(LIMITS.tokenMaxSize),
  /** Gradi in [0, 360). */
  rotation: z.number().min(0).lt(360),
  ownerUserId: IdSchema.nullable(),
  kind: TokenKindSchema,
  hidden: z.boolean(),
  conditions: ConditionsSchema,
  health: HealthSchema.nullable(),
  gmNotes: z.string().max(LIMITS.notesMaxLength),
});
export type Token = z.infer<typeof TokenSchema>;

export const CampaignStateSchema = z.strictObject({
  campaignId: IdSchema,
  name: NameSchema,
  /** Cresce di 1 a ogni comando applicato con successo. */
  version: z.number().int().min(0),
  activeSceneId: IdSchema.nullable(),
  members: z.array(MemberSchema),
  scenes: z.array(SceneSchema).max(LIMITS.maxScenes),
  /** L'ordine dell'array è l'ordine di disegno (z-order). */
  tokens: z.array(TokenSchema).max(LIMITS.maxTokens),
});
export type CampaignState = z.infer<typeof CampaignStateSchema>;

/** Chi esegue un comando. Il server lo costruisce dalla sessione autenticata, mai dal client. */
export interface Actor {
  userId: string;
  role: Role;
}

export const DEFAULT_GRID: Grid = {
  cellSize: 70,
  color: "#000000",
  opacity: 0.35,
  offsetX: 0,
  offsetY: 0,
  snap: true,
  visible: true,
};

export const DEFAULT_SCALE: Scale = { unitsPerCell: 5, unit: "ft" };

/** Stato iniziale vuoto di una campagna. */
export function createCampaignState(
  campaignId: string,
  name: string,
  members: Member[],
): CampaignState {
  return CampaignStateSchema.parse({
    campaignId,
    name,
    version: 0,
    activeSceneId: null,
    members,
    scenes: [],
    tokens: [],
  });
}

/** Risolve l'attore dai membri della campagna; `null` se l'utente non ne fa parte. */
export function resolveActor(state: CampaignState, userId: string): Actor | null {
  const m = state.members.find((x) => x.userId === userId);
  return m ? { userId: m.userId, role: m.role } : null;
}
