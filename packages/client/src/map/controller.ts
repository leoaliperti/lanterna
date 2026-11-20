import {
  angleFrom, clampViewport, destinationRect, distanceInUnits, fitViewport, formatDistance, hitTestToken, isTokenShown,
  normalizeDegrees, normalizeRect, resolveDropPosition, screenToMap, sizeFromHandle, snapAngle, snapAxis, tokenRadius,
  tokensInRect, zoomAt
} from "./geometry";
import { DrawTools, type WallMode } from "./drawTools";
import type { FogBrush, FogMode } from "../fog/fogLogic";
import { isMeasureTool, measureLabel, measureShape, type MeasureTool } from "./measure";
import type { Shape } from "@lanterna/shared";
import type { MapHandlers, MapScene, MapToken, Point, Rect, Size, Viewport } from "./types";

/**
 * Stato e interazioni della mappa, senza DOM ne' PixiJS: riceve eventi di puntatore gia' in
 * coordinate del canvas (pixel CSS) e produce stato osservabile. Non modifica mai i dati: dopo il
 * rilascio chiama la callback e l'anteprima sparisce ("il server decide").
 */

export interface PointerInput {
  id: number;
  /** "mouse" | "touch" | "pen" */
  type: string;
  button: number;
  x: number;
  y: number;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
}

export type Tool = "select" | MeasureTool | "fog" | "wall";

/** Stato degli strumenti GM, per la barra fuori dal canvas. */
export interface ToolState {
  tool: Tool;
  fogBrush: FogBrush;
  fogMode: FogMode;
  wallMode: WallMode;
}

export interface RulerState {
  a: Point;
  b: Point;
  text: string;
}

/** Forma di misura in costruzione (cerchio, cono, linea, freccia) con il suo testo. */
export interface ShapeDraft {
  shape: Shape;
  text: string;
}

export interface HandlePositions {
  tokenId: string;
  rotate: Point;
  resize: Point;
}

const DRAG_THRESHOLD_MOUSE = 4;
const DRAG_THRESHOLD_TOUCH = 8;
/** Raggio minimo (px schermo) per afferrare token e maniglie: 22 = bersaglio da 44. */
const MIN_HIT_SCREEN = 22;
const KEY_PAN = 64;
/** Pressione prolungata (touch) che apre il menu contestuale di un token. */
const LONG_PRESS_MS = 500;

type Gesture =
  | { kind: "pan"; id: number; x: number; y: number; moved: boolean; clearOnTap: boolean }
  | { kind: "token"; id: number; start: Point; grabbed: string; wasSelected: boolean; additive: boolean; started: boolean; longPressed?: boolean; origins: Map<string, Point> }
  | { kind: "marquee"; id: number; start: Point; additive: boolean; base: Set<string>; started: boolean }
  | { kind: "ruler"; id: number }
  | { kind: "measure"; id: number; tool: MeasureTool; start: Point }
  | { kind: "rotate"; id: number; tokenId: string }
  | { kind: "resize"; id: number; tokenId: string }
  | { kind: "draw"; id: number; tool: "fog" | "wall" }
  | { kind: "doorTap"; id: number; wallId: string; start: Point }
  | { kind: "pinch" };

export class MapController {
  handlers: MapHandlers = {};
  onInvalidate: () => void = () => {};
  onCursor: (cursor: string) => void = () => {};
  onRuler: (text: string | null) => void = () => {};
  onTool: (tool: Tool) => void = () => {};
  /** Cambia qualcosa negli strumenti GM (strumento, pennello, modo): la barra si aggiorna. */
  onToolState: (state: ToolState) => void = () => {};

  scene: MapScene | null = null;
  size: Size = { width: 0, height: 0 };
  viewport: Viewport = { x: 0, y: 0, scale: 1 };
  selection = new Set<string>();
  tool: Tool = "select";
  /** Anteprima di trascinamento: centro finale (gia' agganciato) per ogni token. */
  preview = new Map<string, Point>();
  /** Celle di destinazione evidenziate (coordinate di mappa), solo con snap. */
  previewCells: Rect[] = [];
  /** Anteprima di maniglia: nuovo lato o rotazione per un token. */
  handlePreview: { id: string; size?: number; rotation?: number } | null = null;
  /** Rettangolo di selezione in coordinate schermo. */
  marquee: Rect | null = null;
  ruler: RulerState | null = null;
  /** Cerchio, cono, linea o freccia in costruzione. */
  shapeDraft: ShapeDraft | null = null;

