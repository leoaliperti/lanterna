import {
  FOG_CELL_MAX,
  FOG_CELL_MIN,
  LIMITS,
  cellCol,
  cellRow,
  isCellRevealed,
  rasterizeShape,
  sceneCellRange,
  tileCoverage,
  tileCoverageKey,
  tileRect,
  type Command,
  type FogGeometry,
  type FogMask,
  type FogShape,
  type FogTarget,
  type FogView
} from "@lanterna/shared";

/**
 * Logica pura della nebbia nel client (senza DOM ne' Pixi): conversioni punto/cella, forme del pennello,
 * comandi, maschera da disegnare, tessere della mappa. La nebbia vera la decide il server: qui si
 * costruiscono solo comandi e si preparano i dati da mostrare.
 */

export type FogMode = "reveal" | "cover";
export type FogBrush = "rect" | "circle" | "polygon" | "cells";

export interface Pt {
  x: number;
  y: number;
}

/* ---------------- conversioni punto <-> cella ---------------- */

export function geometryOf(fog: Pick<FogView, "cellSize" | "offsetX" | "offsetY">): FogGeometry {
  return { cellSize: fog.cellSize, offsetX: fog.offsetX, offsetY: fog.offsetY };
}

/** Cella (colonna, riga) che contiene il punto di mappa. */
export function cellAt(g: FogGeometry, p: Pt): [number, number] {
  return [cellCol(g, p.x), cellRow(g, p.y)];
}

/** Rettangolo di mappa di una cella. */
export function cellBox(g: FogGeometry, c: number, r: number): { x: number; y: number; width: number; height: number } {
  return { x: g.offsetX + c * g.cellSize, y: g.offsetY + r * g.cellSize, width: g.cellSize, height: g.cellSize };
}

/** Centro di una cella. */
export function cellCenter(g: FogGeometry, c: number, r: number): Pt {
  return { x: g.offsetX + (c + 0.5) * g.cellSize, y: g.offsetY + (r + 0.5) * g.cellSize };
}

/** Aggancia un punto agli incroci della griglia della nebbia. */
export function snapToCorner(g: FogGeometry, p: Pt): Pt {
  return {
    x: g.offsetX + Math.round((p.x - g.offsetX) / g.cellSize) * g.cellSize,
    y: g.offsetY + Math.round((p.y - g.offsetY) / g.cellSize) * g.cellSize
  };
}

/** Aggancia un punto al centro della cella che lo contiene. */
export function snapToCenter(g: FogGeometry, p: Pt): Pt {
  const [c, r] = cellAt(g, p);
  return cellCenter(g, c, r);
}

/** La cella e' dentro la mappa `width x height`? */
export function cellInScene(g: FogGeometry, width: number, height: number, c: number, r: number): boolean {
  const [c0, r0, c1, r1] = sceneCellRange(g, width, height);
  return c >= c0 && c < c1 && r >= r0 && r < r1;
}

/* ---------------- forme del pennello ---------------- */

/** Rettangolo fra due angoli; con `snap` gli angoli cadono sulle linee della griglia. Un clic (area quasi nulla) vale la cella cliccata. */
export function rectShape(g: FogGeometry, a: Pt, b: Pt, snap = true): FogShape {
  const pa = snap ? snapToCorner(g, a) : a;
  const pb = snap ? snapToCorner(g, b) : b;
  const x = Math.min(pa.x, pb.x);
  const y = Math.min(pa.y, pb.y);
  const width = Math.abs(pa.x - pb.x);
  const height = Math.abs(pa.y - pb.y);
  if (snap && (width < g.cellSize * 0.5 || height < g.cellSize * 0.5)) {
    const [c, r] = cellAt(g, a);
    return { kind: "cells", cells: [c, r] };
  }
  return { kind: "rect", x, y, width, height };
}

/** Cerchio con centro al centro cella (con `snap`) e raggio al mezzo passo di cella; un clic vale la cella cliccata. */
export function circleShape(g: FogGeometry, center: Pt, edge: Pt, snap = true): FogShape {
  const c = snap ? snapToCenter(g, center) : center;
  const raw = Math.hypot(edge.x - c.x, edge.y - c.y);
  if (snap && raw < g.cellSize * 0.5) {
    const [col, row] = cellAt(g, center);
    return { kind: "cells", cells: [col, row] };
  }
  const half = g.cellSize / 2;
  const radius = snap ? Math.max(half, Math.round(raw / half) * half) : raw;
  return { kind: "circle", x: c.x, y: c.y, radius };
}

