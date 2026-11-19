import type { Grid, Scale, Scene } from "./schema.js";

/**
 * Aggancia il centro di un token alla griglia.
 * Token di lato dispari (1, 3, ...) si centrano nella cella; quelli di lato
 * pari (2, 4, ...) sull'incrocio delle linee. Per lati frazionari (0.5)
 * si usa il centro della cella.
 */
export function snapToGrid(x: number, y: number, sizeCells: number, grid: Grid): { x: number; y: number } {
  const half = sizeCells >= 1 && Number.isInteger(sizeCells) && sizeCells % 2 === 0 ? 0 : 0.5;
  const snap1 = (v: number, offset: number): number =>
    (Math.round((v - offset) / grid.cellSize - half) + half) * grid.cellSize + offset;
  return { x: snap1(x, grid.offsetX), y: snap1(y, grid.offsetY) };
}

/** Il punto è dentro la mappa (bordi inclusi)? */
export function isInsideScene(x: number, y: number, scene: Pick<Scene, "width" | "height">): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= scene.width && y <= scene.height;
}

/** Porta il punto dentro i limiti della mappa. */
export function clampToScene(x: number, y: number, scene: Pick<Scene, "width" | "height">): { x: number; y: number } {
  return { x: Math.min(Math.max(x, 0), scene.width), y: Math.min(Math.max(y, 0), scene.height) };
}

/** Distanza in unità di gioco tra due punti, contando le celle (regola 5e: diagonale = 1 cella). */
export function gridDistance(
  a: { x: number; y: number },
  b: { x: number; y: number },
  grid: Pick<Grid, "cellSize">,
  scale: Scale,
): number {
  const dx = Math.round(Math.abs(a.x - b.x) / grid.cellSize);
  const dy = Math.round(Math.abs(a.y - b.y) / grid.cellSize);
  return Math.max(dx, dy) * scale.unitsPerCell;
}

/** Normalizza un angolo in gradi nell'intervallo [0, 360). */
export function normalizeRotation(deg: number): number {
  const r = deg % 360;
  const n = r < 0 ? r + 360 : r;
  // -0 e arrotondamenti che riportano a 360
  return n >= 360 || Object.is(n, -0) ? 0 : n;
}
