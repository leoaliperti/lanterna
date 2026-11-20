import type { FogShape } from "@lanterna/shared";
import { CellPath, circleShape, polygonShape, previewRuns, rectShape, type FogBrush, type FogMode } from "../fog/fogLogic";
import { clampToMap, hitWall, moveEndpointPatch, snapVertex, type WallLike, type WallSnap } from "../fog/wallLogic";
import type { MapHandlers, MapScene, Point } from "./types";

/**
 * Strumenti del GM sulla mappa: pennelli della nebbia (rettangolo, cerchio, poligono, celle) e muri/porte.
 * Logica senza DOM ne' Pixi, usata da `MapController`. Non modifica i dati: produce anteprime e chiama le
 * callback (`onFogShape`, `onWall*`), poi decide il server.
 */

export type WallMode = "draw" | "door" | "edit" | "erase";

export interface FogPreview {
  mode: FogMode;
  /** Celle che verrebbero rivelate/coperte (terne canoniche). */
  runs: number[];
  shape: FogShape | null;
  /** Poligono in costruzione: vertici fissati e punto sotto il puntatore. */
  vertices: Point[];
  cursor: Point | null;
}

export interface WallPreview {
  a: Point;
  b: Point;
  door: boolean;
}

export interface DrawContext {
  scene: () => MapScene | null;
  /** Scala del viewport (pixel schermo per pixel mappa). */
  scale: () => number;
  handlers: () => MapHandlers;
  invalidate: () => void;
}

export interface DrawPointer {
  id: number;
  type: string;
  x: number;
  y: number;
  alt?: boolean;
}

/** Raggio di aggancio per afferrare muri e chiudere il poligono (pixel schermo). */
const HIT_SCREEN = 12;
const DOUBLE_CLICK_MS = 350;
const DRAG_PX = 6;

type Active =
  | { kind: "fog"; id: number; anchor: Point; startScreen: Point; path: CellPath | null }
  | { kind: "polygon"; id: number; startScreen: Point }
  | { kind: "wall"; id: number; start: Point; startScreen: Point; chained: boolean }
  | { kind: "wallHandle"; id: number; wall: WallLike; part: "a" | "b" }
  | { kind: "wallTap"; id: number; wallId: string; action: "toggle" | "remove"; startScreen: Point };

export class DrawTools {
  fogBrush: FogBrush = "rect";
  fogMode: FogMode = "reveal";
  wallMode: WallMode = "draw";
  fogPreview: FogPreview | null = null;
  wallPreview: WallPreview | null = null;
  selectedWall: string | null = null;

  private active: Active | null = null;
  private polygon: Point[] = [];
  private chain: Point | null = null;
  private lastTap: { t: number; x: number; y: number } | null = null;

  constructor(private ctx: DrawContext) {}

  /* ---------------- stato ---------------- */

  /** C'e' un disegno in corso (poligono aperto, catena di muri, gesto)? */
  get busy(): boolean {
    return this.active !== null || this.polygon.length > 0 || this.chain !== null;
  }

  private get scene(): MapScene | null {
    return this.ctx.scene();
  }

  private geometry() {
    const s = this.scene;
    return s?.fog?.geometry ?? (s ? { cellSize: s.grid.cellSize, offsetX: s.grid.offsetX, offsetY: s.grid.offsetY } : null);
  }

  private walls(): WallLike[] {
    return (this.scene?.walls ?? []) as WallLike[];
  }

  private tolerance(): number {
    return HIT_SCREEN / Math.max(0.0001, this.ctx.scale());
  }

  private snapMode(e: { alt?: boolean }): WallSnap {
    if (e.alt) return "free";
    return this.scene?.grid.snap === false ? "free" : "grid";
  }

  private wallPoint(m: Point, e: { alt?: boolean }): Point {
    const s = this.scene;
    if (!s) return m;
    return clampToMap(snapVertex(m, s.grid, this.snapMode(e)), s.background.width, s.background.height);
  }

  setFogBrush(brush: FogBrush) {
    if (brush === this.fogBrush) return;
    this.fogBrush = brush;
    this.cancel();
  }

  setFogMode(mode: FogMode) {
    this.fogMode = mode;
    if (this.fogPreview) this.fogPreview = { ...this.fogPreview, mode };
    this.ctx.invalidate();
  }

  setWallMode(mode: WallMode) {
    if (mode === this.wallMode) return;
    this.wallMode = mode;
    this.cancel();
  }