/** Poligono dai vertici; meno di tre vertici non e' una forma. */
export function polygonShape(points: readonly Pt[]): FogShape | null {
  if (points.length < 3) return null;
  const flat = points.slice(0, LIMITS.fogMaxPolygonPoints).flatMap((p) => [p.x, p.y]);
  return { kind: "polygon", points: flat };
}

/** Celle toccate dal segmento a-b (percorso del pennello a celle), senza ripetizioni consecutive. */
export function cellsAlongSegment(g: FogGeometry, a: Pt, b: Pt): Array<[number, number]> {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / (g.cellSize / 3)));
  const out: Array<[number, number]> = [];
  let last = "";
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [c, r] = cellAt(g, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const key = `${c},${r}`;
    if (key !== last) {
      out.push([c, r]);
      last = key;
    }
  }
  return out;
}

/** Percorso a celle: accumula celle uniche (massimo `fogMaxCells`) restando dentro la mappa. */
export class CellPath {
  private seen = new Set<string>();
  private flat: number[] = [];
  private last: Pt | null = null;
  constructor(
    private g: FogGeometry,
    private width: number,
    private height: number
  ) {}

  get full(): boolean {
    return this.flat.length / 2 >= LIMITS.fogMaxCells;
  }
  get count(): number {
    return this.flat.length / 2;
  }

  add(p: Pt): void {
    const from = this.last ?? p;
    this.last = p;
    for (const [c, r] of cellsAlongSegment(this.g, from, p)) {
      if (this.full) return;
      if (c < FOG_CELL_MIN || c > FOG_CELL_MAX || !cellInScene(this.g, this.width, this.height, c, r)) continue;
      const k = `${c},${r}`;
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      this.flat.push(c, r);
    }
  }

  shape(): FogShape | null {
    return this.flat.length >= 2 ? { kind: "cells", cells: [...this.flat] } : null;
  }
}

/** Celle (terne canoniche) che una forma coprirebbe o rivelerebbe: serve all'anteprima prima del rilascio. */
export function previewRuns(shape: FogShape, g: FogGeometry, width: number, height: number): number[] {
  return rasterizeShape(shape, g, width, height);
}

/* ---------------- destinatari e comandi ---------------- */

/** Nessun giocatore scelto = tutti. */
export function fogTarget(userIds: readonly string[]): FogTarget {
  return userIds.length === 0 ? { kind: "all" } : { kind: "players", userIds: [...userIds] };
}

export function fogShapeCommand(mode: FogMode, sceneId: string, shape: FogShape, target: FogTarget): Command {
  return { type: mode === "reveal" ? "fog.reveal" : "fog.cover", sceneId, shape, target };
}

export function fogAllCommand(mode: FogMode, sceneId: string, target: FogTarget): Command {
  return { type: mode === "reveal" ? "fog.revealAll" : "fog.coverAll", sceneId, target };
}

/** Riassunto dei destinatari per etichette e annunci ("Tutti", "Luca", "Luca e Sara", "3 giocatori"). */
export function describeTarget(userIds: readonly string[], names: ReadonlyMap<string, string>): string {
  if (userIds.length === 0) return "Tutti";
  const list = userIds.map((id) => names.get(id) ?? "giocatore");
  if (list.length === 1) return list[0]!;
  if (list.length === 2) return `${list[0]} e ${list[1]}`;
  return `${list.length} giocatori`;
}

/* ---------------- maschera da disegnare ---------------- */

/** Maschera che il GM sta controllando: "tutti" oppure la maschera di un giocatore. */
export function viewMask(fog: Pick<FogView, "mask" | "players">, viewAs: string | null): FogMask {
  if (!viewAs) return fog.mask;
  return fog.players?.find((p) => p.userId === viewAs)?.mask ?? fog.mask;
}

