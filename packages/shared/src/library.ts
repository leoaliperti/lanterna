import { z } from "zod";
import { LIMITS } from "./state/limits.js";
import { ImageUrlSchema, NameSchema, TokenKindSchema, type TokenKind } from "./state/schema.js";

/**
 * Libreria di token e oggetti riutilizzabili (M10).
 *
 * Un elemento è un "modello" salvato dall'editor dei token: nome, immagine, tipo, dimensione e
 * qualche statistica di base. Non è un token: per metterlo in scena il client crea un token con il
 * comando `token.create` esistente (id nuovo, scena e posizione scelti al momento).
 *
 * Ambito: `campaign` (visibile solo in una campagna) o `global` (tutte le campagne, gestito dall'admin).
 */

export const LIBRARY_LIMITS = {
  maxTags: 8,
  maxTagLength: 24,
  /** Elementi per ambito (una campagna, oppure la libreria globale). */
  maxItemsPerScope: 2000,
  maxQueryLength: 100,
  maxPageSize: 100,
} as const;

export const LIBRARY_KINDS = TokenKindSchema.options;
export const LibraryScopeSchema = z.enum(["campaign", "global"]);
export type LibraryScope = z.infer<typeof LibraryScopeSchema>;

/** Statistiche di base (tutte facoltative): servono a compilare il token e la scheda, non sono regole. */
export const LibraryStatsSchema = z.strictObject({
  hpMax: z.number().int().min(0).max(LIMITS.hpMax).nullable(),
  armorClass: z.number().int().min(0).max(100).nullable(),
  /** Velocità in unità di gioco (piedi). */
  speed: z.number().int().min(0).max(1000).nullable(),
});
export type LibraryStats = z.infer<typeof LibraryStatsSchema>;

export const EMPTY_LIBRARY_STATS: LibraryStats = { hpMax: null, armorClass: null, speed: null };

export const LibraryTagSchema = z.string().trim().min(1).max(LIBRARY_LIMITS.maxTagLength);

const tokenSize = z.number().min(LIMITS.tokenMinSize).max(LIMITS.tokenMaxSize);

/** Parte "di contenuto" di un elemento (quella che si salva in `data`). */
export const LibraryContentSchema = z.strictObject({
  size: tokenSize,
  imageUrl: ImageUrlSchema.nullable(),
  stats: LibraryStatsSchema,
  tags: z
    .array(LibraryTagSchema)
    .max(LIBRARY_LIMITS.maxTags)
    .refine((t) => new Set(t.map((x) => x.toLocaleLowerCase())).size === t.length, { message: "tag duplicati" }),
});
export type LibraryContent = z.infer<typeof LibraryContentSchema>;

/** `POST /library` (admin). */
export const CreateLibraryItemSchema = z
  .strictObject({
    name: NameSchema,
    kind: TokenKindSchema,
    scope: LibraryScopeSchema,
    /** Obbligatorio con `scope: "campaign"`, vietato con `global`. */
    campaignId: z.string().min(1).max(LIMITS.idMaxLength).regex(/^[A-Za-z0-9_-]+$/).optional(),
    ...LibraryContentSchema.shape,
  })
  .refine((v) => (v.scope === "campaign") === (v.campaignId !== undefined), {
    message: "campaignId serve (solo) con scope campaign",
    path: ["campaignId"],
  });
export type CreateLibraryItem = z.infer<typeof CreateLibraryItemSchema>;

/** `PATCH /library/:id` (admin): ambito e campagna non si cambiano. */
export const UpdateLibraryItemSchema = z
  .strictObject({ name: NameSchema, kind: TokenKindSchema, ...LibraryContentSchema.shape })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "patch vuota" });
export type UpdateLibraryItem = z.infer<typeof UpdateLibraryItemSchema>;

/** Elemento completo (vista dell'admin). */
export interface LibraryItem extends LibraryContent {
  id: string;
  name: string;
  kind: TokenKind;
  scope: LibraryScope;
  campaignId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Elemento come lo vede un giocatore: niente statistiche (PF e CA di un mostro sono informazioni
 * del GM) e nessun id di campagna.
 */
export type LibraryItemPublic = Pick<LibraryItem, "id" | "name" | "kind" | "scope" | "size" | "imageUrl" | "tags">;

/** `GET /library`. `items` ha `LibraryItem` per l'admin e `LibraryItemPublic` per un giocatore. */
export interface ListLibraryResponse<T = LibraryItem | LibraryItemPublic> {
  items: T[];
  total: number;
}
