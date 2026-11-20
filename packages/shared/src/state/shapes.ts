import { z } from "zod";
import { cellCol, cellRow, isCellRevealed, maskFor, type Fog, type FogGeometry } from "./fog.js";
import { LIMITS } from "./limits.js";
import type { Actor, Scale, Scene } from "./schema.js";
import { isGm } from "./view.js";

/**
 * Misurazioni e segnalazioni (M7): forme geometriche in coordinate mappa (pixel) e logica pura per sapere
 * quali celle della griglia coprono. Le forme sono EFFIMERE: non entrano mai nello stato né nel database.
 *
 * Convenzioni (tutte documentate in `docs/COMBAT.md`):
 * - asse x verso destra, asse y verso il BASSO (come la mappa); gli angoli si misurano in gradi da +x e
 *   crescono in senso orario sullo schermo (90 = verso il basso);
 * - una cella è coperta se il suo CENTRO sta dentro la forma (bordi inclusi); in più la cella dell'origine
 *   è sempre inclusa, così anche una forma più piccola di una cella copre almeno una cella;
 * - cono 5e: l'ampiezza del cono a una certa distanza è uguale alla distanza, quindi l'angolo totale è
 *   2 * atan(1/2) = 53,13 gradi (`CONE_ANGLE_DEG`); `angle` permette altre varianti (es. 90).
 */

/** Angolo totale del cono 5e: 2 * atan(0,5), circa 53,13 gradi. */
export const CONE_ANGLE_DEG = (2 * Math.atan(0.5) * 180) / Math.PI;

const EPS = 1e-6;
const coord = z.number().min(0).max(LIMITS.sceneMaxSize);
const length = z.number().positive().max(LIMITS.sceneMaxSize);
const PointSchema = z.strictObject({ x: coord, y: coord });
export type Point = z.infer<typeof PointSchema>;

export const ShapeSchema = z.discriminatedUnion("kind", [
  /** Righello: poligonale da 2 a 16 punti. */
  z.strictObject({ kind: z.literal("ruler"), points: z.array(PointSchema).min(2).max(16) }),
  z.strictObject({ kind: z.literal("circle"), x: coord, y: coord, radius: length }),
  /** Cono con vertice in (x, y), asse nella direzione `direction` (gradi), lunghezza `length`. */
  z.strictObject({
    kind: z.literal("cone"),
    x: coord,
    y: coord,
    direction: z.number().min(-720).max(720),
    length,
    angle: z.number().min(1).max(180).optional(),
  }),
  /** Linea (striscia) da (x1, y1) a (x2, y2) larga `width`, a estremi piatti. */
  z.strictObject({ kind: z.literal("line"), x1: coord, y1: coord, x2: coord, y2: coord, width: length }),
  /** Freccia di intenzione ("voglio andare/attaccare lì"). */
  z.strictObject({ kind: z.literal("arrow"), x1: coord, y1: coord, x2: coord, y2: coord }),
  /** Ping ("guardate qui"), con etichetta facoltativa di testo semplice. */
  z.strictObject({
    kind: z.literal("ping"),
    x: coord,
    y: coord,
    label: z
      .string()
      // niente caratteri di controllo né segni di markup: il client mostra comunque solo testo
      .regex(/^[^\u0000-\u001f\u007f<>]*$/, "etichetta non valida")
      .max(32)
      .optional(),
  }),
]);
export type Shape = z.infer<typeof ShapeSchema>;

/**
 * Forma "ritagliata": al destinatario con la nebbia arrivano solo le celle (della griglia della nebbia) che
 * gli sono rivelate, come terne piatte `col, riga, ...`. Niente coordinate, niente misure.
 */
export const CellsShapeSchema = z.strictObject({
  kind: z.literal("cells"),
  cells: z.array(z.number().int()).max(2 * LIMITS.maxShapeCells),
});
export type CellsShape = z.infer<typeof CellsShapeSchema>;

export const ShownShapeSchema = z.union([ShapeSchema, CellsShapeSchema]);
export type ShownShape = z.infer<typeof ShownShapeSchema>;

// ---------------------------------------------------------------------------
// Contenimento di un punto
// ---------------------------------------------------------------------------

