import { CONE_ANGLE_DEG, type Shape, type ShownShape } from "@lanterna/shared";
import { distanceInUnits, formatDistance } from "./geometry";
import type { GameScale, Point, RulerMode } from "./types";

/**
 * Strumenti di misura e di segnalazione: da due punti di trascinamento alla forma da mostrare. Logica pura,
 * senza DOM ne' PixiJS. Il cono e' quello 5e (53,13 gradi: l'ampiezza alla distanza d vale d).
 */

export type MeasureTool = "ruler" | "circle" | "cone" | "line" | "arrow" | "ping";
export const MEASURE_TOOLS: readonly MeasureTool[] = ["ruler", "circle", "cone", "line", "arrow", "ping"];

export function isMeasureTool(tool: string): tool is MeasureTool {
  return (MEASURE_TOOLS as readonly string[]).includes(tool);
}

/** Lunghezza minima (pixel di mappa) sotto cui una forma trascinata non ha senso. */
const MIN_LENGTH = 2;

export const MEASURE_LABELS: Record<MeasureTool, string> = {
  ruler: "Righello",
  circle: "Cerchio",
  cone: "Cono",
  line: "Linea",
  arrow: "Freccia di intenzione",
  ping: "Segnalazione"
};

/** Angolo in gradi (0 = +x, 90 = verso il basso) normalizzato in [0, 360). */
export function directionDeg(a: Point, b: Point): number {
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return Math.round((((deg % 360) + 360) % 360) * 100) / 100;
}

/** Forma di `tool` per un trascinamento da `a` a `b`; `null` se troppo corta (il ping non ha lunghezza). */
export function measureShape(tool: MeasureTool, a: Point, b: Point, cellSize: number): Shape | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (tool === "ping") return { kind: "ping", x: a.x, y: a.y };
  if (len < MIN_LENGTH) return null;
  switch (tool) {
    case "ruler":
      return { kind: "ruler", points: [a, b] };
    case "circle":
      return { kind: "circle", x: a.x, y: a.y, radius: len };
    case "cone":
      return { kind: "cone", x: a.x, y: a.y, direction: directionDeg(a, b), length: len };
    case "line":
      // Striscia larga una cella: la larghezza tipica di una linea (es. 5 ft x 60 ft).
      return { kind: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: Math.max(1, cellSize) };
    case "arrow":
      return { kind: "arrow", x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }
}

/** Testo della misura nelle unita' di gioco della scena (es. "Cono 30 piedi"). Vuoto per freccia e ping. */
export function measureLabel(shape: Shape, cellSize: number, scale: GameScale, rulerMode: RulerMode = "euclidean"): string {
  const unit = scale.unitLabel;
  const units = (px: number) => formatDistance((px / cellSize) * scale.unitsPerCell, unit);
  switch (shape.kind) {
    case "ruler": {
      let total = 0;
      for (let i = 0; i < shape.points.length - 1; i++) total += distanceInUnits(shape.points[i]!, shape.points[i + 1]!, cellSize, scale, rulerMode);
      return formatDistance(total, unit);
    }
    case "circle":
      return `Raggio ${units(shape.radius)}`;
    case "cone":
      return `Cono ${units(shape.length)}`;
    case "line":
      return `Linea ${units(Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1))} x ${units(shape.width)}`;
    default:
      return "";
  }
}

/** Contorno di cerchio, cono e linea come poligono piatto `x, y, ...` (per disegnarlo). */
export function outlinePolygon(shape: Shape, arcSteps = 32): number[] | null {
  if (shape.kind === "circle") {
    const pts: number[] = [];
    for (let i = 0; i < arcSteps * 2; i++) {
      const t = (i / (arcSteps * 2)) * Math.PI * 2;
      pts.push(shape.x + Math.cos(t) * shape.radius, shape.y + Math.sin(t) * shape.radius);
    }
    return pts;
  }
  if (shape.kind === "cone") {
    const half = ((shape.angle ?? CONE_ANGLE_DEG) * Math.PI) / 180 / 2;
    const dir = (shape.direction * Math.PI) / 180;
    const pts = [shape.x, shape.y];
    for (let i = 0; i <= arcSteps; i++) {
      const t = dir - half + (2 * half * i) / arcSteps;
      pts.push(shape.x + Math.cos(t) * shape.length, shape.y + Math.sin(t) * shape.length);
    }
    return pts;
  }
  if (shape.kind === "line") {
    const dx = shape.x2 - shape.x1;
    const dy = shape.y2 - shape.y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (shape.width / 2);
    const ny = (dx / len) * (shape.width / 2);
    return [shape.x1 + nx, shape.y1 + ny, shape.x2 + nx, shape.y2 + ny, shape.x2 - nx, shape.y2 - ny, shape.x1 - nx, shape.y1 - ny];
  }
  return null;
}

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Celle `col, riga, ...` della griglia della nebbia come rettangoli in pixel di mappa. */
export function cellRects(cells: readonly number[], g: { cellSize: number; offsetX: number; offsetY: number }): CellRect[] {
  const out: CellRect[] = [];
  for (let i = 0; i + 1 < cells.length; i += 2) {
    out.push({ x: g.offsetX + cells[i]! * g.cellSize, y: g.offsetY + cells[i + 1]! * g.cellSize, width: g.cellSize, height: g.cellSize });
  }
  return out;
}

/** Forma ricevuta dal server: o una forma intera o le sole celle rivelate. */
export type ReceivedShape = ShownShape;

/** Opacita' di una forma effimera: piena, poi dissolvenza negli ultimi `fadeMs`. Con movimento ridotto niente dissolvenza. */
export function ephemeralAlpha(remainingMs: number, fadeMs: number, reducedMotion: boolean): number {
  if (remainingMs <= 0) return 0;
  if (reducedMotion || fadeMs <= 0) return 1;
  return Math.min(1, remainingMs / fadeMs);
}
