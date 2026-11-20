import type { GameScale, GridConfig, MapToken, Point, Rect, RulerMode, Size, Viewport } from "./types";

/* Logica pura del canvas: nessuna dipendenza da DOM o PixiJS. */

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

export function screenToMap(vp: Viewport, p: Point): Point {
  return { x: (p.x - vp.x) / vp.scale, y: (p.y - vp.y) / vp.scale };
}

export function mapToScreen(vp: Viewport, p: Point): Point {
  return { x: p.x * vp.scale + vp.x, y: p.y * vp.scale + vp.y };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return clamp(scale, min, max);
}

/** Zoom di un fattore mantenendo fermo il punto di mappa sotto `anchor` (coordinate schermo). */
export function zoomAt(vp: Viewport, anchor: Point, factor: number, min = MIN_SCALE, max = MAX_SCALE): Viewport {
  const scale = clampScale(vp.scale * factor, min, max);
  const k = scale / vp.scale;
  return { scale, x: anchor.x - (anchor.x - vp.x) * k, y: anchor.y - (anchor.y - vp.y) * k };
}

export function panBy(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, x: vp.x + dx, y: vp.y + dy };
}

/** Viewport che mostra tutta la mappa, centrata, con un margine in pixel schermo. Mai oltre `maxScale`. */
export function fitViewport(map: Size, screen: Size, padding = 24, maxScale = 1): Viewport {
  if (map.width <= 0 || map.height <= 0 || screen.width <= 0 || screen.height <= 0) return { x: 0, y: 0, scale: 1 };
  const availW = Math.max(1, screen.width - padding * 2);
  const availH = Math.max(1, screen.height - padding * 2);
  const scale = clampScale(Math.min(availW / map.width, availH / map.height, maxScale));
  return { scale, x: (screen.width - map.width * scale) / 2, y: (screen.height - map.height * scale) / 2 };
}

/**
 * Impedisce di perdere la mappa: almeno `margin` pixel schermo (o tutta la mappa, se piu' piccola)
 * devono restare visibili su ogni asse.
 */
export function clampViewport(vp: Viewport, map: Size, screen: Size, margin = 96): Viewport {
  const w = map.width * vp.scale;
  const h = map.height * vp.scale;
  const mx = Math.min(margin, w, screen.width);
  const my = Math.min(margin, h, screen.height);
  return {
    scale: vp.scale,
    x: clamp(vp.x, mx - w, screen.width - mx),
    y: clamp(vp.y, my - h, screen.height - my)
  };
}

/** Rettangolo di mappa visibile, con un margine opzionale in unita' di mappa. */
export function visibleRect(vp: Viewport, screen: Size, pad = 0): Rect {
  return {
    x: -vp.x / vp.scale - pad,
    y: -vp.y / vp.scale - pad,
    width: screen.width / vp.scale + pad * 2,
    height: screen.height / vp.scale + pad * 2
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function normalizeRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/* ---------------- griglia e snap ---------------- */

/** Aggancia un valore a un multiplo della cella (con offset). */
export function snapAxis(v: number, cell: number, offset: number): number {
  return Math.round((v - offset) / cell) * cell + offset;
}

/**
 * Posizione del centro di un token di `size` celle agganciata alla griglia: l'angolo alto-sinistro
 * cade su un incrocio, quindi un token 1x1 sta al centro di una cella, un 2x2 a cavallo di un incrocio.
 */
export function snapTokenCenter(center: Point, size: number, grid: GridConfig): Point {
  const half = (size * grid.cellSize) / 2;
  return {
    x: snapAxis(center.x - half, grid.cellSize, grid.offsetX) + half,
    y: snapAxis(center.y - half, grid.cellSize, grid.offsetY) + half
  };
}

/** Riporta un centro dentro la mappa: con lo snap lo sposta di celle intere, senza lo porta sul bordo. */
export function keepInside(p: Point, bounds: Size, cell: number): Point {
  const fit = (v: number, max: number) => {
    if (v > max) return cell > 0 ? v - Math.ceil((v - max) / cell) * cell : max;
    if (v < 0) return cell > 0 ? v + Math.ceil(-v / cell) * cell : 0;
    return v;
  };
  return { x: fit(p.x, bounds.width), y: fit(p.y, bounds.height) };
}

/**
 * Posizione finale al rilascio: agganciata se la griglia ha lo snap, altrimenti libera. Con `bounds`
 * resta sempre dentro la mappa (il server rifiuta le posizioni fuori, e un rifiuto al rilascio è un errore inutile).
 */
export function resolveDropPosition(center: Point, size: number, grid: GridConfig, bounds?: Size): Point {
  const snapped = grid.snap && grid.cellSize > 0 ? snapTokenCenter(center, size, grid) : center;
  return bounds ? keepInside(snapped, bounds, grid.snap && grid.cellSize > 0 ? grid.cellSize : 0) : snapped;
}

/** Cella di destinazione evidenziata durante il trascinamento (rettangolo di `size` x `size` celle). */
export function destinationRect(center: Point, size: number, cellSize: number): Rect {
  const side = size * cellSize;
  return { x: center.x - side / 2, y: center.y - side / 2, width: side, height: side };
}

/** Numero della cella che contiene il punto (indici interi, anche negativi). */
export function cellAt(p: Point, grid: GridConfig): { col: number; row: number } {
  return { col: Math.floor((p.x - grid.offsetX) / grid.cellSize), row: Math.floor((p.y - grid.offsetY) / grid.cellSize) };
}

/** Coordinate delle linee verticali e orizzontali che cadono in `area` (per disegnare la griglia). */
export function gridLines(area: Rect, grid: GridConfig): { xs: number[]; ys: number[] } {
  const c = grid.cellSize;
  const xs: number[] = [];
  const ys: number[] = [];
  if (!(c > 0)) return { xs, ys };
  const first = (start: number, offset: number) => Math.ceil((start - offset) / c) * c + offset;
  for (let x = first(area.x, grid.offsetX); x <= area.x + area.width; x += c) xs.push(x);
  for (let y = first(area.y, grid.offsetY); y <= area.y + area.height; y += c) ys.push(y);
  return { xs, ys };
}

/* ---------------- token ---------------- */

export function tokenRadius(token: Pick<MapToken, "size">, cellSize: number): number {
  return (token.size * cellSize) / 2;
}

/** Limiti del token piu' un margine per anello, etichetta, barra e badge (in unita' di mappa). */
export function tokenBounds(token: MapToken, cellSize: number, pad = 0): Rect {
  const r = tokenRadius(token, cellSize) + pad;
  return { x: token.x - r, y: token.y - r, width: r * 2, height: r * 2 };
}

/**
 * Token in cima sotto il punto (l'ultimo dell'elenco e' disegnato sopra). `minRadius` allarga
 * l'area per i token piccoli (utile col tocco). I token con `visible(t) === false` sono ignorati.
 */
export function hitTestToken(
  tokens: readonly MapToken[],
  p: Point,
  cellSize: number,
  minRadius = 0,
  visible: (t: MapToken) => boolean = () => true
): MapToken | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (!visible(t)) continue;
    const r = Math.max(tokenRadius(t, cellSize), minRadius);
    const dx = p.x - t.x;
    const dy = p.y - t.y;
    if (dx * dx + dy * dy <= r * r) return t;
  }
  return null;
}