  /** Dati cambiati: il muro selezionato potrebbe non esistere piu'. */
  sync() {
    if (this.selectedWall && !this.walls().some((w) => w.id === this.selectedWall)) this.select(null);
    if (!this.scene?.fog && (this.fogPreview || this.polygon.length)) this.cancel();
  }

  select(id: string | null) {
    if (this.selectedWall === id) return;
    this.selectedWall = id;
    this.ctx.handlers().onWallSelect?.(id);
    this.ctx.invalidate();
  }

  /** Annulla tutto cio' che e' in corso. Ritorna true se c'era qualcosa. */
  cancel(): boolean {
    const had = this.busy || this.fogPreview !== null || this.wallPreview !== null;
    this.active = null;
    this.polygon = [];
    this.chain = null;
    this.fogPreview = null;
    this.wallPreview = null;
    this.lastTap = null;
    if (had) this.ctx.invalidate();
    return had;
  }

  /* ---------------- puntatore ---------------- */

  /** Inizio di un gesto con lo strumento attivo. Ritorna true se il gesto e' stato preso in carico. */
  begin(tool: "fog" | "wall", e: DrawPointer, m: Point): boolean {
    if (tool === "fog") return this.beginFog(e, m);
    return this.beginWall(e, m);
  }

  move(tool: "fog" | "wall", e: DrawPointer, m: Point): void {
    const a = this.active;
    if (tool === "fog") {
      if (a?.kind === "fog") this.moveFog(a, m, e);
      else if (this.fogBrush === "polygon" && this.polygon.length) this.polygonPreview(m, e);
      return;
    }
    if (a?.kind === "wall") {
      const b = this.wallPoint(m, e);
      this.wallPreview = { a: a.chained ? (this.chain ?? a.start) : a.start, b, door: this.wallMode === "door" };
      this.ctx.invalidate();
    } else if (a?.kind === "wallHandle") {
      const other = a.part === "a" ? { x: a.wall.segments[2]!, y: a.wall.segments[3]! } : { x: a.wall.segments[0]!, y: a.wall.segments[1]! };
      const to = this.wallPoint(m, e);
      this.wallPreview = a.part === "a" ? { a: to, b: other, door: a.wall.door } : { a: other, b: to, door: a.wall.door };
      this.ctx.invalidate();
    } else if (this.chain && (this.wallMode === "draw" || this.wallMode === "door")) {
      this.wallPreview = { a: this.chain, b: this.wallPoint(m, e), door: this.wallMode === "door" };
      this.ctx.invalidate();
    }
  }

  end(tool: "fog" | "wall", e: DrawPointer, m: Point): void {
    const a = this.active;
    if (!a || a.id !== e.id) return;
    this.active = null;
    if (tool === "fog") {
      if (a.kind === "fog") this.endFog(a, m, e);
      else if (a.kind === "polygon") this.endPolygon(a, m, e);
    } else {
      this.endWall(a, m, e);
    }
    this.ctx.invalidate();
  }

  /** Il gesto viene annullato dall'esterno (pinch, perdita del puntatore). */
  abortGesture() {
    this.active = null;
    this.fogPreview = this.polygon.length ? this.fogPreview : null;
    this.wallPreview = this.chain ? this.wallPreview : null;
    this.ctx.invalidate();
  }

  /* ---------------- nebbia ---------------- */

  private fogSize(): { w: number; h: number } {
    const bg = this.scene?.background;
    return { w: bg?.width ?? 0, h: bg?.height ?? 0 };
  }

  private beginFog(e: DrawPointer, m: Point): boolean {
    if (!this.scene?.fog || !this.geometry()) return false;
    const startScreen = { x: e.x, y: e.y };
    if (this.fogBrush === "polygon") {
      this.active = { kind: "polygon", id: e.id, startScreen };
      return true;
    }
    const g = this.geometry()!;
    const { w, h } = this.fogSize();
    const path = this.fogBrush === "cells" ? new CellPath(g, w, h) : null;
    path?.add(m);
    this.active = { kind: "fog", id: e.id, anchor: m, startScreen, path };
    this.moveFog(this.active, m, e);
    return true;
  }

  private shapeFor(a: Extract<Active, { kind: "fog" }>, m: Point, e: { alt?: boolean }): FogShape | null {
    const g = this.geometry();
    if (!g) return null;
    const snap = !e.alt;
    if (this.fogBrush === "rect") return rectShape(g, a.anchor, m, snap);
    if (this.fogBrush === "circle") return circleShape(g, a.anchor, m, snap);
    a.path?.add(m);
    return a.path?.shape() ?? null;
  }