export function circleContains(c: { x: number; y: number; radius: number }, px: number, py: number): boolean {
  return Math.hypot(px - c.x, py - c.y) <= c.radius + EPS;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Differenza fra due angoli (radianti) normalizzata in [-pi, pi]. */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function coneContains(
  c: { x: number; y: number; direction: number; length: number; angle?: number },
  px: number,
  py: number,
): boolean {
  const dx = px - c.x;
  const dy = py - c.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= EPS) return true;
  if (dist > c.length + EPS) return false;
  const half = toRad(c.angle ?? CONE_ANGLE_DEG) / 2;
  return Math.abs(angleDiff(Math.atan2(dy, dx), toRad(c.direction))) <= half + 1e-9;
}

export function lineContains(
  l: { x1: number; y1: number; x2: number; y2: number; width: number },
  px: number,
  py: number,
): boolean {
  const vx = l.x2 - l.x1;
  const vy = l.y2 - l.y1;
  const len2 = vx * vx + vy * vy;
  const half = l.width / 2;
  if (len2 === 0) return Math.hypot(px - l.x1, py - l.y1) <= half + EPS;
  const t = ((px - l.x1) * vx + (py - l.y1) * vy) / len2;
  if (t < -EPS || t > 1 + EPS) return false;
  const perp = Math.abs((px - l.x1) * vy - (py - l.y1) * vx) / Math.sqrt(len2);
  return perp <= half + EPS;
}

// ---------------------------------------------------------------------------
// Celle coperte
// ---------------------------------------------------------------------------

/**
 * Celle della griglia `g` coperte dalla forma, come terne piatte `col, riga, ...` in ordine di riga.
 * `bounds`: se presente, si scartano le celle il cui centro è fuori dalla mappa.
 * `null` se la forma richiederebbe di esaminare più di `LIMITS.maxShapeCells` celle (forma troppo grande).
 */
export function shapeCells(
  shape: Shape,
  g: FogGeometry,
  bounds?: Pick<Scene, "width" | "height">,
): number[] | null {
  const found = new Map<number, [number, number]>();
  const key = (c: number, r: number) => r * 1_000_003 + c;
  const add = (c: number, r: number): void => {
    const cx = g.offsetX + (c + 0.5) * g.cellSize;
    const cy = g.offsetY + (r + 0.5) * g.cellSize;
    if (bounds && (cx < 0 || cy < 0 || cx > bounds.width || cy > bounds.height)) return;
    found.set(key(c, r), [c, r]);
  };
  const addPoint = (x: number, y: number) => add(cellCol(g, x), cellRow(g, y));

  /** Scorre le celle del rettangolo e aggiunge quelle il cui centro soddisfa `inside`. */
  const scan = (x0: number, y0: number, x1: number, y1: number, inside: (x: number, y: number) => boolean): boolean => {
    const c0 = cellCol(g, x0);
    const c1 = cellCol(g, x1);
    const r0 = cellRow(g, y0);
    const r1 = cellRow(g, y1);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > LIMITS.maxShapeCells) return false;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (inside(g.offsetX + (c + 0.5) * g.cellSize, g.offsetY + (r + 0.5) * g.cellSize)) add(c, r);
      }
    }
    return true;
  };

  /** Celle attraversate da una poligonale (campionata a mezza cella). */
  const walk = (pts: readonly Point[]): boolean => {
    const step = g.cellSize / 2;
    let samples = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      samples += n + 1;
      if (samples > LIMITS.maxShapeCells) return false;
      for (let k = 0; k <= n; k++) addPoint(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n);
    }
    return true;
  };

  let ok = true;
  switch (shape.kind) {
    case "ping":
      addPoint(shape.x, shape.y);
      break;
    case "circle":
      addPoint(shape.x, shape.y);
      ok = scan(shape.x - shape.radius, shape.y - shape.radius, shape.x + shape.radius, shape.y + shape.radius, (x, y) =>
        circleContains(shape, x, y),
      );
      break;
    case "cone":
      addPoint(shape.x, shape.y);
      ok = scan(shape.x - shape.length, shape.y - shape.length, shape.x + shape.length, shape.y + shape.length, (x, y) =>
        coneContains(shape, x, y),
      );
      break;
    case "line": {
      addPoint(shape.x1, shape.y1);
      const h = shape.width / 2;
      ok = scan(
        Math.min(shape.x1, shape.x2) - h,
        Math.min(shape.y1, shape.y2) - h,
        Math.max(shape.x1, shape.x2) + h,
        Math.max(shape.y1, shape.y2) + h,
        (x, y) => lineContains(shape, x, y),
      );
      break;
    }
    case "arrow":
      ok = walk([
        { x: shape.x1, y: shape.y1 },
        { x: shape.x2, y: shape.y2 },
      ]);
      break;
    case "ruler":
      ok = walk(shape.points);
      break;
  }
  if (!ok) return null;
  return [...found.values()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .flatMap(([c, r]) => [c, r]);
}

