/** Tipi pubblici del canvas della mappa. Tutte le coordinate di mappa sono in pixel dell'immagine di sfondo. */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Trasformazione mappa -> schermo: `schermo = mappa * scale + (x, y)`, in pixel CSS. */
export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export interface MapBackground {
  url: string;
  /** Dimensioni native dell'immagine in pixel. */
  width: number;
  height: number;
}

export interface GridConfig {
  /** Lato della cella in pixel di mappa. */
  cellSize: number;
  /** Colore CSS (`#rrggbb`). */
  color: string;
  /** 0..1 */
  opacity: number;
  offsetX: number;
  offsetY: number;
  /** Se attivo, i token si agganciano alla cella al rilascio. */
  snap: boolean;
  /** Se false la griglia non viene disegnata (lo snap resta quello di `snap`). Default true. */
  visible?: boolean;
}

export interface GameScale {
  unitsPerCell: number;
  /** Es. "piedi", "m". */
  unitLabel: string;
}

export type TokenKind = "character" | "npc" | "monster" | "object";

export interface TokenCondition {
  id: string;
  /** Nome leggibile (accessibilita', tooltip). */
  label: string;
  /** Glifo breve disegnato nel badge (una o due lettere o un emoji). Default: iniziale dell'etichetta. */
  icon?: string;
  /** Colore del badge (`#rrggbb`). */
  color?: string;
}

export interface TokenHealth {
  current: number;
  max: number;
  temp?: number;
}

export interface MapToken {
  id: string;
  /** Centro del token, in pixel di mappa. */
  x: number;
  y: number;
  /** Lato in celle (0.5, 1, 2, 3...). */
  size: number;
  /** Gradi, senso orario. */
  rotation: number;
  imageUrl?: string;
  /** Colore di riempimento (`#rrggbb`) usato senza immagine. */
  color?: string;
  label?: string;
  kind: TokenKind;
  hidden?: boolean;
  conditions?: readonly TokenCondition[];
  /** Mostrata solo se il padre la fornisce (il server la invia solo a GM e proprietario). */
  health?: TokenHealth;
}

export type MapRole = "gm" | "player";

export type RulerMode = "euclidean" | "grid";

/** Parte "dati" delle props: tutto cio' che descrive la scena. */
export interface MapScene {
  background: MapBackground;
  grid: GridConfig;
  scale: GameScale;
  tokens: readonly MapToken[];
  role: MapRole;
  /** Token che l'utente corrente puo' spostare (il server rifiuta comunque gli altri). */
  movableTokenIds: readonly string[];
  /** Misura del righello: Euclidea (default) o a griglia (diagonali = cella, come in 5e). */
  rulerMode?: RulerMode;
}

export interface MapHandlers {
  /** Al rilascio, con la posizione del centro gia' agganciata alla cella se `grid.snap`. */
  onMoveToken?: (id: string, x: number, y: number) => void;
  /** Solo GM. `size` in celle. */
  onResizeToken?: (id: string, size: number) => void;
  /** Solo GM. Gradi 0..360. */
  onRotateToken?: (id: string, rotation: number) => void;
  onSelectionChange?: (ids: readonly string[]) => void;
  onViewportChange?: (viewport: Viewport) => void;
}
