import { z } from "zod";
import { cellCol, cellRow, isCellRevealed, type FogGeometry, type FogMask } from "./fog.js";
import { IdSchema } from "./limits.js";

/**
 * Muri e porte (M6): segmenti che bloccano la linea di vista nell'aiuto visivo.
 * Solo il GM li crea e li modifica. Ai giocatori arriva solo la parte che cade
 * in celle rivelate a loro (`clipSegmentToMask`): la geometria sotto la nebbia non esce.
 */

const finite = z.number().refine(Number.isFinite, "numero non finito");

export const WallSchema = z
  .strictObject({
    id: IdSchema,
    sceneId: IdSchema,
    x1: finite,
    y1: finite,
    x2: finite,
    y2: finite,
    /** Porta: se `open` non blocca la vista. Un muro normale ha `door: false` (e `open` è ignorato). */
    door: z.boolean(),
    open: z.boolean(),
  })
  .refine((w) => w.x1 !== w.x2 || w.y1 !== w.y2, { message: "muro di lunghezza nulla" });
export type Wall = z.infer<typeof WallSchema>;

/** Il muro blocca la vista? (le porte aperte no) */
export const blocksSight = (w: Wall): boolean => !(w.door && w.open);

const EPS = 1e-9;

/**
 * Parti del segmento che cadono in celle rivelate della maschera, come lista piatta
 * `x1, y1, x2, y2, ...`. Il segmento si divide nei punti in cui attraversa le linee
 * della griglia della nebbia; ogni pezzo è visibile se la cella che contiene il suo punto
 * medio è rivelata. Un pezzo che corre esattamente su una linea della griglia (muro
 * disegnato sul bordo di una stanza) è visibile se è rivelata una delle due celle accanto.
 */
export function clipSegmentToMask(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  g: FogGeometry,
  mask: FogMask,
): number[] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const ts: number[] = [0, 1];
  const cross = (p0: number, d: number, offset: number) => {
    if (Math.abs(d) < EPS) return;
    const k0 = (p0 - offset) / g.cellSize;
    const k1 = (p0 + d - offset) / g.cellSize;
    const lo = Math.ceil(Math.min(k0, k1));
    const hi = Math.floor(Math.max(k0, k1));
    for (let k = lo; k <= hi; k++) {
      const t = (offset + k * g.cellSize - p0) / d;
      if (t > 0 && t < 1) ts.push(t);
    }
  };
  cross(x1, dx, g.offsetX);
  cross(y1, dy, g.offsetY);
  ts.sort((a, b) => a - b);

  const out: number[] = [];
  let open: [number, number] | null = null;
  const tol = g.cellSize * 1e-6;
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i]!;
    const t1 = ts[i + 1]!;
    if (t1 - t0 < 1e-12) continue;
    const tm = (t0 + t1) / 2;
    const mx = x1 + dx * tm;
    const my = y1 + dy * tm;
    const cols = new Set([cellCol(g, mx - tol), cellCol(g, mx + tol)]);
    const rows = new Set([cellRow(g, my - tol), cellRow(g, my + tol)]);
    let visible = false;
    for (const c of cols) for (const r of rows) if (!visible && isCellRevealed(mask, c, r)) visible = true;
    if (visible) {
      if (open && open[1] === t0) open[1] = t1;
      else {
        if (open) out.push(x1 + dx * open[0], y1 + dy * open[0], x1 + dx * open[1], y1 + dy * open[1]);
        open = [t0, t1];
      }
    }
  }
  if (open) out.push(x1 + dx * open[0], y1 + dy * open[0], x1 + dx * open[1], y1 + dy * open[1]);
  return out;
}