  private moveFog(a: Extract<Active, { kind: "fog" }>, m: Point, e: { alt?: boolean }) {
    const g = this.geometry();
    const shape = this.shapeFor(a, m, e);
    if (!g || !shape) return;
    const { w, h } = this.fogSize();
    this.fogPreview = { mode: this.fogMode, runs: previewRuns(shape, g, w, h), shape, vertices: [], cursor: null };
    this.ctx.invalidate();
  }

  private endFog(a: Extract<Active, { kind: "fog" }>, m: Point, e: { alt?: boolean }) {
    const shape = this.shapeFor(a, m, e);
    this.fogPreview = null;
    if (shape) this.ctx.handlers().onFogShape?.(shape, this.fogMode);
  }

  private polygonPreview(m: Point, e: { alt?: boolean }) {
    const g = this.geometry();
    if (!g) return;
    const cursor = this.polygonPoint(m, e);
    const pts = [...this.polygon, cursor];
    const shape = polygonShape(pts);
    const { w, h } = this.fogSize();
    this.fogPreview = { mode: this.fogMode, runs: shape ? previewRuns(shape, g, w, h) : [], shape, vertices: [...this.polygon], cursor };
    this.ctx.invalidate();
  }

  private polygonPoint(m: Point, e: { alt?: boolean }): Point {
    const g = this.geometry();
    if (!g || e.alt) return m;
    // Vertici agganciati agli incroci della griglia della nebbia: l'anteprima coincide con il risultato.
    return snapVertex(m, g, "grid");
  }

  private endPolygon(a: Extract<Active, { kind: "polygon" }>, m: Point, e: DrawPointer) {
    if (Math.hypot(e.x - a.startScreen.x, e.y - a.startScreen.y) > DRAG_PX * 2) return; // trascinamento: nessun vertice
    const p = this.polygonPoint(m, e);
    const now = Date.now();
    const first = this.polygon[0];
    const last = this.polygon[this.polygon.length - 1];
    const tol = this.tolerance();
    const double = this.lastTap && now - this.lastTap.t < DOUBLE_CLICK_MS && Math.hypot(e.x - this.lastTap.x, e.y - this.lastTap.y) < 10;
    this.lastTap = { t: now, x: e.x, y: e.y };
    const closesOnFirst = this.polygon.length >= 3 && first !== undefined && Math.hypot(p.x - first.x, p.y - first.y) <= tol;
    if (double || closesOnFirst) {
      // Il primo clic del doppio clic ha gia' aggiunto il vertice: qui si chiude e basta.
      this.closePolygon();
      return;
    }
    if (last && last.x === p.x && last.y === p.y) return;
    this.polygon.push(p);
    this.polygonPreview(m, e);
  }

  /** Chiude il poligono e lo consegna (Invio, doppio clic, clic sul primo vertice). */
  closePolygon(): boolean {
    const shape = polygonShape(this.polygon);
    this.polygon = [];
    this.fogPreview = null;
    this.lastTap = null;
    this.ctx.invalidate();
    if (!shape) return false;
    this.ctx.handlers().onFogShape?.(shape, this.fogMode);
    return true;
  }

  undoVertex(): boolean {
    if (!this.polygon.length) return false;
    this.polygon.pop();
    if (!this.polygon.length) this.fogPreview = null;
    else this.fogPreview = this.fogPreview ? { ...this.fogPreview, vertices: [...this.polygon] } : null;
    this.ctx.invalidate();
    return true;
  }

  /* ---------------- muri ---------------- */

  private beginWall(e: DrawPointer, m: Point): boolean {
    const scene = this.scene;
    if (!scene) return false;
    const startScreen = { x: e.x, y: e.y };
    const tol = this.tolerance();
    switch (this.wallMode) {
      case "erase": {
        const hit = hitWall(this.walls(), m, tol);
        if (!hit) return false;
        this.active = { kind: "wallTap", id: e.id, wallId: hit.wall.id, action: "remove", startScreen };
        return true;
      }
      case "edit": {
        const hit = hitWall(this.walls(), m, tol);
        if (!hit) {
          this.select(null);
          return false;
        }
        this.select(hit.wall.id);
        if (hit.part === "a" || hit.part === "b") {
          this.active = { kind: "wallHandle", id: e.id, wall: hit.wall, part: hit.part };
          return true;
        }
        return false;
      }
      case "door":
      case "draw": {
        if (this.wallMode === "door") {
          const door = hitWall(this.walls(), m, tol, (w) => w.door);
          if (door) {
            this.active = { kind: "wallTap", id: e.id, wallId: door.wall.id, action: "toggle", startScreen };
            return true;
          }
        }
        const chained = this.chain !== null;
        this.active = { kind: "wall", id: e.id, start: chained ? this.chain! : this.wallPoint(m, e), startScreen, chained };
        return true;
      }
    }
  }

