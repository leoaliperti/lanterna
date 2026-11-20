import type { FogLighting } from "./fog.js";
import type { Scene, Token } from "./schema.js";
import { blocksSight, type Wall } from "./walls.js";

/**
 * Linea di vista (M6): logica pura per l'AIUTO VISIVO "cosa vede questo token".
 * Non scopre MAI la nebbia: il risultato si disegna sopra la mappa, la nebbia resta
 * quella decisa dal GM. Algoritmo: raycasting verso gli estremi dei muri (più due raggi
 * appena a lato di ciascuno) e verso le intersezioni dei muri con il cerchio del raggio,
 * più un poligono regolare per l'arco del cerchio; ogni raggio si ferma al muro più
 * vicino. I muri lontani oltre il raggio vengono scartati prima (riquadro + distanza).
 */

/** Lati del poligono che approssima il cerchio del raggio di vista. */
export const VISION_CIRCLE_STEPS = 64;
const ANGLE_EPS = 1e-4;

export interface VisibilityInput {
  x: number;
  y: number;
  /** Raggio in pixel della mappa (`Infinity` = fino ai bordi della mappa). */
  radius: number;
  /** Segmenti piatti `x1, y1, x2, y2, ...` che bloccano la vista. */
  segments: ArrayLike<number>;
  width: number;
  height: number;
}

/** Distanza minima punto-segmento al quadrato. */
function distSqToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = x1 + t * dx - px;
  const ey = y1 + t * dy - py;
  return ex * ex + ey * ey;
}

/**
 * Poligono di visibilità (lista piatta `x0, y0, x1, y1, ...`, in ordine di angolo) del punto
 * `(x, y)` con i muri `segments`, limitato al raggio e alla mappa.
 */
export function computeVisibility(input: VisibilityInput): number[] {
  const { x: ox, y: oy, width, height } = input;
  const radius = Number.isFinite(input.radius) ? Math.max(0, input.radius) : Infinity;
  // Bordi della mappa come muri: ogni raggio colpisce qualcosa.
  const segs: number[] = [0, 0, width, 0, width, 0, width, height, width, height, 0, height, 0, height, 0, 0];
  const s = input.segments;
  const r2 = radius * radius;
  for (let i = 0; i + 3 < s.length; i += 4) {
    const x1 = s[i]!;
    const y1 = s[i + 1]!;
    const x2 = s[i + 2]!;
    const y2 = s[i + 3]!;
    if (radius !== Infinity) {
      // Scarto veloce: riquadro, poi distanza vera.
      if (Math.max(x1, x2) < ox - radius || Math.min(x1, x2) > ox + radius) continue;
      if (Math.max(y1, y2) < oy - radius || Math.min(y1, y2) > oy + radius) continue;
      if (distSqToSegment(ox, oy, x1, y1, x2, y2) > r2) continue;
    }
    segs.push(x1, y1, x2, y2);
  }
  const n = segs.length / 4;

  const angles: number[] = [];
  const addPoint = (px: number, py: number) => {
    const dx = px - ox;
    const dy = py - oy;
    if (radius !== Infinity && dx * dx + dy * dy > r2 * 1.0001) return;
    const a = Math.atan2(dy, dx);
    angles.push(a - ANGLE_EPS, a, a + ANGLE_EPS);
  };
  for (let i = 0; i < n; i++) {
    const x1 = segs[i * 4]!;
    const y1 = segs[i * 4 + 1]!;
    const x2 = segs[i * 4 + 2]!;
    const y2 = segs[i * 4 + 3]!;
    addPoint(x1, y1);
    addPoint(x2, y2);
    if (radius !== Infinity) {
      // Intersezioni del segmento con il cerchio: lì cambia il bordo dell'ombra.
      const dx = x2 - x1;
      const dy = y2 - y1;
      const fx = x1 - ox;
      const fy = y1 - oy;
      const a = dx * dx + dy * dy;
      const b = 2 * (fx * dx + fy * dy);
      const c = fx * fx + fy * fy - r2;
      const disc = b * b - 4 * a * c;
      if (a > 0 && disc >= 0) {
        const sq = Math.sqrt(disc);
        for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
          if (t >= 0 && t <= 1) {
            const ang = Math.atan2(y1 + t * dy - oy, x1 + t * dx - ox);
            angles.push(ang - ANGLE_EPS, ang + ANGLE_EPS);
          }
        }
      }
    }
  }
  if (radius !== Infinity) {
    for (let k = 0; k < VISION_CIRCLE_STEPS; k++) angles.push(-Math.PI + (2 * Math.PI * k) / VISION_CIRCLE_STEPS);
  }
  angles.sort((a, b) => a - b);

  const out: number[] = [];
  let lastA = Number.NaN;
  for (const a of angles) {
    if (a === lastA) continue;
    lastA = a;
    const rdx = Math.cos(a);
    const rdy = Math.sin(a);
    let best = radius;
    for (let i = 0; i < n; i++) {
      const x1 = segs[i * 4]!;
      const y1 = segs[i * 4 + 1]!;
      const sdx = segs[i * 4 + 2]! - x1;
      const sdy = segs[i * 4 + 3]! - y1;
      const den = rdx * sdy - rdy * sdx;
      if (Math.abs(den) < 1e-12) continue;
      const qx = x1 - ox;
      const qy = y1 - oy;
      const t = (qx * sdy - qy * sdx) / den; // distanza lungo il raggio
      if (t < 0 || t >= best) continue;
      const u = (qx * rdy - qy * rdx) / den; // posizione sul segmento
      if (u < 0 || u > 1) continue;
      best = t;
    }
    out.push(ox + rdx * best, oy + rdy * best);
  }
  return out;
}

