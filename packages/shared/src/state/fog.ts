import { z } from "zod";
import { IdSchema, LIMITS } from "./limits.js";

/**
 * Nebbia di guerra (M6): logica pura sulle maschere per giocatore.
 *
 * Rappresentazione (vedi docs/FOG.md):
 * - la nebbia di una scena ha una propria **griglia di celle** (`cellSize`, `offsetX`, `offsetY`),
 *   copiata dalla griglia della scena quando la nebbia viene attivata e poi indipendente;
 *   la cella (c, r) copre `[ox + c*cs, ox + (c+1)*cs) x [oy + r*cs, oy + (r+1)*cs)`;
 * - una **maschera** è `{ base, runs }`: `base` è lo stato di tutte le celle ("covered" o
 *   "revealed") tranne le eccezioni in `runs`, una lista piatta di terne
 *   `[riga, colonnaIniziale, colonnaFinale)` ordinate e fuse (forma canonica, quindi due maschere
 *   uguali hanno lo stesso JSON). Una stanza rettangolare rivelata costa una terna per riga;
 *   "rivela tutto" e "copri tutto" costano zero terne;
 * - `everyone` è la maschera di chi non ne ha una propria (anche i giocatori aggiunti dopo);
 *   `players` contiene solo le maschere diverse da `everyone`.
 */

export const FogStateSchema = z.enum(["covered", "revealed"]);
export type FogBase = z.infer<typeof FogStateSchema>;

export const FogLightingSchema = z.enum(["bright", "dim", "dark"]);
export type FogLighting = z.infer<typeof FogLightingSchema>;

/** Indici di cella ammessi (una mappa da 20000 px con celle da 4 px ha 5000 celle per lato). */
export const FOG_CELL_MIN = -1;
export const FOG_CELL_MAX = Math.ceil(LIMITS.sceneMaxSize / LIMITS.cellMinSize) + 1;

const cellIndex = z.number().int().min(FOG_CELL_MIN).max(FOG_CELL_MAX + 1);

/** Le terne sono in forma canonica? (ordinate per riga e colonna, non vuote, non sovrapposte né adiacenti). */
export function isCanonicalRuns(runs: readonly number[]): boolean {
  if (runs.length % 3 !== 0) return false;
  for (let i = 0; i < runs.length; i += 3) {
    const r = runs[i]!;
    const a = runs[i + 1]!;
    const b = runs[i + 2]!;
    if (!(b > a)) return false;
    if (i > 0) {
      const pr = runs[i - 3]!;
      const pb = runs[i - 1]!;
      if (r < pr || (r === pr && a <= pb)) return false;
    }
  }
  return true;
}

export const FogMaskSchema = z.strictObject({
  base: FogStateSchema,
  runs: z
    .array(cellIndex)
    .max(LIMITS.fogMaxRuns * 3)
    .refine(isCanonicalRuns, { message: "maschera non canonica" }),
});
export type FogMask = z.infer<typeof FogMaskSchema>;

const fogCellSize = z.number().min(LIMITS.cellMinSize).max(LIMITS.cellMaxSize);

export const FogGeometrySchema = z
  .strictObject({ cellSize: fogCellSize, offsetX: z.number(), offsetY: z.number() })
  .refine((g) => Math.abs(g.offsetX) < g.cellSize && Math.abs(g.offsetY) < g.cellSize, {
    message: "l'offset deve essere minore della cella",
  });
export type FogGeometry = z.infer<typeof FogGeometrySchema>;

export const PlayerMaskSchema = z.strictObject({ userId: IdSchema, mask: FogMaskSchema });
export type PlayerMask = z.infer<typeof PlayerMaskSchema>;

export const FogSchema = z
  .strictObject({
    sceneId: IdSchema,
    cellSize: fogCellSize,
    offsetX: z.number(),
    offsetY: z.number(),
    /** Luce ambientale della scena: serve solo all'aiuto visivo (vista dei token). */
    lighting: FogLightingSchema,
    /** Maschera di tutti i giocatori che non ne hanno una propria. */
    everyone: FogMaskSchema,
    /** Maschere dei singoli giocatori, ordinate per `userId`, solo se diverse da `everyone`. */
    players: z.array(PlayerMaskSchema).max(LIMITS.fogMaxPlayers),
  })
  .refine((f) => Math.abs(f.offsetX) < f.cellSize && Math.abs(f.offsetY) < f.cellSize, {
    message: "l'offset deve essere minore della cella",
  })
  .refine((f) => f.players.every((p, i) => i === 0 || f.players[i - 1]!.userId < p.userId), {
    message: "maschere dei giocatori non ordinate o duplicate",
  });
