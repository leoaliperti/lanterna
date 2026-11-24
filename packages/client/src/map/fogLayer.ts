import { CanvasSource, Container, Graphics, ImageSource, Sprite, Texture } from "pixi.js";
import { masksEqual, sceneCellRange, type FogMask } from "@lanterna/shared";
import { coveredBitmap, diffTiles, type Pt } from "../fog/fogLogic";
import { dashedSegments } from "../fog/sight";
import type { MapController } from "./controller";
import type { MapTheme } from "./theme";
import type { MapFog, MapScene, MapSight, MapTile, MapWall } from "./types";

/**
 * Livelli PixiJS della nebbia, dei muri e dell'aiuto visivo di vista. Non conosce React.
 *
 * - Velo: UNA texture con un pixel per cella (alcuni pixel per cella ingranditi), mai un oggetto per cella.
 *   Il bordo e' morbido solo verso le celle rivelate: la texture a 1 pixel/cella viene ingrandita con
 *   interpolazione, poi le celle coperte si ridisegnano sopra nette (alpha pieno). Cosi' la sfumatura
 *   non puo' mai scoprire nulla di coperto, e il velo del giocatore resta opaco dove deve.
 * - Aggiornamento animato: la nuova texture compare in dissolvenza sopra la vecchia (assente con movimento ridotto).
 * - Tessere: solo quelle che il padre indica; 404 = non c'e' (resta il velo).
 * - L'aiuto visivo di vista e' un contorno tratteggiato tenue: non modifica la nebbia.
 */

const FADE_MS = 220;
const GM_VEIL_ALPHA = 0.55;
const MAX_VEIL_PIXELS = 16_000_000;

interface Veil {
  sprite: Sprite;
  texture: Texture;
  /** Alpha finale del velo. */
  target: number;
  t: number;
}

interface TileEntry {
  sprite: Sprite;
  key: string;
  t: number;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("tessera non disponibile"));
    img.src = url;
  });
}

export class FogLayer {
  /** Tessere della mappa (sotto la griglia). */
  readonly tilesLayer = new Container();
  readonly sightGfx = new Graphics();
  readonly veilLayer = new Container();
  readonly wallsGfx = new Graphics();
  readonly previewGfx = new Graphics();

  private current: Veil | null = null;
  private incoming: Veil | null = null;
  private veilMask: FogMask | null = null;
  private veilKey = "";

  private tiles = new Map<string, TileEntry>();
  private loading = new Map<string, string>();
  private failed = new Map<string, string>();
  private tileToken = 0;
  private fogScene: string | null = null;

  private sight: readonly MapSight[] = [];
  private walls: readonly MapWall[] = [];
  private wallsVisible = true;
  private previewKey: unknown = null;
  private dirty = true;
  private drawnScale = 0;
  private disposed = false;

  constructor(
    private opts: {
      theme: () => MapTheme;
      reducedMotion: () => boolean;
      maxTexture: () => number;
      redraw: () => void;
    }
  ) {
    this.sightGfx.eventMode = "none";
  }

  invalidate() {
    this.dirty = true;
  }

  /* ---------------- sincronizzazione con la scena ---------------- */

  sync(scene: MapScene) {
    if (this.disposed) return;
    const bg = scene.background;
    const fogScene = scene.fog?.sceneId ?? null;
    if (fogScene !== this.fogScene) {
      // Un'altra scena (o la nebbia e' stata tolta/attivata): via velo e tessere della precedente.
      this.fogScene = fogScene;
      this.reset();
    }
    this.syncVeil(scene.fog ?? null, bg.width, bg.height);
    this.syncTiles(scene.fog?.tiles ?? []);
    if (scene.walls !== this.walls || (scene.wallsVisible !== false) !== this.wallsVisible) {
      this.walls = scene.walls ?? [];
      this.wallsVisible = scene.wallsVisible !== false;
      this.dirty = true;
    }
    const sight = scene.sight ?? [];
    if (sight !== this.sight) {
      this.sight = sight;
      this.dirty = true;
    }
  }

  /* ---------------- velo ---------------- */

