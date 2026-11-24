import type { FogMask, FogShape, WallPatch } from "@lanterna/shared";
import type { FogMode } from "../fog/fogLogic";

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
/** Forma del token: cerchio di default. */
export type TokenShape = "circle" | "square" | "diamond" | "hexagon" | "triangle";

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
  /** Forma (assente = cerchio). */
  shape?: TokenShape;
  /** Numero da mostrare sul token (assente o null = nessuno). */
  number?: number | null;
  hidden?: boolean;
  conditions?: readonly TokenCondition[];
  /** Mostrata solo se il padre la fornisce (il server la invia solo a GM e proprietario). */
  health?: TokenHealth;
}

export type MapRole = "gm" | "player";

/** Tessera della mappa servita dal server (solo giocatori, scene con nebbia). */
export interface MapTile {
  /** `col,row` */
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Cambia quando cambia la copertura: la tessera si ricarica. */
  key: string;
  url: string;
}

/** Nebbia da disegnare. Il canvas non decide nulla: mostra la maschera che il padre gli passa. */
export interface MapFog {
  sceneId: string;
  /** Griglia della nebbia (indipendente da quella della scena). */
  geometry: { cellSize: number; offsetX: number; offsetY: number };
  /** Maschera da disegnare: quella del giocatore, oppure per il GM quella che sta controllando. `null` = nessun velo. */
  mask: FogMask | null;
  /** Giocatore: velo opaco. GM: velo in trasparenza. */
  opaque: boolean;
  /** Tessere da mostrare come sfondo (giocatore). Vuoto per il GM, che ha la mappa intera. */
  tiles: readonly MapTile[];
}

/** Muro o porta: il GM riceve un solo segmento, il giocatore i pezzi nelle celle rivelate. */
export interface MapWall {
  id: string;
  door: boolean;
  open: boolean;
  /** `x1, y1, x2, y2, ...` */
  segments: readonly number[];
}

/** Aiuto visivo: area vista da un token (non modifica la nebbia). */
export interface MapSight {
  tokenId: string;
  polygon: readonly number[];
  light: { bright: readonly number[]; dim: readonly number[] } | null;
}

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
  /** Nebbia di guerra (assente = scena senza nebbia). */
  fog?: MapFog | null;
  walls?: readonly MapWall[];
  /** Mostra i muri (il GM puo' nasconderli). Default true. */
  wallsVisible?: boolean;
  /** Aiuto visivo della vista dei token. Assente = nascosto. */
  sight?: readonly MapSight[];
  /** Token sotto il puntatore: solo lì si vedono le condizioni (badge). */
  hoverTokenId?: string | null;
  /** Misura del righello: Euclidea (default) o a griglia (diagonali = cella, come in 5e). */
  rulerMode?: RulerMode;
}

export interface MapHandlers {
  /** Token sotto il puntatore (o `null`): il controller lo comunica alla vista per mostrare i badge. */
  onHoverToken?: (id: string | null) => void;
  /** Al rilascio, con la posizione del centro gia' agganciata alla cella se `grid.snap`. */
  onMoveToken?: (id: string, x: number, y: number) => void;
  /** Solo GM. `size` in celle. */
  onResizeToken?: (id: string, size: number) => void;
  /** Solo GM. Gradi 0..360. */
  onRotateToken?: (id: string, rotation: number) => void;
  onSelectionChange?: (ids: readonly string[]) => void;
  onViewportChange?: (viewport: Viewport) => void;
  /** Solo GM: il pennello della nebbia e' stato rilasciato. */
  onFogShape?: (shape: FogShape, mode: FogMode) => void;
  /** Solo GM: nuovo muro o porta (estremi gia' agganciati). */
  onWallAdd?: (a: Point, b: Point, door: boolean) => void;
  /** Solo GM: modifica di un muro (estremo spostato, porta aperta/chiusa). */
  onWallUpdate?: (id: string, patch: WallPatch) => void;
  onWallRemove?: (id: string) => void;
  /** Muro selezionato nello strumento muri (`null` = nessuno). */
  onWallSelect?: (id: string | null) => void;
}