export type Fog = z.infer<typeof FogSchema>;

/** Forme con cui il GM rivela o copre. Una cella è dentro la forma se il suo CENTRO lo è (bordi inclusi). */
const finite = z.number().refine(Number.isFinite, "numero non finito");
export const FogShapeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("rect"), x: finite, y: finite, width: finite.min(0), height: finite.min(0) }),
  z.strictObject({ kind: z.literal("circle"), x: finite, y: finite, radius: finite.min(0) }),
  z.strictObject({
    kind: z.literal("polygon"),
    /** Coordinate piatte `x0, y0, x1, y1, ...` (da 3 a `fogMaxPolygonPoints` vertici). */
    points: z
      .array(finite)
      .min(6)
      .max(LIMITS.fogMaxPolygonPoints * 2)
      .refine((p) => p.length % 2 === 0, "numero dispari di coordinate"),
  }),
  z.strictObject({
    kind: z.literal("cells"),
    /** Coppie piatte `colonna, riga` della griglia della nebbia. */
    cells: z
      .array(cellIndex)
      .min(2)
      .max(LIMITS.fogMaxCells * 2)
      .refine((p) => p.length % 2 === 0, "numero dispari di indici"),
  }),
]);
export type FogShape = z.infer<typeof FogShapeSchema>;

/** A chi si applica una rivelazione/copertura: tutti (anche i giocatori futuri) o giocatori scelti. */
export const FogTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({
    kind: z.literal("players"),
    userIds: z
      .array(IdSchema)
      .min(1)
      .max(LIMITS.fogMaxPlayers)
      .refine((ids) => new Set(ids).size === ids.length, "giocatori duplicati"),
  }),
]);
export type FogTarget = z.infer<typeof FogTargetSchema>;

// ---------------------------------------------------------------------------
// Operazioni sulle terne (insiemi di celle per righe)
// ---------------------------------------------------------------------------

type Interval = [number, number];

function rowsOf(runs: readonly number[]): Map<number, Interval[]> {
  const m = new Map<number, Interval[]>();
  for (let i = 0; i < runs.length; i += 3) {
    const r = runs[i]!;
    let list = m.get(r);
    if (!list) m.set(r, (list = []));
    list.push([runs[i + 1]!, runs[i + 2]!]);
  }
  return m;
}

function mergeIntervals(list: Interval[]): Interval[] {
  if (list.length <= 1) return list;
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

function subtractIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let j = 0;
  for (const [a0, a1] of a) {
    let start = a0;
    while (j < b.length && b[j]![1] <= start) j++;
    let k = j;
    while (k < b.length && b[k]![0] < a1) {
      const [b0, b1] = b[k]!;
      if (b0 > start) out.push([start, Math.min(b0, a1)]);
      start = Math.max(start, b1);
      if (start >= a1) break;
      k++;
    }
    if (start < a1) out.push([start, a1]);
  }
  return out;
}

function toRuns(rows: Map<number, Interval[]>): number[] {
  const out: number[] = [];
  for (const r of [...rows.keys()].sort((x, y) => x - y)) {
    for (const [a, b] of rows.get(r)!) if (b > a) out.push(r, a, b);
  }
  return out;
}

/** Forma canonica di terne qualsiasi (anche disordinate o sovrapposte). */
export function normalizeRuns(runs: readonly number[]): number[] {
  const rows = rowsOf(runs);
  for (const [r, list] of rows) rows.set(r, mergeIntervals(list.filter(([a, b]) => b > a)));
  return toRuns(rows);
}

export function unionRuns(a: readonly number[], b: readonly number[]): number[] {
  if (b.length === 0) return [...a];
  if (a.length === 0) return normalizeRuns(b);
  return normalizeRuns([...a, ...b]);
}