  private syncVeil(fog: MapFog | null, width: number, height: number) {
    if (!fog || !fog.mask) {
      if (this.current || this.incoming) this.clearVeil();
      this.veilMask = null;
      this.veilKey = "";
      return;
    }
    const g = fog.geometry;
    const key = `${g.cellSize}|${g.offsetX}|${g.offsetY}|${width}|${height}|${fog.opaque ? 1 : 0}`;
    if (this.veilMask && key === this.veilKey && masksEqual(this.veilMask, fog.mask)) return;
    const first = this.current === null && this.incoming === null;
    this.veilMask = fog.mask;
    this.veilKey = key;
    const veil = this.buildVeil(fog.mask, g, width, height, fog.opaque ? 1 : GM_VEIL_ALPHA);
    if (!veil) return;
    this.veilLayer.addChild(veil.sprite);
    if (first || this.opts.reducedMotion()) {
      this.clearVeil();
      this.current = veil;
      veil.sprite.alpha = veil.target;
    } else {
      // Se un cambio precedente non ha finito, quello diventa subito il velo corrente.
      if (this.incoming) {
        this.destroyVeil(this.current);
        this.current = this.incoming;
        this.current.sprite.alpha = this.current.target;
      }
      veil.sprite.alpha = 0;
      this.incoming = veil;
    }
    this.opts.redraw();
  }

  private buildVeil(mask: FogMask, g: { cellSize: number; offsetX: number; offsetY: number }, width: number, height: number, alpha: number): Veil | null {
    const [c0, r0, c1, r1] = sceneCellRange(g, width, height);
    const cols = c1 - c0;
    const rows = r1 - r0;
    if (cols <= 0 || rows <= 0 || typeof document === "undefined") return null;
    const limit = Math.min(4096, this.opts.maxTexture());
    let px = Math.max(1, Math.min(8, Math.floor(limit / Math.max(cols, rows))));
    while (px > 1 && cols * px * rows * px > MAX_VEIL_PIXELS) px--;

    const bitmap = coveredBitmap(mask, c0, r0, c1, r1);
    const small = document.createElement("canvas");
    small.width = cols;
    small.height = rows;
    const sctx = small.getContext("2d");
    const big = document.createElement("canvas");
    big.width = cols * px;
    big.height = rows * px;
    const bctx = big.getContext("2d");
    if (!sctx || !bctx) return null;
    const img = sctx.createImageData(cols, rows);
    for (let i = 0; i < bitmap.length; i++) img.data[i * 4 + 3] = bitmap[i]!;
    sctx.putImageData(img, 0, 0);
    // 1) bordo morbido (interpolazione), 2) celle coperte nette sopra: la sfumatura sta solo sul lato rivelato.
    bctx.imageSmoothingEnabled = px > 1;
    bctx.drawImage(small, 0, 0, big.width, big.height);
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(small, 0, 0, big.width, big.height);

    const source = new CanvasSource({ resource: big });
    source.style.scaleMode = "linear";
    const texture = new Texture({ source });
    const sprite = new Sprite(texture);
    sprite.position.set(g.offsetX + c0 * g.cellSize, g.offsetY + r0 * g.cellSize);
    sprite.width = cols * g.cellSize;
    sprite.height = rows * g.cellSize;
    return { sprite, texture, target: alpha, t: 0 };
  }

  private destroyVeil(v: Veil | null) {
    if (!v) return;
    v.sprite.destroy();
    v.texture.destroy(true);
  }

  private clearVeil() {
    this.destroyVeil(this.current);
    this.destroyVeil(this.incoming);
    this.current = this.incoming = null;
  }

  /* ---------------- tessere ---------------- */

  private syncTiles(wanted: readonly MapTile[]) {
    const known = new Map<string, string>();
    for (const [id, e] of this.tiles) known.set(id, e.key);
    for (const [id, k] of this.failed) known.set(id, k);
    for (const [id, k] of this.loading) known.set(id, k);
    const { load, remove } = diffTiles(known, wanted);
    for (const id of remove) {
      const e = this.tiles.get(id);
      if (e) this.destroyTile(e);
      this.tiles.delete(id);
      this.loading.delete(id);
      this.failed.delete(id);
    }
    for (const t of load) {
      this.failed.delete(t.id);
      this.loading.set(t.id, t.key);
      const mine = this.tileToken;
      loadImage(t.url)
        .then((img) => {
          if (this.disposed || mine !== this.tileToken || this.loading.get(t.id) !== t.key) return;
          this.loading.delete(t.id);
          const source = new ImageSource({ resource: img, autoGenerateMipmaps: true });
          source.style.scaleMode = "linear";
          source.style.mipmapFilter = "linear";
          const sprite = new Sprite(new Texture({ source }));
          sprite.position.set(t.x, t.y);
          sprite.width = t.width;
          sprite.height = t.height;
          const old = this.tiles.get(t.id);
          this.tilesLayer.addChild(sprite);
          if (old) {
            this.destroyTile(old);
            sprite.alpha = 1;
          } else sprite.alpha = this.opts.reducedMotion() ? 1 : 0;
          this.tiles.set(t.id, { sprite, key: t.key, t: sprite.alpha >= 1 ? FADE_MS : 0 });
          this.opts.redraw();
        })
        .catch(() => {
          // 404 = tessera coperta (o non piu' disponibile): resta il velo. Niente nuovi tentativi finche' la chiave non cambia.
          if (this.disposed || mine !== this.tileToken || this.loading.get(t.id) !== t.key) return;
          this.loading.delete(t.id);
          this.failed.set(t.id, t.key);
          const old = this.tiles.get(t.id);
          if (old) {
            this.destroyTile(old);
            this.tiles.delete(t.id);
          }
          this.opts.redraw();
        });
    }
  }