  /** Pennelli della nebbia e muri (solo GM). */
  readonly draw = new DrawTools({
    scene: () => this.scene,
    scale: () => this.viewport.scale,
    handlers: () => this.handlers,
    invalidate: () => this.invalidate()
  });

  private pointers = new Map<number, Point>();
  private gesture: Gesture | null = null;
  private spaceDown = false;
  private fitted = false;
  private viewportQueued = false;
  private tokensById = new Map<string, MapToken>();
  private defaultViewport: Viewport | null = null;
  private longPress: ReturnType<typeof setTimeout> | null = null;

  /** Viewport iniziale opzionale (altrimenti si adatta la mappa allo schermo alla prima misura). */
  init(defaultViewport?: Viewport) {
    this.defaultViewport = defaultViewport ?? null;
    if (defaultViewport) {
      this.viewport = defaultViewport;
      this.fitted = true;
    }
  }

  /* ---------------- dati ---------------- */

  setScene(scene: MapScene) {
    const prev = this.scene;
    this.scene = scene;
    this.tokensById = new Map(scene.tokens.map((t) => [t.id, t]));
    const backgroundChanged = !prev || prev.background.url !== scene.background.url || prev.background.width !== scene.background.width || prev.background.height !== scene.background.height;
    if (backgroundChanged && !this.defaultViewport) this.fitted = false;
    this.tryFit();
    // Selezione: via i token spariti o non piu' visibili a questo ruolo.
    const gone = [...this.selection].filter((id) => {
      const t = this.tokensById.get(id);
      return !t || !isTokenShown(t, scene.role);
    });
    if (gone.length) {
      gone.forEach((id) => this.selection.delete(id));
      this.emitSelection();
    }
    const g = this.gesture;
    if (g && (g.kind === "token" || g.kind === "rotate" || g.kind === "resize")) {
      const id = g.kind === "token" ? g.grabbed : g.tokenId;
      if (!this.tokensById.has(id) || (g.kind !== "token" && scene.role !== "gm")) this.cancelGesture();
    }
    this.draw.sync();
    if ((this.tool === "fog" && !scene.fog) || ((this.tool === "fog" || this.tool === "wall") && scene.role !== "gm")) this.setTool("select");
    this.invalidate();
  }

  setSize(width: number, height: number) {
    this.size = { width, height };
    this.tryFit();
    this.invalidate();
  }

  /** Selezione impostata dall'esterno (elenco dei bersagli, gruppi): solo token visibili a questo ruolo. */
  setSelection(ids: readonly string[]) {
    const next = new Set(ids.filter((id) => {
      const t = this.tokensById.get(id);
      return !!t && this.scene !== null && isTokenShown(t, this.scene.role);
    }));
    if (next.size === this.selection.size && [...next].every((id) => this.selection.has(id))) return;
    this.selection = next;
    this.emitSelection();
  }

  get toolState(): ToolState {
    return { tool: this.tool, fogBrush: this.draw.fogBrush, fogMode: this.draw.fogMode, wallMode: this.draw.wallMode };
  }

  setFogBrush(brush: FogBrush) {
    this.draw.setFogBrush(brush);
    this.onToolState(this.toolState);
  }

  setFogMode(mode: FogMode) {
    this.draw.setFogMode(mode);
    this.onToolState(this.toolState);
  }

  setWallMode(mode: WallMode) {
    this.draw.setWallMode(mode);
    this.onToolState(this.toolState);
  }

  setTool(tool: Tool) {
    if ((tool === "fog" || tool === "wall") && (this.scene?.role !== "gm" || (tool === "fog" && !this.scene.fog))) return;
    if (this.tool === tool) return;
    this.tool = tool;
    this.onTool(tool);
    this.onToolState(this.toolState);
    if (tool !== "fog" && tool !== "wall") {
      this.draw.cancel();
      this.draw.select(null);
    } else this.draw.cancel();
    if (tool !== "ruler") this.clearRuler();
    if (!isMeasureTool(tool) || tool === "ruler") this.clearShapeDraft();
    else if (this.shapeDraft && this.shapeDraft.shape.kind !== tool) this.clearShapeDraft();
    this.updateCursor();
    this.invalidate();
  }