/** Il punto è dentro il poligono piatto? (pari/dispari) */
export function pointInPolygon(px: number, py: number, poly: ArrayLike<number>): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2]!;
    const yi = poly[i * 2 + 1]!;
    const xj = poly[j * 2]!;
    const yj = poly[j * 2 + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Segmenti dei muri che bloccano la vista (porte aperte escluse), della scena indicata. */
export function blockingSegments(walls: readonly Wall[], sceneId: string): number[] {
  const out: number[] = [];
  for (const w of walls) if (w.sceneId === sceneId && blocksSight(w)) out.push(w.x1, w.y1, w.x2, w.y2);
  return out;
}

/** Pixel della mappa per unità di gioco. */
export const pxPerUnit = (scene: Pick<Scene, "grid" | "scale">): number => scene.grid.cellSize / scene.scale.unitsPerCell;

/**
 * Raggio di vista in pixel di un token: con luce intensa o fioca è `range` (o illimitato);
 * al buio è il massimo tra scurovisione e luce propria, comunque entro `range`.
 * Le luci degli ALTRI token si calcolano a parte con `computeLights`.
 */
export function sightRadiusPx(token: Pick<Token, "vision">, scene: Pick<Scene, "grid" | "scale">, lighting: FogLighting): number {
  const v = token.vision;
  const k = pxPerUnit(scene);
  const range = v?.range == null ? Infinity : v.range * k;
  if (lighting !== "dark") return range;
  const own = v ? Math.max(v.darkvision, v.bright + v.dim) * k : 0;
  return Math.min(range, own);
}

export interface TokenSight {
  tokenId: string;
  /** Poligono di ciò che il token vede (vuoto se cieco). */
  polygon: number[];
  radius: number;
}

export interface TokenLight {
  tokenId: string;
  /** Area di luce intensa e fino alla fine della luce fioca. */
  bright: number[];
  dim: number[];
}

/** Vista dei token indicati (aiuto visivo). */
export function computeSight(
  scene: Pick<Scene, "id" | "width" | "height" | "grid" | "scale">,
  lighting: FogLighting,
  tokens: readonly Token[],
  walls: readonly Wall[],
): TokenSight[] {
  const segments = blockingSegments(walls, scene.id);
  return tokens
    .filter((t) => t.sceneId === scene.id)
    .map((t) => {
      const radius = sightRadiusPx(t, scene, lighting);
      const polygon =
        radius > 0
          ? computeVisibility({ x: t.x, y: t.y, radius, segments, width: scene.width, height: scene.height })
          : [];
      return { tokenId: t.id, polygon, radius };
    });
}

/** Aree illuminate dai token che emettono luce. */
export function computeLights(
  scene: Pick<Scene, "id" | "width" | "height" | "grid" | "scale">,
  tokens: readonly Token[],
  walls: readonly Wall[],
): TokenLight[] {
  const segments = blockingSegments(walls, scene.id);
  const k = pxPerUnit(scene);
  const out: TokenLight[] = [];
  for (const t of tokens) {
    const v = t.vision;
    if (t.sceneId !== scene.id || !v || v.bright + v.dim <= 0) continue;
    const vis = (r: number) =>
      r > 0 ? computeVisibility({ x: t.x, y: t.y, radius: r, segments, width: scene.width, height: scene.height }) : [];
    out.push({ tokenId: t.id, bright: vis(v.bright * k), dim: vis((v.bright + v.dim) * k) });
  }
  return out;
}