export function subtractRuns(a: readonly number[], b: readonly number[]): number[] {
  if (a.length === 0 || b.length === 0) return [...a];
  const ra = rowsOf(a);
  const rb = rowsOf(normalizeRuns(b));
  for (const [r, list] of ra) {
    const sub = rb.get(r);
    if (sub) ra.set(r, subtractIntervals(list, sub));
  }
  return toRuns(ra);
}

/** Numero di terne (per i limiti). */
export const runCount = (runs: readonly number[]): number => runs.length / 3;

// ---------------------------------------------------------------------------
// Maschere
// ---------------------------------------------------------------------------

export const COVERED_MASK: FogMask = { base: "covered", runs: [] };
export const REVEALED_MASK: FogMask = { base: "revealed", runs: [] };

export function maskReveal(mask: FogMask, cells: readonly number[]): FogMask {
  return mask.base === "covered"
    ? { base: "covered", runs: unionRuns(mask.runs, cells) }
    : { base: "revealed", runs: subtractRuns(mask.runs, cells) };
}

export function maskCover(mask: FogMask, cells: readonly number[]): FogMask {
  return mask.base === "covered"
    ? { base: "covered", runs: subtractRuns(mask.runs, cells) }
    : { base: "revealed", runs: unionRuns(mask.runs, cells) };
}

export function masksEqual(a: FogMask, b: FogMask): boolean {
  if (a.base !== b.base || a.runs.length !== b.runs.length) return false;
  for (let i = 0; i < a.runs.length; i++) if (a.runs[i] !== b.runs[i]) return false;
  return true;
}

/** Maschera effettiva di un giocatore. */
export function maskFor(fog: Fog, userId: string): FogMask {
  return fog.players.find((p) => p.userId === userId)?.mask ?? fog.everyone;
}

/** Indice della prima terna della riga `r` (ricerca binaria), o -1. */
function firstRunOfRow(runs: readonly number[], r: number): number {
  let lo = 0;
  let hi = runs.length / 3;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid * 3]! < r) lo = mid + 1;
    else hi = mid;
  }
  return lo < runs.length / 3 && runs[lo * 3] === r ? lo * 3 : -1;
}

function inRuns(runs: readonly number[], c: number, r: number): boolean {
  let i = firstRunOfRow(runs, r);
  if (i < 0) return false;
  for (; i < runs.length && runs[i] === r; i += 3) {
    if (c < runs[i + 1]!) return false;
    if (c < runs[i + 2]!) return true;
  }
  return false;
}

export function isCellRevealed(mask: FogMask, c: number, r: number): boolean {
  return inRuns(mask.runs, c, r) !== (mask.base === "revealed");
}

/** Le colonne `[c0, c1)` della riga `r` sono tutte coperte dalle terne? */
function rowFullyInRuns(runs: readonly number[], r: number, c0: number, c1: number): boolean {
  let i = firstRunOfRow(runs, r);
  if (i < 0) return false;
  let pos = c0;
  for (; i < runs.length && runs[i] === r; i += 3) {
    const a = runs[i + 1]!;
    const b = runs[i + 2]!;
    if (b <= pos) continue;
    if (a > pos) return false;
    pos = b;
    if (pos >= c1) return true;
  }
  return pos >= c1;
}

/** Le colonne `[c0, c1)` della riga `r` toccano le terne? */
function rowTouchesRuns(runs: readonly number[], r: number, c0: number, c1: number): boolean {
  let i = firstRunOfRow(runs, r);
  if (i < 0) return false;
  for (; i < runs.length && runs[i] === r; i += 3) {
    if (runs[i + 1]! < c1 && runs[i + 2]! > c0) return true;
  }
  return false;
}

/** Almeno una cella del rettangolo di celle `[c0, c1) x [r0, r1)` è rivelata? */
export function anyCellRevealed(mask: FogMask, c0: number, r0: number, c1: number, r1: number): boolean {
  if (c1 <= c0 || r1 <= r0) return false;
  if (mask.base === "covered") {
    if (mask.runs.length === 0) return false;
    for (let r = r0; r < r1; r++) if (rowTouchesRuns(mask.runs, r, c0, c1)) return true;
    return false;
  }
  if (mask.runs.length === 0) return true;
  for (let r = r0; r < r1; r++) if (!rowFullyInRuns(mask.runs, r, c0, c1)) return true;
  return false;
}

