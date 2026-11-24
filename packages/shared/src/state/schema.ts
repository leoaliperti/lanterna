import { z } from "zod";
import { CombatSchema, EffectsSchema, GroupSchema, type Combat } from "./combat.js";
import { FogSchema, type Fog } from "./fog.js";
import { IdSchema, LIMITS } from "./limits.js";
import { WallSchema, type Wall } from "./walls.js";

/**
 * Modello di stato di una campagna. È la forma "completa" (vista del GM)
 * che vive solo sul server. Ai giocatori arriva sempre e solo una
 * proiezione filtrata (vedi `viewFor` in `view.ts`).
 */

export { IdSchema, LIMITS, type Id } from "./limits.js";

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

/** Forma del token sulla mappa (solo varietà visiva; la vita e le regole restano uguali). */
export const TokenShapeSchema = z.enum(["circle", "square", "diamond", "hexagon", "triangle"]);
export type TokenShape = z.infer<typeof TokenShapeSchema>;

/** Numero da mostrare sul token per distinguere i personaggi in battaglia (es. 1, 2, 3...). */
export const TokenNumberSchema = z.number().int().min(0).max(999);

export const TokenConditionSchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  /**
   * Solo per l'Esaurimento 2024: livello 1-6 (6 = morte). Assente per le altre condizioni.
   * Il limite 6 è `MAX_EXHAUSTION` in rules5e/conditions.ts.
   */
  level: z.number().int().min(1).max(6).optional(),
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

const visionRange = z.number().min(0).max(LIMITS.visionMaxRange);

/**
 * Vista e luce di un token, in unità di gioco (es. piedi). Serve SOLO all'aiuto visivo
 * ("cosa vede questo token"): non scopre mai la nebbia.
 * - `range`: distanza massima di vista (`null` = illimitata);
 * - `darkvision`: scurovisione (vede al buio entro questo raggio);
 * - `bright` / `dim`: luce emessa dal token (luce intensa entro `bright`, fioca fino a `bright + dim`).
 */
export const TokenVisionSchema = z.strictObject({
  range: visionRange.nullable(),
  darkvision: visionRange,
  bright: visionRange,
  dim: visionRange,
});
export type TokenVision = z.infer<typeof TokenVisionSchema>;

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
  /** Facoltativo (assente nelle campagne precedenti a M6): vista e luce per l'aiuto visivo. */
  vision: TokenVisionSchema.nullable().optional(),
  /** Facoltativo (M7): fazione ("nemici", "squadra A", ...), solo per selezionare; visibile solo al GM. */
  faction: z.string().trim().min(1).max(LIMITS.nameMaxLength).nullable().optional(),
  /** Facoltativo (M7): effetti temporanei con durata. */
  effects: EffectsSchema.optional(),
  /** Facoltativo: forma sulla mappa (assente = cerchio). */
  shape: TokenShapeSchema.optional(),
  /** Facoltativo: numero sul token (assente o null = nessuno). */
  number: TokenNumberSchema.nullable().optional(),
});
export type Token = z.infer<typeof TokenSchema>;

/**
 * Orologio di gioco (campagna): giorno (dal 1) e minuto del giorno (0-1439). Lo imposta il GM;
 * lo vedono tutti. Facoltativo: assente = `DEFAULT_CLOCK` (giorno 1, ore 8:00).
 */
export const ClockSchema = z.strictObject({
  day: z.number().int().min(1).max(100000),
  minute: z.number().int().min(0).max(1439),
});
export type Clock = z.infer<typeof ClockSchema>;
export const DEFAULT_CLOCK: Clock = { day: 1, minute: 8 * 60 };

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
  /**
   * Nebbia di guerra per scena (M6), al più una per scena. Facoltativo: assente o vuoto =
   * nessuna nebbia (comportamento precedente a M6).
   */
  fogs: z.array(FogSchema).max(LIMITS.maxScenes).optional(),
  /** Muri e porte (M6), di tutte le scene. Facoltativo come `fogs`. */
  walls: z.array(WallSchema).max(LIMITS.maxWalls).optional(),
  /** Orologio di gioco (GM imposta, tutti vedono). Facoltativo: vedi `DEFAULT_CLOCK`. */
  clock: ClockSchema.optional(),
  /** Combattimenti (M7), al più uno per scena. Facoltativo. */
  combats: z.array(CombatSchema).max(LIMITS.maxScenes).optional(),
  /** Gruppi salvati di token (M7), solo GM. Facoltativo. */
  groups: z.array(GroupSchema).max(LIMITS.maxGroups).optional(),
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

/** Nebbia della scena, se attiva. */
export function fogOf(state: Pick<CampaignState, "fogs">, sceneId: string): Fog | null {
  return state.fogs?.find((f) => f.sceneId === sceneId) ?? null;
}

/** Combattimento della scena, se c'è. */
export function combatOf(state: Pick<CampaignState, "combats">, sceneId: string): Combat | null {
  return state.combats?.find((c) => c.sceneId === sceneId) ?? null;
}

/** Muri della scena, nell'ordine dello stato. */
export function wallsOf(state: Pick<CampaignState, "walls">, sceneId: string): Wall[] {
  return (state.walls ?? []).filter((w) => w.sceneId === sceneId);
}

/** Risolve l'attore dai membri della campagna; `null` se l'utente non ne fa parte. */
export function resolveActor(state: CampaignState, userId: string): Actor | null {
  const m = state.members.find((x) => x.userId === userId);
  return m ? { userId: m.userId, role: m.role } : null;
}