  private endWall(a: Active, m: Point, e: DrawPointer) {
    const h = this.ctx.handlers();
    switch (a.kind) {
      case "wallTap": {
        if (Math.hypot(e.x - a.startScreen.x, e.y - a.startScreen.y) > DRAG_PX) return;
        if (a.action === "remove") {
          if (this.selectedWall === a.wallId) this.select(null);
          h.onWallRemove?.(a.wallId);
        } else {
          const w = this.walls().find((x) => x.id === a.wallId);
          if (w) h.onWallUpdate?.(w.id, { open: !w.open });
        }
        return;
      }
      case "wallHandle": {
        this.wallPreview = null;
        const to = this.wallPoint(m, e);
        const patch = moveEndpointPatch(a.wall, a.part, to);
        const old = a.part === "a" ? [a.wall.segments[0], a.wall.segments[1]] : [a.wall.segments[2], a.wall.segments[3]];
        if (patch && (old[0] !== to.x || old[1] !== to.y)) h.onWallUpdate?.(a.wall.id, patch);
        return;
      }
      case "wall": {
        const end = this.wallPoint(m, e);
        const dragged = Math.hypot(e.x - a.startScreen.x, e.y - a.startScreen.y) > DRAG_PX;
        this.wallPreview = null;
        if (!a.chained && !dragged) {
          // Primo clic: parte una catena (secondo clic = fine del primo segmento).
          this.chain = end;
          this.wallPreview = { a: end, b: end, door: this.wallMode === "door" };
          return;
        }
        if (end.x !== a.start.x || end.y !== a.start.y) h.onWallAdd?.(a.start, end, this.wallMode === "door");
        this.chain = a.chained ? end : null;
        if (this.chain) this.wallPreview = { a: this.chain, b: this.chain, door: this.wallMode === "door" };
        return;
      }
      default:
        return;
    }
  }

  /** Porta sotto il puntatore (per aprirla/chiuderla con un clic anche con lo strumento di selezione). */
  doorAt(m: Point): WallLike | null {
    return hitWall(this.walls(), m, this.tolerance(), (w) => w.door)?.wall ?? null;
  }

  toggleDoor(id: string) {
    const w = this.walls().find((x) => x.id === id);
    if (w?.door) this.ctx.handlers().onWallUpdate?.(id, { open: !w.open });
  }

  /* ---------------- tastiera ---------------- */

  /** Ritorna true se il tasto e' stato gestito. */
  key(tool: "fog" | "wall", key: string): boolean {
    if (tool === "fog") {
      switch (key) {
        case "1":
          this.setFogBrush("rect");
          return true;
        case "2":
          this.setFogBrush("circle");
          return true;
        case "3":
          this.setFogBrush("polygon");
          return true;
        case "4":
          this.setFogBrush("cells");
          return true;
        case "x":
        case "X":
          this.setFogMode(this.fogMode === "reveal" ? "cover" : "reveal");
          return true;
        case "Enter":
          return this.fogBrush === "polygon" && this.closePolygon();
        case "Backspace":
          return this.undoVertex();
        default:
          return false;
      }
    }
    switch (key) {
      case "1":
        this.setWallMode("draw");
        return true;
      case "2":
        this.setWallMode("door");
        return true;
      case "3":
        this.setWallMode("edit");
        return true;
      case "4":
        this.setWallMode("erase");
        return true;
      case "Enter":
        if (this.chain) {
          this.chain = null;
          this.wallPreview = null;
          this.ctx.invalidate();
          return true;
        }
        return false;
      case "Delete":
      case "Backspace":
        if (this.selectedWall) {
          const id = this.selectedWall;
          this.select(null);
          this.ctx.handlers().onWallRemove?.(id);
          return true;
        }
        return false;
      default:
        return false;
    }
  }
}