  /* ---------------- viewport ---------------- */

  private tryFit() {
    if (this.fitted || !this.scene || this.size.width <= 0 || this.size.height <= 0) return;
    this.fitted = true;
    this.setViewport(fitViewport(this.scene.background, this.size));
  }

  fit() {
    if (this.scene) this.setViewport(fitViewport(this.scene.background, this.size));
  }

  setViewport(vp: Viewport) {
    const next = this.scene ? clampViewport(vp, this.scene.background, this.size) : vp;
    if (next.x === this.viewport.x && next.y === this.viewport.y && next.scale === this.viewport.scale) return;
    this.viewport = next;
    if (!this.viewportQueued) {
      this.viewportQueued = true;
      queueMicrotask(() => {
        this.viewportQueued = false;
        this.handlers.onViewportChange?.(this.viewport);
      });
    }
    this.invalidate();
  }

  zoomBy(factor: number, anchor: Point = { x: this.size.width / 2, y: this.size.height / 2 }) {
    this.setViewport(zoomAt(this.viewport, anchor, factor));
  }

  /* ---------------- helper di scena ---------------- */

  private get cell(): number {
    return this.scene?.grid.cellSize ?? 0;
  }

  private shown = (t: MapToken): boolean => (this.scene ? isTokenShown(t, this.scene.role) : false);

  private canMove(id: string): boolean {
    return !!this.scene && this.scene.movableTokenIds.includes(id) && this.tokensById.has(id);
  }

  private toMap(p: Point): Point {
    return screenToMap(this.viewport, p);
  }

  /** Maniglie di rotazione e ridimensionamento: solo GM con un singolo token selezionato. */
  handles(): HandlePositions | null {
    if (!this.scene || this.scene.role !== "gm" || this.selection.size !== 1) return null;
    const id = [...this.selection][0]!;
    const t = this.tokensById.get(id);
    if (!t) return null;
    const size = this.handlePreview?.id === id && this.handlePreview.size !== undefined ? this.handlePreview.size : t.size;
    const rotation = this.handlePreview?.id === id && this.handlePreview.rotation !== undefined ? this.handlePreview.rotation : t.rotation;
    const r = tokenRadius({ size }, this.cell);
    const dist = r + (MIN_HIT_SCREEN * 1.1) / this.viewport.scale;
    const a = (rotation * Math.PI) / 180;
    return {
      tokenId: id,
      rotate: { x: t.x + Math.sin(a) * dist, y: t.y - Math.cos(a) * dist },
      resize: { x: t.x + r, y: t.y + r }
    };
  }

  private hitHandle(mapPoint: Point): "rotate" | "resize" | null {
    const h = this.handles();
    if (!h) return null;
    const reach = (MIN_HIT_SCREEN / this.viewport.scale) ** 2;
    const d2 = (p: Point) => (p.x - mapPoint.x) ** 2 + (p.y - mapPoint.y) ** 2;
    if (d2(h.rotate) <= reach) return "rotate";
    if (d2(h.resize) <= reach) return "resize";
    return null;
  }

  private hitToken(mapPoint: Point): MapToken | null {
    if (!this.scene) return null;
    return hitTestToken(this.scene.tokens, mapPoint, this.cell, MIN_HIT_SCREEN / this.viewport.scale, this.shown);
  }

  /* ---------------- puntatore ---------------- */