  private destroyTile(e: TileEntry) {
    e.sprite.texture.destroy(true);
    e.sprite.destroy();
  }

  /** Nuovo sfondo/scena: via tessere e velo (i caricamenti in corso vengono ignorati). */
  reset() {
    this.tileToken++;
    for (const e of this.tiles.values()) this.destroyTile(e);
    this.tiles.clear();
    this.loading.clear();
    this.failed.clear();
    this.clearVeil();
    this.veilMask = null;
    this.veilKey = "";
    this.sight = [];
    this.walls = [];
    this.dirty = true;
  }

  /* ---------------- frame ---------------- */

  /** Anima dissolvenze e ridisegna cio' che e' cambiato. Ritorna true se serve un altro frame. */
  frame(dt: number, scale: number, c: MapController): boolean {
    let animating = false;
    const step = dt / FADE_MS;
    if (this.incoming) {
      this.incoming.t = Math.min(1, this.incoming.t + step);
      this.incoming.sprite.alpha = this.incoming.target * easeOut(this.incoming.t);
      if (this.incoming.t >= 1) {
        this.destroyVeil(this.current);
        this.current = this.incoming;
        this.current.sprite.alpha = this.current.target;
        this.incoming = null;
      } else animating = true;
    }
    for (const e of this.tiles.values()) {
      if (e.t < FADE_MS) {
        e.t = Math.min(FADE_MS, e.t + dt);
        e.sprite.alpha = easeOut(e.t / FADE_MS);
        if (e.t < FADE_MS) animating = true;
      }
    }

    // Spessori e tratteggi seguono lo zoom a passi (un quarto d'ottava): niente ridisegno a ogni frame di zoom.
    const q = Math.round(Math.log2(Math.max(scale, 1e-3)) * 4);
    const qs = 2 ** (q / 4);
    const theme = this.opts.theme();
    if (this.dirty || q !== this.drawnScale) {
      this.drawSight(qs, theme);
      this.drawnScale = q;
    }
    const pk = [c.draw.fogPreview, c.draw.wallPreview, c.draw.selectedWall, q, this.walls, this.wallsVisible, this.dirty] as const;
    const prev = this.previewKey as typeof pk | null;
    if (!prev || prev.some((v, i) => v !== pk[i])) {
      this.previewKey = pk;
      this.drawPreview(qs, theme, c);
      this.drawWalls(qs, theme, c);
    }
    this.dirty = false;
    return animating;
  }

  private drawSight(scale: number, theme: MapTheme) {
    const g = this.sightGfx;
    g.clear();
    this.sightGfx.visible = this.sight.length > 0;
    for (const a of this.sight) {
      if (a.light) {
        if (a.light.dim.length >= 6) g.poly(a.light.dim as number[]).fill({ color: theme.yellow, alpha: 0.07 });
        if (a.light.bright.length >= 6) g.poly(a.light.bright as number[]).fill({ color: theme.yellow, alpha: 0.12 });
      }
      if (a.polygon.length >= 6) g.poly(a.polygon as number[]).fill({ color: theme.tint, alpha: 0.06 });
    }
    // Contorno tratteggiato, un solo percorso.
    const dash = 8 / scale;
    const gap = 6 / scale;
    let any = false;
    for (const a of this.sight) {
      if (a.polygon.length < 6) continue;
      const segs = dashedSegments(a.polygon, dash, gap, true);
      for (let i = 0; i + 3 < segs.length; i += 4) g.moveTo(segs[i]!, segs[i + 1]!).lineTo(segs[i + 2]!, segs[i + 3]!);
      any = true;
    }
    if (any) g.stroke({ width: 1.5 / scale, color: theme.tint, alpha: 0.55 });
  }

