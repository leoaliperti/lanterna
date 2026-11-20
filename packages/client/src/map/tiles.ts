import { rectsIntersect } from "./geometry";
import type { Rect, Size } from "./types";

/**
 * Strategia per le mappe grandi (vedi docs/MAP.md).
 *
 * - Mappa "piccola" (lati <= limite GPU e area <= budget): una sola texture, con mipmap.
 * - Mappa grande (es. 8000x6000): una texture di panoramica ridotta (lato massimo `OVERVIEW_MAX`),
 *   sempre presente sotto, piu' tessere di `tileSize` px create solo quando entrano nello schermo
 *   e solo se lo zoom e' abbastanza alto da servire il dettaglio. Le tessere lontane sono rilasciate (LRU).
 */

/** Area massima (px) per una singola texture: 4096x4096 = 64 MB di RGBA, con mipmap ~85 MB. */
export const SINGLE_TEXTURE_PIXEL_BUDGET = 4096 * 4096;
export const DEFAULT_TILE_SIZE = 2048;
export const OVERVIEW_MAX = 2048;
/** Numero massimo di tessere di dettaglio in memoria (16 x 16 MB = 256 MB nel caso peggiore). */
export const MAX_LOADED_TILES = 16;

export type BackgroundPlan =
  | { mode: "single"; width: number; height: number }
  | { mode: "tiled"; width: number; height: number; tileSize: number; cols: number; rows: number; overview: Size; overviewScale: number };

export interface TileId {
  col: number;
  row: number;
  key: string;
}

export function planBackground(size: Size, maxTextureSize: number, tileSize = DEFAULT_TILE_SIZE): BackgroundPlan {
  const { width, height } = size;
  const limit = Math.max(256, maxTextureSize);
  if (width <= limit && height <= limit && width * height <= SINGLE_TEXTURE_PIXEL_BUDGET) {
    return { mode: "single", width, height };
  }
  const tile = Math.min(tileSize, limit);
  const overviewScale = Math.min(1, OVERVIEW_MAX / Math.max(width, height));
  return {
    mode: "tiled",
    width,
    height,
    tileSize: tile,
    cols: Math.ceil(width / tile),
    rows: Math.ceil(height / tile),
    overview: { width: Math.max(1, Math.round(width * overviewScale)), height: Math.max(1, Math.round(height * overviewScale)) },
    overviewScale
  };
}

export function tileKey(col: number, row: number): string {
  return `${col}:${row}`;
}

/** Rettangolo sorgente della tessera in pixel dell'immagine (l'ultima di riga/colonna e' piu' piccola). */
export function tileRect(plan: Extract<BackgroundPlan, { mode: "tiled" }>, col: number, row: number): Rect {
  const x = col * plan.tileSize;
  const y = row * plan.tileSize;
  return { x, y, width: Math.min(plan.tileSize, plan.width - x), height: Math.min(plan.tileSize, plan.height - y) };
}

/** Tessere che intersecano l'area visibile (coordinate di mappa). */
export function visibleTiles(plan: Extract<BackgroundPlan, { mode: "tiled" }>, area: Rect): TileId[] {
  const c0 = Math.max(0, Math.floor(area.x / plan.tileSize));
  const c1 = Math.min(plan.cols - 1, Math.floor((area.x + area.width) / plan.tileSize));
  const r0 = Math.max(0, Math.floor(area.y / plan.tileSize));
  const r1 = Math.min(plan.rows - 1, Math.floor((area.y + area.height) / plan.tileSize));
  const out: TileId[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (rectsIntersect(tileRect(plan, col, row), area)) out.push({ col, row, key: tileKey(col, row) });
    }
  }
  return out;
}

/**
 * Serve il dettaglio? La panoramica ha `overviewScale` texel per pixel di mappa: finche' lo zoom
 * non la supera (con un po' di tolleranza) la panoramica basta e non si caricano tessere.
 */
export function needsDetail(plan: BackgroundPlan, viewScale: number, dpr = 1): boolean {
  if (plan.mode === "single") return false;
  return viewScale * dpr > plan.overviewScale * 1.25;
}

/** Tessere da rilasciare: quelle non visibili, le meno recenti per prime, fino a restare entro `cap`. */
export function tilesToEvict(loaded: ReadonlyMap<string, number>, visibleKeys: ReadonlySet<string>, cap = MAX_LOADED_TILES): string[] {
  if (loaded.size <= cap) return [];
  const evictable = [...loaded.entries()].filter(([key]) => !visibleKeys.has(key)).sort((a, b) => a[1] - b[1]);
  return evictable.slice(0, loaded.size - cap).map(([key]) => key);
}