  pointerDown(e: PointerInput) {
    const p = { x: e.x, y: e.y };
    this.pointers.set(e.id, p);
    if (this.pointers.size === 2) {
      this.cancelGesture();
      this.gesture = { kind: "pinch" };
      this.updateCursor();
      return;
    }
    if (this.pointers.size > 2 || this.gesture || !this.scene) return;

    const touchLike = e.type !== "mouse";
    if (e.button === 2) {
      const hit = this.hitToken(this.toMap(p));
      if (hit && !this.selection.has(hit.id)) {
        this.selection = new Set([hit.id]);
        this.emitSelection();
      }
      this.handlers.onContextMenu?.(e.x, e.y, hit?.id ?? null);
      return;
    }
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.gesture = { kind: "pan", id: e.id, x: e.x, y: e.y, moved: false, clearOnTap: false };
    } else if (e.button === 0) {
      const m = this.toMap(p);
      if ((this.tool === "fog" || this.tool === "wall") && this.scene.role === "gm") {
        if (this.draw.begin(this.tool, e, m)) this.gesture = { kind: "draw", id: e.id, tool: this.tool };
        else if (touchLike) this.gesture = { kind: "pan", id: e.id, x: e.x, y: e.y, moved: false, clearOnTap: false };
      } else if (this.tool === "ruler") {
        this.clearShapeDraft();
        this.gesture = { kind: "ruler", id: e.id };
        const a = this.rulerPoint(m);
        this.setRuler(a, a);
      } else if (isMeasureTool(this.tool)) {
        this.clearRuler();
        this.clearShapeDraft();
        this.gesture = { kind: "measure", id: e.id, tool: this.tool, start: m };
        if (this.tool === "ping") {
          const shape = measureShape("ping", m, m, this.cell);
          if (shape) this.handlers.onShape?.(shape, "end");
        }
      } else {
        const handle = this.hitHandle(m);
        const hit = handle ? null : this.hitToken(m);
        if (handle) {
          const tokenId = this.handles()!.tokenId;
          this.gesture = { kind: handle, id: e.id, tokenId };
        } else if (hit) {
          const additive = !!(e.shift || e.ctrl || e.meta);
          const wasSelected = this.selection.has(hit.id);
          if (!additive && !wasSelected) {
            this.selection = new Set([hit.id]);
            this.emitSelection();
          }
          this.gesture = { kind: "token", id: e.id, start: p, grabbed: hit.id, wasSelected, additive, started: false, origins: new Map() };
          if (touchLike) {
            this.longPress = setTimeout(() => {
              this.longPress = null;
              const g = this.gesture;
              if (g?.kind !== "token" || g.started || g.id !== e.id) return;
              g.longPressed = true;
              this.handlers.onContextMenu?.(p.x, p.y, g.grabbed);
            }, LONG_PRESS_MS);
          }
        } else if (this.scene.role === "gm" && this.scene.wallsVisible !== false && this.draw.doorAt(m)) {
          // Un clic su una porta la apre o la chiude (anche con lo strumento di selezione).
          this.gesture = { kind: "doorTap", id: e.id, wallId: this.draw.doorAt(m)!.id, start: p };
        } else if (touchLike) {
          this.gesture = { kind: "pan", id: e.id, x: e.x, y: e.y, moved: false, clearOnTap: true };
        } else {
          const additive = !!(e.shift || e.ctrl || e.meta);
          this.gesture = { kind: "marquee", id: e.id, start: p, additive, base: new Set(additive ? this.selection : []), started: false };
        }
      }
    }
    this.updateCursor();
    this.invalidate();
  }

  pointerMove(e: PointerInput) {
    const prev = this.pointers.get(e.id);
    const p = { x: e.x, y: e.y };
    if (prev) this.pointers.set(e.id, p);
    const g = this.gesture;
    if (!g && this.scene && this.scene.role === "gm" && (this.tool === "fog" || this.tool === "wall")) {
      this.draw.move(this.tool, e, this.toMap(p));
      return;
    }
    if (!g || !this.scene) return;

    if (g.kind === "pinch") {
      if (!prev || this.pointers.size < 2) return;
      const other = [...this.pointers.entries()].find(([id]) => id !== e.id)?.[1];
      if (!other) return;
      const oldDist = Math.hypot(prev.x - other.x, prev.y - other.y);
      const newDist = Math.hypot(p.x - other.x, p.y - other.y);
      const oldCenter = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
      const newCenter = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 };
      let vp = this.viewport;
      if (oldDist > 0 && newDist > 0) vp = zoomAt(vp, oldCenter, newDist / oldDist);
      this.setViewport({ ...vp, x: vp.x + newCenter.x - oldCenter.x, y: vp.y + newCenter.y - oldCenter.y });
      return;
    }
    if (g.id !== e.id) return;

    switch (g.kind) {
      case "draw":
        this.draw.move(g.tool, e, this.toMap(p));
        break;
      case "doorTap":
        break;
      case "pan": {
        const dx = e.x - g.x;
        const dy = e.y - g.y;
        if (!g.moved && Math.hypot(dx, dy) < 2) return;
        g.moved = true;
        g.x = e.x;
        g.y = e.y;
        this.setViewport({ ...this.viewport, x: this.viewport.x + dx, y: this.viewport.y + dy });
        break;
      }
      case "token": {
        const threshold = e.type === "mouse" ? DRAG_THRESHOLD_MOUSE : DRAG_THRESHOLD_TOUCH;
        if (!g.started) {
          if (Math.hypot(e.x - g.start.x, e.y - g.start.y) < threshold) return;
          if (!this.canMove(g.grabbed)) return; // selezionabile ma non spostabile da questo utente
          g.started = true;
          this.cancelLongPress();
          for (const id of this.selection) {
            const t = this.tokensById.get(id);
            if (t && this.canMove(id)) g.origins.set(id, { x: t.x, y: t.y });
          }
        }
        const s = this.viewport.scale;
        const dx = (e.x - g.start.x) / s;
        const dy = (e.y - g.start.y) / s;
        this.preview = new Map();
        this.previewCells = [];
        for (const [id, o] of g.origins) {
          const t = this.tokensById.get(id)!;
          const pos = resolveDropPosition({ x: o.x + dx, y: o.y + dy }, t.size, this.scene.grid, this.scene.background);
          this.preview.set(id, pos);
          if (this.scene.grid.snap && this.cell > 0) this.previewCells.push(destinationRect(pos, t.size, this.cell));
        }
        this.invalidate();
        break;
      }
      case "marquee": {
        if (!g.started) {
          if (Math.hypot(e.x - g.start.x, e.y - g.start.y) < DRAG_THRESHOLD_MOUSE) return;
          g.started = true;
        }
        this.marquee = normalizeRect(g.start, p);
        const a = this.toMap({ x: this.marquee.x, y: this.marquee.y });
        const b = this.toMap({ x: this.marquee.x + this.marquee.width, y: this.marquee.y + this.marquee.height });
        const ids = tokensInRect(this.scene.tokens, normalizeRect(a, b), this.cell, this.shown);
        this.selection = new Set([...g.base, ...ids]);
        this.invalidate();
        break;
      }
      case "ruler": {
        if (this.ruler) this.setRuler(this.ruler.a, this.rulerPoint(this.toMap(p)));
        break;
      }
      case "measure": {
        if (g.tool === "ping") break;
        const shape = measureShape(g.tool, g.start, this.toMap(p), this.cell);
        if (!shape || !this.scene) break;
        this.shapeDraft = { shape, text: measureLabel(shape, this.cell, this.scene.scale) };
        this.onRuler(this.shapeDraft.text);
        this.handlers.onShape?.(shape, "draft");
        this.invalidate();
        break;
      }
      case "rotate": {
        const t = this.tokensById.get(g.tokenId);
        if (!t) return;
        const raw = angleFrom(t, this.toMap(p));
        this.handlePreview = { id: t.id, rotation: e.alt ? Math.round(raw) : snapAngle(raw) };
        this.invalidate();
        break;
      }
      case "resize": {
        const t = this.tokensById.get(g.tokenId);
        if (!t) return;
        this.handlePreview = { id: t.id, size: sizeFromHandle(t, this.toMap(p), this.cell) };
        this.invalidate();
        break;
      }
    }
  }

  pointerUp(e: PointerInput) {
    const g = this.gesture;
    this.pointers.delete(e.id);
    if (g?.kind === "pinch") {
      if (this.pointers.size < 2) this.gesture = null;
      this.updateCursor();
      return;
    }
    if (!g || g.id !== e.id) return;
    this.gesture = null;
    this.cancelLongPress();

    switch (g.kind) {
      case "draw":
        this.draw.end(g.tool, e, this.toMap({ x: e.x, y: e.y }));
        this.onToolState(this.toolState);
        break;
      case "doorTap":
        if (Math.hypot(e.x - g.start.x, e.y - g.start.y) < DRAG_THRESHOLD_TOUCH) this.draw.toggleDoor(g.wallId);
        break;
      case "token":
        if (g.longPressed) break;
        if (g.started) {
          for (const [id, pos] of this.preview) {
            const origin = g.origins.get(id)!;
            if (pos.x !== origin.x || pos.y !== origin.y) this.handlers.onMoveToken?.(id, pos.x, pos.y);
          }
        } else if (g.additive) {
          const next = new Set(this.selection);
          if (g.wasSelected) next.delete(g.grabbed);
          else next.add(g.grabbed);
          this.selection = next;
          this.emitSelection();
        } else if (g.wasSelected && this.selection.size > 1) {
          this.selection = new Set([g.grabbed]);
          this.emitSelection();
        }
        break;
      case "marquee":
        if (g.started) this.emitSelection();
        else if (!g.additive && this.selection.size) {
          this.selection = new Set();
          this.emitSelection();
        }
        break;
      case "pan":
        if (!g.moved && g.clearOnTap && this.selection.size) {
          this.selection = new Set();
          this.emitSelection();
        }
        break;
      case "rotate": {
        const hp = this.handlePreview;
        const t = this.tokensById.get(g.tokenId);
        if (hp?.rotation !== undefined && t && this.scene?.role === "gm" && normalizeDegrees(hp.rotation) !== normalizeDegrees(t.rotation)) {
          this.handlers.onRotateToken?.(t.id, hp.rotation);
        }
        break;
      }
      case "resize": {
        const hp = this.handlePreview;
        const t = this.tokensById.get(g.tokenId);
        if (hp?.size !== undefined && t && this.scene?.role === "gm" && hp.size !== t.size) this.handlers.onResizeToken?.(t.id, hp.size);
        break;
      }
      case "ruler":
        if (this.ruler && (this.ruler.a.x !== this.ruler.b.x || this.ruler.a.y !== this.ruler.b.y)) {
          this.handlers.onShape?.({ kind: "ruler", points: [this.ruler.a, this.ruler.b] }, "end");
        }
        break;
      case "measure":
        if (this.shapeDraft && g.tool !== "ping") this.handlers.onShape?.(this.shapeDraft.shape, "end");
        break;
    }
    this.clearTransient();
    this.updateCursor();
    this.invalidate();
  }

  pointerCancel(e: PointerInput) {
    this.pointers.delete(e.id);
    this.cancelLongPress();
    if (this.gesture && (this.gesture.kind === "pinch" ? this.pointers.size < 2 : this.gesture.id === e.id)) this.cancelGesture();
  }

  wheel(x: number, y: number, deltaY: number, deltaMode = 0, ctrl = false) {
    const dy = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
    const factor = Math.exp(-dy * (ctrl ? 0.01 : 0.0015));
    this.zoomBy(factor, { x, y });
  }

  /* ---------------- tastiera ---------------- */

  /** Ritorna true se il tasto e' stato gestito (il chiamante fa preventDefault). */
  keyDown(key: string, shift = false): boolean {
    if (!this.scene) return false;
    if (this.scene.role === "gm") {
      if ((this.tool === "fog" || this.tool === "wall") && this.draw.key(this.tool, key)) {
        this.onToolState(this.toolState);
        return true;
      }
      const toggle = (t: Tool) => {
        this.setTool(this.tool === t ? "select" : t);
        return true;
      };
      if (key === "v" || key === "V") {
        this.setTool("select");
        return true;
      }
      if (key === "n" || key === "N") return this.scene.fog ? toggle("fog") : false;
      if (key === "w" || key === "W") return toggle("wall");
    }
    switch (key) {
      case " ":
        this.spaceDown = true;
        this.updateCursor();
        return true;
      case "+":
      case "=":
        this.zoomBy(1.25);
        return true;
      case "-":
      case "_":
        this.zoomBy(0.8);
        return true;
      case "0":
        this.fit();
        return true;
      case "r":
      case "R":
        this.setTool(this.tool === "ruler" ? "select" : "ruler");
        return true;
      case "o":
      case "O":
        return this.toggleMeasure("circle");
      case "c":
      case "C":
        return this.toggleMeasure("cone");
      case "l":
      case "L":
        return this.toggleMeasure("line");
      case "f":
      case "F":
        return this.toggleMeasure("arrow");
      case "p":
      case "P":
        return this.toggleMeasure("ping");
      case "Escape": {
        if (this.tool === "fog" || this.tool === "wall") {
          if (!this.draw.cancel()) this.setTool("select");
          this.onToolState(this.toolState);
          this.invalidate();
          return true;
        }
        const had = this.gesture || this.ruler || this.shapeDraft || this.selection.size;
        if (this.gesture) this.cancelGesture();
        this.clearRuler();
        this.clearShapeDraft();
        if (this.selection.size) {
          this.selection = new Set();
          this.emitSelection();
        }
        this.invalidate();
        return !!had;
      }
      case "[":
      case "]": {
        if (this.scene.role !== "gm" || !this.selection.size) return false;
        const step = (shift ? 45 : 15) * (key === "]" ? 1 : -1);
        for (const id of this.selection) {
          const t = this.tokensById.get(id);
          if (t) this.handlers.onRotateToken?.(id, normalizeDegrees(t.rotation + step));
        }
        return true;
      }
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        const dx = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
        const dy = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
        const movable = [...this.selection].filter((id) => this.canMove(id));
        if (movable.length && this.cell > 0) {
          for (const id of movable) {
            const t = this.tokensById.get(id)!;
            const p = resolveDropPosition({ x: t.x + dx * this.cell, y: t.y + dy * this.cell }, t.size, this.scene.grid, this.scene.background);
            this.handlers.onMoveToken?.(id, p.x, p.y);
          }
        } else {
          this.setViewport({ ...this.viewport, x: this.viewport.x - dx * KEY_PAN, y: this.viewport.y - dy * KEY_PAN });
        }
        return true;
      }
      default:
        return this.handlers.onKey?.(key, shift) ?? false;
    }
  }

  private toggleMeasure(tool: MeasureTool): boolean {
    this.setTool(this.tool === tool ? "select" : tool);
    return true;
  }

  keyUp(key: string) {
    if (key === " ") {
      this.spaceDown = false;
      this.updateCursor();
    }
  }

  blur() {
    this.spaceDown = false;
    this.cancelGesture();
  }

  /* ---------------- interni ---------------- */

  private rulerPoint(m: Point): Point {
    if (!this.scene?.grid.snap || this.cell <= 0) return m;
    const g = this.scene.grid;
    // Il righello si aggancia ai centri cella.
    return { x: snapAxis(m.x - this.cell / 2, this.cell, g.offsetX) + this.cell / 2, y: snapAxis(m.y - this.cell / 2, this.cell, g.offsetY) + this.cell / 2 };
  }

  private setRuler(a: Point, b: Point) {
    if (!this.scene) return;
    const d = distanceInUnits(a, b, this.cell, this.scene.scale, this.scene.rulerMode ?? "euclidean");
    const text = formatDistance(d, this.scene.scale.unitLabel);
    this.ruler = { a, b, text };
    this.onRuler(text);
    this.invalidate();
  }

  private clearRuler() {
    if (!this.ruler) return;
    this.ruler = null;
    this.onRuler(null);
  }

  private cancelLongPress() {
    if (this.longPress) clearTimeout(this.longPress);
    this.longPress = null;
  }

  /** Toglie la forma in costruzione. `silent`: l'ha gia' consegnata il padre (forma pubblica), non e' un annullamento. */
  clearShapeDraft(silent = false) {
    if (!this.shapeDraft) return;
    this.shapeDraft = null;
    this.onRuler(null);
    if (!silent) this.handlers.onShapeCancel?.();
    this.invalidate();
  }

  private clearTransient() {
    this.preview = new Map();
    this.previewCells = [];
    this.handlePreview = null;
    this.marquee = null;
  }

  private cancelGesture() {
    const wasRuler = this.gesture?.kind === "ruler" || this.gesture?.kind === "measure";
    this.cancelLongPress();
    if (this.gesture?.kind === "draw") this.draw.abortGesture();
    this.gesture = null;
    this.clearTransient();
    if (wasRuler) {
      this.clearRuler();
      this.clearShapeDraft();
    }
    this.updateCursor();
    this.invalidate();
  }

  private emitSelection() {
    this.handlers.onSelectionChange?.([...this.selection]);
    this.invalidate();
  }

  private invalidate() {
    this.onInvalidate();
  }

  private updateCursor() {
    const g = this.gesture;
    let c = "default";
    if (g?.kind === "pan" || g?.kind === "pinch") c = "grabbing";
    else if (g?.kind === "token" && g.started) c = "grabbing";
    else if (this.spaceDown) c = "grab";
    else if (this.tool !== "select") c = "crosshair";
    this.onCursor(c);
  }
}