/** Tutte le celle del rettangolo sono rivelate? */
export function allCellsRevealed(mask: FogMask, c0: number, r0: number, c1: number, r1: number): boolean {
  if (c1 <= c0 || r1 <= r0) return true;
  // "tutte rivelate" = nessuna coperta = la maschera complementare non ne rivela nessuna.
  const inverse: FogMask = { base: mask.base === "covered" ? "revealed" : "covered", runs: mask.runs };
  return !anyCellRevealed(inverse, c0, r0, c1, r1);
}

// ---------------------------------------------------------------------------
// Geometria: da coordinate mappa a celle
// ---------------------------------------------------------------------------

/** Margine per i confronti sui bordi (pixel mappa). */
const EPS = 1e-6;

export const cellCol = (g: FogGeometry, x: number): number => Math.floor((x - g.offsetX) / g.cellSize);
export const cellRow = (g: FogGeometry, y: number): number => Math.floor((y - g.offsetY) / g.cellSize);

/** Celle che intersecano (con area non nulla) il rettangolo `[x0, x1] x [y0, y1]`, come `[c0, r0, c1, r1)`. */
export function cellRangeOfRect(
  g: FogGeometry,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number, number, number] {
  const c0 = Math.floor((x0 - g.offsetX) / g.cellSize + EPS);
  const r0 = Math.floor((y0 - g.offsetY) / g.cellSize + EPS);
  const c1 = Math.ceil((x1 - g.offsetX) / g.cellSize - EPS);
  const r1 = Math.ceil((y1 - g.offsetY) / g.cellSize - EPS);
  return [c0, r0, Math.max(c0 + 1, c1), Math.max(r0 + 1, r1)];
}

/** Celle della scena (quelle che intersecano la mappa `[0, w] x [0, h]`). */
export function sceneCellRange(g: FogGeometry, width: number, height: number): [number, number, number, number] {
  return cellRangeOfRect(g, 0, 0, width, height);
}

/** Intervallo di colonne `[a, b)` i cui centri cadono in `[x0, x1]`. */
function colsWithCenterIn(g: FogGeometry, x0: number, x1: number): Interval {
  const a = Math.ceil((x0 - g.offsetX) / g.cellSize - 0.5 - EPS);
  const b = Math.floor((x1 - g.offsetX) / g.cellSize - 0.5 + EPS) + 1;
  return [a, b];
}

const centerY = (g: FogGeometry, r: number): number => g.offsetY + (r + 0.5) * g.cellSize;

/**
 * Celle di una forma (terne canoniche), limitate alle celle della scena.
 * Regola: una cella appartiene alla forma se il suo centro è dentro la forma (bordi inclusi).
 */
export function rasterizeShape(shape: FogShape, g: FogGeometry, width: number, height: number): number[] {
  const [sc0, sr0, sc1, sr1] = sceneCellRange(g, width, height);
  const out: number[] = [];
  const push = (r: number, a: number, b: number) => {
    const lo = Math.max(a, sc0);
    const hi = Math.min(b, sc1);
    if (r >= sr0 && r < sr1 && hi > lo) out.push(r, lo, hi);
  };
  const rowsFor = (y0: number, y1: number): Interval => {
    const a = Math.ceil((y0 - g.offsetY) / g.cellSize - 0.5 - EPS);
    const b = Math.floor((y1 - g.offsetY) / g.cellSize - 0.5 + EPS) + 1;
    return [Math.max(a, sr0), Math.min(b, sr1)];
  };
  switch (shape.kind) {
    case "rect": {
      const [ra, rb] = rowsFor(shape.y, shape.y + shape.height);
      const [a, b] = colsWithCenterIn(g, shape.x, shape.x + shape.width);
      for (let r = ra; r < rb; r++) push(r, a, b);
      return normalizeRuns(out);
    }
    case "circle": {
      const [ra, rb] = rowsFor(shape.y - shape.radius, shape.y + shape.radius);
      for (let r = ra; r < rb; r++) {
        const dy = centerY(g, r) - shape.y;
        const h2 = shape.radius * shape.radius - dy * dy;
        if (h2 < 0) continue;
        const half = Math.sqrt(h2);
        const [a, b] = colsWithCenterIn(g, shape.x - half, shape.x + half);
        push(r, a, b);
      }
      return normalizeRuns(out);
    }
    case "polygon": {
      const p = shape.points;
      const n = p.length / 2;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 1; i < p.length; i += 2) {
        minY = Math.min(minY, p[i]!);
        maxY = Math.max(maxY, p[i]!);
      }
      const [ra, rb] = rowsFor(minY, maxY);
      for (let r = ra; r < rb; r++) {
        const y = centerY(g, r);
        // Scansione per righe con la regola pari/dispari.
        const xs: number[] = [];
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = p[i * 2]!;
          const yi = p[i * 2 + 1]!;
          const xj = p[j * 2]!;
          const yj = p[j * 2 + 1]!;
          if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const [a, b] = colsWithCenterIn(g, xs[k]!, xs[k + 1]!);
          push(r, a, b);
        }
      }
      return normalizeRuns(out);
    }
    case "cells": {
      for (let i = 0; i < shape.cells.length; i += 2) push(shape.cells[i + 1]!, shape.cells[i]!, shape.cells[i]! + 1);
      return normalizeRuns(out);
    }
  }
}