  private drawWalls(scale: number, theme: MapTheme, c: MapController) {
    const g = this.wallsGfx;
    g.clear();
    if (!this.wallsVisible) return;
    const selected = c.draw.selectedWall;
    const w1 = 2.5 / scale;
    for (const w of this.walls) {
      const isSel = w.id === selected;
      const color = w.door ? (w.open ? theme.green : theme.orange) : theme.label;
      const s = w.segments;
      for (let i = 0; i + 3 < s.length; i += 4) {
        const x1 = s[i]!;
        const y1 = s[i + 1]!;
        const x2 = s[i + 2]!;
        const y2 = s[i + 3]!;
        // Contorno colorato (tinta del tema): il GM riconosce i muri a colpo d'occhio anche su mappe scure o chiare.
        g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: w1 + 4 / scale, color: theme.tint, alpha: 0.85 });
        if (w.door && w.open) {
          const segs = dashedSegments([x1, y1, x2, y2], 7 / scale, 5 / scale, false);
          for (let k = 0; k + 3 < segs.length; k += 4) g.moveTo(segs[k]!, segs[k + 1]!).lineTo(segs[k + 2]!, segs[k + 3]!);
          g.stroke({ width: w1, color, alpha: 0.95 });
        } else {
          g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: isSel ? w1 + 1 / scale : w1, color: isSel ? theme.tint : color, alpha: 0.95 });
        }
        if (w.door) {
          // Una porta ha un segno al centro: pieno se chiusa, vuoto se aperta.
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;
          if (w.open) g.circle(mx, my, 5 / scale).stroke({ width: 1.5 / scale, color, alpha: 1 });
          else g.circle(mx, my, 5 / scale).fill({ color, alpha: 1 }).stroke({ width: 1.5 / scale, color: theme.onTint });
        }
        if (isSel) {
          for (const [px, py] of [[x1, y1], [x2, y2]] as const) {
            g.circle(px, py, 7 / scale).fill(theme.tint).stroke({ width: 2 / scale, color: theme.onTint });
          }
        }
      }
    }
  }

  private drawPreview(scale: number, theme: MapTheme, c: MapController) {
    const g = this.previewGfx;
    g.clear();
    const fp = c.draw.fogPreview;
    const fog = c.scene?.fog;
    if (fp && fog) {
      const gm = fog.geometry;
      const color = fp.mode === "reveal" ? theme.green : theme.red;
      const runs = fp.runs;
      for (let i = 0; i < runs.length; i += 3) {
        const r = runs[i]!;
        const a = runs[i + 1]!;
        const b = runs[i + 2]!;
        g.rect(gm.offsetX + a * gm.cellSize, gm.offsetY + r * gm.cellSize, (b - a) * gm.cellSize, gm.cellSize);
      }
      if (runs.length) g.fill({ color, alpha: 0.38 });
      const sh = fp.shape;
      const line = { width: 2 / scale, color: theme.tint, alpha: 0.95 };
      if (sh?.kind === "rect") g.rect(sh.x, sh.y, sh.width, sh.height).stroke(line);
      else if (sh?.kind === "circle") g.circle(sh.x, sh.y, sh.radius).stroke(line);
      else if (sh?.kind === "polygon" && sh.points.length >= 6) g.poly(sh.points).stroke(line);
      for (const v of fp.vertices) g.circle(v.x, v.y, 5 / scale).fill(theme.tint).stroke({ width: 1.5 / scale, color: theme.onTint });
      const first = fp.vertices[0];
      if (first && fp.vertices.length >= 3) g.circle(first.x, first.y, 9 / scale).stroke({ width: 1.5 / scale, color: theme.tint, alpha: 0.8 });
    }
    const wp = c.draw.wallPreview;
    if (wp) {
      const color = wp.door ? theme.orange : theme.tint;
      g.moveTo(wp.a.x, wp.a.y).lineTo(wp.b.x, wp.b.y).stroke({ width: 3 / scale, color, alpha: 0.9 });
      for (const p of [wp.a, wp.b] as Pt[]) g.circle(p.x, p.y, 5 / scale).fill(color).stroke({ width: 1.5 / scale, color: theme.onTint });
    }
  }

  dispose() {
    this.disposed = true;
    this.reset();
  }
}

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
