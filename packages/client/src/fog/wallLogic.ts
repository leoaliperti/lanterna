import type { Command, WallPatch } from "@lanterna/shared";
import type { Pt } from "./fogLogic";

/**
 * Logica pura di muri e porte: aggancio agli incroci della griglia, ricerca del muro sotto il puntatore,
 * comandi. Il server verifica sempre (estremi dentro la mappa, lunghezza non nulla, solo GM).
 */

export interface GridLike {
  cellSize: number;
  offsetX: number;
  offsetY: number;
}

/** Muro disegnabile: il GM riceve un solo segmento (`segments` = x1, y1, x2, y2). */
export interface WallLike {
  id: string;
  door: boolean;
  open: boolean;
  segments: readonly number[];
}

export type WallSnap = "grid" | "half" | "free";

/** Aggancia un punto agli incroci della griglia ("grid"), ai mezzi passi ("half") o lo lascia libero. */
export function snapVertex(p: Pt, grid: GridLike, mode: WallSnap): Pt {
  if (mode === "free" || !(grid.cellSize > 0)) return p;
  const step = mode === "half" ? grid.cellSize / 2 : grid.cellSize;
  return {
    x: grid.offsetX + Math.round((p.x - grid.offsetX) / step) * step,
    y: grid.offsetY + Math.round((p.y - grid.offsetY) / step) * step
  };
}

/** Tiene il punto dentro la mappa (il server rifiuta estremi fuori). */
export function clampToMap(p: Pt, width: number, height: number): Pt {
  return { x: Math.min(width, Math.max(0, p.x)), y: Math.min(height, Math.max(0, p.y)) };
}

export function distanceToSegment(p: Pt, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / len)) : 0;
  return Math.hypot(x1 + t * dx - p.x, y1 + t * dy - p.y);
}

export type WallPart = "a" | "b" | "body";

export interface WallHit {
  wall: WallLike;
  part: WallPart;
}

/**
 * Muro sotto il punto entro `tolerance` (unita' di mappa). Gli estremi hanno la precedenza sul corpo;
 * a parita' vince il piu' vicino. `only` limita la ricerca (es. solo le porte).
 */
export function hitWall(walls: readonly WallLike[], p: Pt, tolerance: number, only?: (w: WallLike) => boolean): WallHit | null {
  let best: { hit: WallHit; d: number } | null = null;
  for (const w of walls) {
    if (only && !only(w)) continue;
    const [x1, y1, x2, y2] = [w.segments[0], w.segments[1], w.segments[2], w.segments[3]];
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) continue;
    const da = Math.hypot(p.x - x1, p.y - y1);
    const db = Math.hypot(p.x - x2, p.y - y2);
    let candidate: { hit: WallHit; d: number } | null = null;
    if (da <= tolerance && da <= db) candidate = { hit: { wall: w, part: "a" }, d: da - tolerance };
    else if (db <= tolerance) candidate = { hit: { wall: w, part: "b" }, d: db - tolerance };
    else {
      const d = distanceToSegment(p, x1, y1, x2, y2);
      if (d <= tolerance) candidate = { hit: { wall: w, part: "body" }, d };
    }
    if (candidate && (!best || candidate.d < best.d)) best = candidate;
  }
  return best?.hit ?? null;
}

/** I due estremi coincidono? (il server rifiuta i muri di lunghezza nulla) */
export const isDegenerate = (a: Pt, b: Pt): boolean => a.x === b.x && a.y === b.y;

export function wallAddCommand(id: string, sceneId: string, a: Pt, b: Pt, door: boolean): Command | null {
  if (isDegenerate(a, b)) return null;
  return { type: "wall.add", wall: { id, sceneId, x1: a.x, y1: a.y, x2: b.x, y2: b.y, door, open: false } };
}

export function wallUpdateCommand(wallId: string, patch: WallPatch): Command {
  return { type: "wall.update", wallId, patch };
}

export function wallRemoveCommand(wallId: string): Command {
  return { type: "wall.remove", wallId };
}

/** Patch per spostare un estremo; `null` se il muro diventerebbe un punto. */
export function moveEndpointPatch(w: WallLike, part: "a" | "b", to: Pt): WallPatch | null {
  const [x1, y1, x2, y2] = [w.segments[0]!, w.segments[1]!, w.segments[2]!, w.segments[3]!];
  const next = part === "a" ? { x1: to.x, y1: to.y, x2, y2 } : { x1, y1, x2: to.x, y2: to.y };
  if (next.x1 === next.x2 && next.y1 === next.y2) return null;
  return next;
}

/** Segmenti che bloccano la vista (porte aperte escluse), come lista piatta per `computeVisibility`. */
export function blockingOf(walls: readonly WallLike[]): number[] {
  const out: number[] = [];
  for (const w of walls) if (!(w.door && w.open)) for (let i = 0; i + 3 < w.segments.length; i += 4) out.push(w.segments[i]!, w.segments[i + 1]!, w.segments[i + 2]!, w.segments[i + 3]!);
  return out;
}
