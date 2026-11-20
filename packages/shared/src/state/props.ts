import { z } from "zod";
import { IdSchema, LIMITS } from "./limits.js";

/**
 * Oggetti di scena (M10): immagini sopra la mappa, su tre livelli.
 * - `background`: sfondo, sopra la mappa e sotto la griglia;
 * - `ground`: oggetti a terra, sopra la griglia e sotto i token;
 * - `above`: sopra i token (alberi, tetti); con `fade` si schiariscono quando un token ci passa sotto.
 * I token stanno tra `ground` e `above`.
 */
export const PROP_LAYERS = ["background", "ground", "above"] as const;
export const PropLayerSchema = z.enum(PROP_LAYERS);
export type PropLayer = z.infer<typeof PropLayerSchema>;

const url = z
  .string()
  .max(LIMITS.urlMaxLength)
  .regex(/^(https?:\/\/|\/)[^\s"'<>\\]*$/, "url non valido");

const finite = z.number().refine(Number.isFinite, "numero non finito");

export const PropSchema = z.strictObject({
  id: IdSchema,
  sceneId: IdSchema,
  /** Etichetta del GM: non arriva mai ai giocatori. */
  name: z.string().trim().min(1).max(LIMITS.nameMaxLength),
  imageUrl: url,
  /** Centro, in coordinate mappa (pixel). */
  x: finite,
  y: finite,
  /** Dimensioni in pixel mappa. */
  width: z.number().min(1).max(LIMITS.sceneMaxSize),
  height: z.number().min(1).max(LIMITS.sceneMaxSize),
  /** Gradi in [0, 360). */
  rotation: z.number().min(0).lt(360),
  layer: PropLayerSchema,
  opacity: z.number().min(0).max(1),
  /** Solo `above`: schiarire quando un token del giocatore è sotto. */
  fade: z.boolean(),
  /** Nascosto ai giocatori. */
  hidden: z.boolean(),
});
export type Prop = z.infer<typeof PropSchema>;

export const PropPatchSchema = PropSchema.omit({ id: true, sceneId: true })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "patch vuota" });
export type PropPatch = z.infer<typeof PropPatchSchema>;

/** Ciò che vede il giocatore: niente `name` e niente `hidden` (i nascosti non arrivano). */
export const PropViewSchema = PropSchema.omit({ name: true, hidden: true }).extend({
  /** Solo GM. */
  name: z.string().optional(),
  hidden: z.boolean().optional(),
});
export type PropView = z.infer<typeof PropViewSchema>;

/** Semi-estensioni dell'ingombro ruotato (rettangolo di contorno). */
export function propHalfExtent(p: Pick<Prop, "width" | "height" | "rotation">): { hx: number; hy: number } {
  const r = (p.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { hx: (p.width * c + p.height * s) / 2, hy: (p.width * s + p.height * c) / 2 };
}
