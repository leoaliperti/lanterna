import { computeVisibility, fnv1a, sightRadiusPx, type FogLighting, type Scene, type TokenVision } from "@lanterna/shared";

/**
 * Aiuto visivo "cosa vede questo token": ricalcolo SELETTIVO del poligono di visibilita'.
 * Non tocca mai la nebbia. Un token si ricalcola solo se e' cambiato qualcosa che lo riguarda
 * (posizione, raggio, luce) o se sono cambiati i muri o la scena; il lavoro per passata e' limitato
 * da un budget in millisecondi: i token rimasti indietro restano con il vecchio poligono e si
 * completano alla passata successiva (`pending`).
 */

export type SightScene = Pick<Scene, "id" | "width" | "height" | "grid" | "scale">;

export interface SightToken {
  id: string;
  x: number;
  y: number;
  vision?: TokenVision | null | undefined;
}

export interface SightArea {
  tokenId: string;
  /** Poligono di cio' che il token vede (vuoto se cieco). */
  polygon: readonly number[];
  /** Luce emessa (solo se il token ne ha): intensa e fino a fioca. */
  light: { bright: readonly number[]; dim: readonly number[] } | null;
}

export interface SightStats {
  /** Quanti token sono stati ricalcolati in questa passata. */
  recomputed: number;
  /** Token ancora da aggiornare (budget esaurito). */
  pending: number;
  ms: number;
}

interface Entry {
  key: string;
  area: SightArea;
}

export const DEFAULT_SIGHT_BUDGET_MS = 6;

/** Impronta dei muri che bloccano la vista (cambia solo se cambiano davvero). */
export function segmentsKey(segments: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < segments.length; i++) s += `${segments[i]},`;
  return `${segments.length}:${fnv1a(s)}`;
}

export class SightEngine {
  private cache = new Map<string, Entry>();
  private sceneKey = "";
  private lastAreas: SightArea[] = [];
  private lastSignature = "";
  /** Orologio sostituibile nei test. */
  constructor(private now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now())) {}

  /**
   * Calcola (o riusa) le aree di vista dei token. Restituisce lo STESSO array di prima se nulla e' cambiato,
   * cosi' il chiamante puo' evitare un nuovo render con un confronto per riferimento.
   */
  compute(
    scene: SightScene,
    lighting: FogLighting,
    tokens: readonly SightToken[],
    segments: ArrayLike<number>,
    budgetMs = DEFAULT_SIGHT_BUDGET_MS
  ): { areas: SightArea[]; stats: SightStats } {
    const t0 = this.now();
    const wallsKey = segmentsKey(segments);
    const sceneKey = `${scene.id}|${scene.width}|${scene.height}|${scene.grid.cellSize}|${scene.scale.unitsPerCell}|${lighting}|${wallsKey}`;
    if (sceneKey !== this.sceneKey) {
      // Muri, scena o luce ambientale diversi: i vecchi poligoni non valgono piu'.
      this.sceneKey = sceneKey;
      this.cache.clear();
    }
    const withVision = tokens.filter((t) => t.vision);
    const alive = new Set(withVision.map((t) => t.id));
    for (const id of [...this.cache.keys()]) if (!alive.has(id)) this.cache.delete(id);

    let recomputed = 0;
    let pending = 0;
    const areas: SightArea[] = [];
    let signature = "";
    for (const t of withVision) {
      const v = t.vision!;
      const radius = sightRadiusPx(t, scene, lighting);
      const k = (scene.grid.cellSize || 1) / (scene.scale.unitsPerCell || 1);
      const key = `${t.x}|${t.y}|${radius}|${v.bright}|${v.dim}`;
      const hit = this.cache.get(t.id);
      if (hit && hit.key === key) {
        areas.push(hit.area);
        signature += `${t.id}@${key};`;
        continue;
      }
      // Budget esaurito (ma almeno un token per passata): si tiene il vecchio poligono e si rimanda.
      if (recomputed > 0 && this.now() - t0 > budgetMs) {
        pending++;
        if (hit) areas.push(hit.area);
        signature += `${t.id}@old;`;
        continue;
      }
      const vis = (r: number) =>
        r > 0 ? computeVisibility({ x: t.x, y: t.y, radius: r, segments, width: scene.width, height: scene.height }) : [];
      const area: SightArea = {
        tokenId: t.id,
        polygon: vis(radius),
        light: v.bright + v.dim > 0 ? { bright: vis(v.bright * k), dim: vis((v.bright + v.dim) * k) } : null
      };
      this.cache.set(t.id, { key, area });
      areas.push(area);
      signature += `${t.id}@${key};`;
      recomputed++;
    }
    const ms = this.now() - t0;
    if (signature === this.lastSignature && areas.length === this.lastAreas.length && areas.every((a, i) => a === this.lastAreas[i])) {
      return { areas: this.lastAreas, stats: { recomputed, pending, ms } };
    }
    this.lastSignature = signature;
    this.lastAreas = areas;
    return { areas, stats: { recomputed, pending, ms } };
  }

  /** Token con un poligono in cache (per i test). */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Spezza una linea chiusa o aperta in tratti `dash` / spazi `gap`, per disegnare il contorno tratteggiato
 * (Pixi non ha linee tratteggiate). Ritorna segmenti piatti `x1, y1, x2, y2, ...`.
 */
export function dashedSegments(points: ArrayLike<number>, dash: number, gap: number, closed = true): number[] {
  const out: number[] = [];
  const n = Math.floor(points.length / 2);
  if (n < 2 || dash <= 0) return out;
  const period = dash + gap;
  let phase = 0; // posizione dentro il periodo corrente
  const total = closed ? n : n - 1;
  for (let i = 0; i < total; i++) {
    const x1 = points[i * 2]!;
    const y1 = points[i * 2 + 1]!;
    const j = (i + 1) % n;
    const x2 = points[j * 2]!;
    const y2 = points[j * 2 + 1]!;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len === 0) continue;
    let pos = 0;
    while (pos < len) {
      const inDash = phase < dash;
      const room = (inDash ? dash : period) - phase;
      const step = Math.min(room, len - pos);
      if (inDash) {
        const a = pos / len;
        const b = (pos + step) / len;
        out.push(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a, x1 + (x2 - x1) * b, y1 + (y2 - y1) * b);
      }
      pos += step;
      phase += step;
      if (phase >= period - 1e-9) phase = 0;
    }
  }
  return out;
}