/**
 * Il rettangolo in coordinate mappa tocca almeno una cella rivelata?
 * Usato per i token: un token è visibile se una qualsiasi cella sotto la sua impronta è rivelata.
 */
export function rectRevealed(mask: FogMask, g: FogGeometry, x0: number, y0: number, x1: number, y1: number): boolean {
  const [c0, r0, c1, r1] = cellRangeOfRect(g, x0, y0, x1, y1);
  return anyCellRevealed(mask, c0, r0, c1, r1);
}

// ---------------------------------------------------------------------------
// Tessere della mappa (servite dal server per giocatore)
// ---------------------------------------------------------------------------

/** Lato di una tessera della mappa in pixel della scena. */
export const FOG_TILE_SIZE = 512;

export interface TileGrid {
  size: number;
  cols: number;
  rows: number;
}

export function tileGrid(width: number, height: number, size = FOG_TILE_SIZE): TileGrid {
  return { size, cols: Math.ceil(width / size), rows: Math.ceil(height / size) };
}

/** Rettangolo della tessera (col, row) in coordinate della scena, già limitato alla mappa. */
export function tileRect(
  col: number,
  row: number,
  width: number,
  height: number,
  size = FOG_TILE_SIZE,
): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: col * size,
    y0: row * size,
    x1: Math.min((col + 1) * size, width),
    y1: Math.min((row + 1) * size, height),
  };
}

/** Stato di una tessera per una maschera: nessuna cella rivelata, alcune o tutte. */
export function tileCoverage(
  mask: FogMask,
  g: FogGeometry,
  col: number,
  row: number,
  width: number,
  height: number,
  size = FOG_TILE_SIZE,
): "none" | "partial" | "full" {
  const t = tileRect(col, row, width, height, size);
  if (t.x1 <= t.x0 || t.y1 <= t.y0) return "none";
  const [c0, r0, c1, r1] = cellRangeOfRect(g, t.x0, t.y0, t.x1, t.y1);
  if (!anyCellRevealed(mask, c0, r0, c1, r1)) return "none";
  return allCellsRevealed(mask, c0, r0, c1, r1) ? "full" : "partial";
}

/**
 * Chiave stabile della parte rivelata di una tessera (per ETag e cache): la stessa chiave se e
 * solo se le celle rivelate sotto la tessera sono le stesse.
 */
export function tileCoverageKey(
  mask: FogMask,
  g: FogGeometry,
  col: number,
  row: number,
  width: number,
  height: number,
  size = FOG_TILE_SIZE,
): string {
  const t = tileRect(col, row, width, height, size);
  const [c0, r0, c1, r1] = cellRangeOfRect(g, t.x0, t.y0, t.x1, t.y1);
  let bits = "";
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) bits += isCellRevealed(mask, c, r) ? "1" : "0";
  return `${g.cellSize}:${g.offsetX}:${g.offsetY}:${c0}:${r0}:${c1}:${r1}:${fnv1a(bits)}`;
}

/** FNV-1a a 32 bit in esadecimale: impronta NON crittografica (chiavi di cache). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