// ---------------------------------------------------------------------------
// Misure del righello
// ---------------------------------------------------------------------------

/**
 * Regola per le diagonali: `euclid` (distanza vera), `chebyshev` (regola semplice 5e: ogni cella, anche in
 * diagonale, vale una cella) o `alternating` (5-10-5: la seconda diagonale vale due celle).
 */
export type RulerRule = "euclid" | "chebyshev" | "alternating";

/** Lunghezza di una poligonale in unità di gioco (es. piedi). */
export function rulerDistance(
  points: readonly Point[],
  cellSize: number,
  scale: Pick<Scale, "unitsPerCell">,
  rule: RulerRule = "chebyshev",
): number {
  let cells = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = Math.abs(points[i + 1]!.x - points[i]!.x) / cellSize;
    const dy = Math.abs(points[i + 1]!.y - points[i]!.y) / cellSize;
    if (rule === "euclid") cells += Math.hypot(dx, dy);
    else {
      const a = Math.round(dx);
      const b = Math.round(dy);
      cells += rule === "chebyshev" ? Math.max(a, b) : Math.max(a, b) + Math.floor(Math.min(a, b) / 2);
    }
  }
  return cells * scale.unitsPerCell;
}

/** Da unità di gioco (es. 30 ft) a pixel della mappa. */
export function unitsToPixels(units: number, cellSize: number, scale: Pick<Scale, "unitsPerCell">): number {
  return (units / scale.unitsPerCell) * cellSize;
}

// ---------------------------------------------------------------------------
// Filtro per destinatario (nebbia)
// ---------------------------------------------------------------------------

/** Tutti i punti della forma (per controllare i limiti della mappa). */
export function shapePoints(shape: Shape): Point[] {
  switch (shape.kind) {
    case "ping":
    case "circle":
    case "cone":
      return [{ x: shape.x, y: shape.y }];
    case "line":
    case "arrow":
      return [
        { x: shape.x1, y: shape.y1 },
        { x: shape.x2, y: shape.y2 },
      ];
    case "ruler":
      return shape.points;
  }
}

/**
 * Cosa può vedere `viewer` di una forma effimera disegnata su una scena.
 * - GM, o scena senza nebbia: la forma intera;
 * - giocatore con la nebbia: se TUTTE le celle coperte gli sono rivelate, la forma intera; se solo alcune,
 *   una forma `cells` con le sole celle rivelate (nessuna coordinata né misura); se nessuna, `null` (non gli
 *   si manda nulla). In caso di dubbio (forma troppo grande) `null`: meglio non mostrare che far trapelare.
 * Così un giocatore non fa arrivare ad altri nulla su celle che a loro non sono rivelate.
 */
export function shapeForViewer(
  shape: Shape,
  scene: Pick<Scene, "width" | "height">,
  fog: Fog | null,
  viewer: Actor,
): ShownShape | null {
  if (isGm(viewer) || !fog) return shape;
  const cells = shapeCells(shape, fog, scene);
  if (!cells || cells.length === 0) return null;
  const mask = maskFor(fog, viewer.userId);
  const revealed: number[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    if (isCellRevealed(mask, cells[i]!, cells[i + 1]!)) revealed.push(cells[i]!, cells[i + 1]!);
  }
  if (revealed.length === 0) return null;
  return revealed.length === cells.length ? shape : { kind: "cells", cells: revealed };
}