/** Id dei token il cui cerchio interseca il rettangolo (selezione a rettangolo). */
export function tokensInRect(tokens: readonly MapToken[], rect: Rect, cellSize: number, visible: (t: MapToken) => boolean = () => true): string[] {
  const ids: string[] = [];
  for (const t of tokens) {
    if (!visible(t)) continue;
    const r = tokenRadius(t, cellSize);
    const nx = clamp(t.x, rect.x, rect.x + rect.width);
    const ny = clamp(t.y, rect.y, rect.y + rect.height);
    const dx = t.x - nx;
    const dy = t.y - ny;
    if (dx * dx + dy * dy <= r * r) ids.push(t.id);
  }
  return ids;
}

/** Token visibili nell'area (culling). `pad` copre gli elementi che sporgono dal cerchio. */
export function cullTokens(tokens: readonly MapToken[], area: Rect, cellSize: number, pad = 0): MapToken[] {
  return tokens.filter((t) => rectsIntersect(tokenBounds(t, cellSize, pad), area));
}

/** Un token e' disegnato (e cliccabile) se non e' nascosto oppure se si e' GM. */
export function isTokenShown(token: MapToken, role: "gm" | "player"): boolean {
  return role === "gm" || !token.hidden;
}

/* ---------------- rotazione e ridimensionamento ---------------- */

export function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Angolo in gradi (0 = verso l'alto, senso orario) della direzione centro -> punto. */
export function angleFrom(center: Point, p: Point): number {
  return normalizeDegrees((Math.atan2(p.x - center.x, -(p.y - center.y)) * 180) / Math.PI);
}

export function snapAngle(deg: number, step = 15): number {
  return normalizeDegrees(Math.round(deg / step) * step);
}

/** Nuovo lato (in celle) trascinando la maniglia a `p`: passi di mezza cella, da 0.5 a `max`. */
export function sizeFromHandle(center: Point, p: Point, cellSize: number, max = 12): number {
  const half = Math.max(Math.abs(p.x - center.x), Math.abs(p.y - center.y));
  return clamp(Math.round(((half * 2) / cellSize) * 2) / 2, 0.5, max);
}

/* ---------------- misura ---------------- */

/** Distanza in unita' di gioco. "grid" conta le diagonali come una cella (regola 5e di base). */
export function distanceInUnits(a: Point, b: Point, cellSize: number, scale: GameScale, mode: RulerMode = "euclidean"): number {
  if (!(cellSize > 0)) return 0;
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const cells = mode === "grid" ? Math.max(dx, dy) / cellSize : Math.hypot(dx, dy) / cellSize;
  return cells * scale.unitsPerCell;
}

/** Es. `12,5 piedi`: una cifra decimale al massimo, virgola italiana. */
export function formatDistance(value: number, unitLabel: string): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
  return `${text} ${unitLabel}`.trim();
}