/** Celle di una maschera nel rettangolo di celle `[c0, c1) x [r0, r1)`: 255 = coperta, 0 = rivelata (riga per riga). */
export function coveredBitmap(mask: FogMask, c0: number, r0: number, c1: number, r1: number): Uint8Array {
  const cols = Math.max(0, c1 - c0);
  const rows = Math.max(0, r1 - r0);
  const out = new Uint8Array(cols * rows);
  const coveredBase = mask.base === "covered";
  if (coveredBase) out.fill(255);
  // Le terne sono le eccezioni alla base: si scrivono con il valore opposto.
  const value = coveredBase ? 0 : 255;
  for (let i = 0; i < mask.runs.length; i += 3) {
    const r = mask.runs[i]! - r0;
    if (r < 0 || r >= rows) continue;
    const a = Math.max(0, mask.runs[i + 1]! - c0);
    const b = Math.min(cols, mask.runs[i + 2]! - c0);
    if (b > a) out.fill(value, r * cols + a, r * cols + b);
  }
  return out;
}

/** Quante celle rivelate ci sono nella scena (per annunci e riepiloghi). */
export function revealedCount(mask: FogMask, g: FogGeometry, width: number, height: number): number {
  const [c0, r0, c1, r1] = sceneCellRange(g, width, height);
  const bm = coveredBitmap(mask, c0, r0, c1, r1);
  let n = 0;
  for (const v of bm) if (v === 0) n++;
  return n;
}

export { isCellRevealed };

/* ---------------- tessere della mappa (giocatore) ---------------- */

export interface TileItem {
  /** `col,row` */
  id: string;
  col: number;
  row: number;
  /** Posizione e dimensione in pixel della scena. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Cambia se cambia la copertura della tessera o la mappa: serve a decidere cosa ricaricare. */
  key: string;
  url: string;
}

export interface TileSource {
  size: number;
  cols: number;
  rows: number;
  /** `FogView.tiles.key` */
  key: string;
}

/**
 * Tessere da caricare: solo quelle con almeno una cella rivelata alla maschera (le altre il server le
 * rifiuterebbe con 404). `urlOf` costruisce l'URL; la chiave di copertura va nell'URL per scavalcare la cache.
 */
export function availableTiles(
  tiles: TileSource,
  mask: FogMask,
  g: FogGeometry,
  width: number,
  height: number,
  urlOf: (col: number, row: number, coverageKey: string) => string
): TileItem[] {
  const out: TileItem[] = [];
  for (let row = 0; row < tiles.rows; row++) {
    for (let col = 0; col < tiles.cols; col++) {
      if (tileCoverage(mask, g, col, row, width, height, tiles.size) === "none") continue;
      const coverage = tileCoverageKey(mask, g, col, row, width, height, tiles.size);
      const rect = tileRect(col, row, width, height, tiles.size);
      out.push({
        id: `${col},${row}`,
        col,
        row,
        x: rect.x0,
        y: rect.y0,
        width: rect.x1 - rect.x0,
        height: rect.y1 - rect.y0,
        key: `${tiles.key}|${coverage}`,
        url: urlOf(col, row, coverage)
      });
    }
  }
  return out;
}

export interface TileDiff<T extends { id: string; key: string } = TileItem> {
  /** Da scaricare: nuove o con copertura cambiata. */
  load: T[];
  /** Id da togliere: non servono piu'. */
  remove: string[];
}

/** Confronta le tessere gia' caricate (id -> chiave) con quelle volute. */
export function diffTiles<T extends { id: string; key: string }>(loaded: ReadonlyMap<string, string>, wanted: readonly T[]): TileDiff<T> {
  const want = new Set(wanted.map((t) => t.id));
  return {
    load: wanted.filter((t) => loaded.get(t.id) !== t.key),
    remove: [...loaded.keys()].filter((id) => !want.has(id))
  };
}

/** URL di una tessera: stessa regola di `assetUrl` (cookie di sessione, sotto /api). */
export function tileUrl(apiBase: string, campaignId: string, sceneId: string, col: number, row: number, coverageKey: string): string {
  return `${apiBase}/campaigns/${encodeURIComponent(campaignId)}/scenes/${encodeURIComponent(sceneId)}/tiles/${col}/${row}?k=${encodeURIComponent(coverageKey)}`;
}
