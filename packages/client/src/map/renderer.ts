// Pixi 8 senza questo import richiede 'unsafe-eval' nella CSP di produzione.
import "pixi.js/unsafe-eval";
import { Application, CanvasSource, Container, Graphics, ImageSource, Sprite, Text, Texture } from "pixi.js";
import { parseCssColor } from "./color";
import { FogLayer } from "./fogLayer";
import { PropLayer } from "./propLayer";
import type { MapController } from "./controller";
import { isTokenShown, rectsIntersect, tokenRadius, visibleRect } from "./geometry";
import { type BackgroundPlan, MAX_LOADED_TILES, needsDetail, planBackground, tileRect, tilesToEvict, visibleTiles } from "./tiles";
import { type MapTheme, healthColor, kindColor, readTheme } from "./theme";
import { cellRects, ephemeralAlpha, measureLabel, outlinePolygon } from "./measure";
import type { Shape } from "@lanterna/shared";
import type { MapEphemeral, MapPulse, MapScene, MapToken, Point, Size, TokenShape } from "./types";

/**
 * Resa PixiJS della mappa. Si carica con import() dinamico (vedi MapCanvas) e non conosce React.
 *
 * - Ridisegna solo quando serve (stato "sporco"): niente ticker continuo.
 * - La scena si aggiorna per differenza: i token si creano, aggiornano e distruggono per id.
 * - Griglia: un solo Graphics, ridisegnato solo se cambia la griglia.
 * - Token fuori schermo: `visible = false` (culling). Texture dei token condivise per URL.
 */

const GRID_MIN_SCREEN_CELL = 6;
const DECOR_PAD_CELLS = 1.6;
const TILES_PER_FRAME = 2;
const EASE_MS = 140;
/** Dissolvenza finale delle forme effimere e durata del richiamo su un token. */
const FADE_MS = 700;
const PULSE_MS = 1100;
const PULSE_STATIC_MS = 1600;

interface TokenView {
  token: MapToken;
  sig: string;
  root: Container;
  body: Container;
  decor: Container;
  label: Text | null;
  barBg: Graphics | null;
  barFg: Graphics | null;
  badges: Container | null;
  /** Testo "attuali/massimi" sotto la barra della vita. */
  hpText: Text | null;
  effectBadge: Container | null;
  /** Posizione disegnata (puo' essere in transizione verso quella dei dati). */
  x: number;
  y: number;
  imageUrl: string | null;
  layoutKey: string;
  shown: boolean;
}

interface TextureEntry {
  texture: Promise<Texture | null>;
  refs: number;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Immagine non caricabile: ${url}`));
    img.src = url;
  });
}

function mipmapped(source: ImageSource | CanvasSource): Texture {
  source.style.scaleMode = "linear";
  source.style.mipmapFilter = "linear";
  return new Texture({ source });
}

/** Percorso della forma del token, centrata in (0,0) con raggio `r` (pixel di mappa). Cerchio per default. */
export function shapePath(g: Graphics, shape: TokenShape, r: number): void {
  switch (shape) {
    case "square":
      g.rect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7);
      return;
    case "diamond":
      g.poly([0, -r, r, 0, 0, r, -r, 0]);
      return;
    case "hexagon": {
      const pts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (-90 + 60 * i) * (Math.PI / 180);
        pts.push(r * Math.cos(a), r * Math.sin(a));
      }
      g.poly(pts);
      return;
    }
    case "triangle":
      g.poly([0, -r, r * 0.9, r * 0.6, -r * 0.9, r * 0.6]);
      return;
    default:
      g.circle(0, 0, r);
  }
}

function tokenSignature(t: MapToken, role: string, cell: number, theme: MapTheme): string {
  const cond = t.conditions?.map((c) => `${c.id}${c.icon ?? ""}${c.color ?? ""}${c.label}`).join(",") ?? "";
  const shape = t.shape ?? "circle";
  const h = t.health ? `${t.health.current}/${t.health.max}` : "";
  return [t.size, t.imageUrl ?? "", t.color ?? "", t.label ?? "", t.kind, t.hidden ? 1 : 0, cond, h, shape, t.number ?? "", role, cell, theme.tint, t.turn ? 1 : 0, t.effects ?? 0].join("|");
}

export class PixiMapView {
  private app: Application;
  private world = new Container();
  private bgLayer = new Container();
  private bgFill = new Graphics();
  private gridGfx = new Graphics();
  private cellsGfx = new Graphics();
  private tokenLayer = new Container();
  private selectionGfx = new Graphics();
  private overlay = new Container();
  private marqueeGfx = new Graphics();
  private rulerGfx = new Graphics();
  private rulerText: Text;
  private handlesGfx = new Graphics();
  /** Forme effimere, bozza di misura e richiami: in coordinate di mappa, sopra i token. */
  private shapesGfx = new Graphics();
  private pulseGfx = new Graphics();
  private shapeTexts: Text[] = [];
  private pulseStart = new Map<string, number>();
  private pulseInfo = new Map<string, MapPulse>();

  private views = new Map<string, TokenView>();
  private textures = new Map<string, TextureEntry>();
  private theme: MapTheme;
  private reducedMotion = false;
  private dpr = 1;

  private raf = 0;
  private lastFrame = 0;
  private disposed = false;

  private bgToken = 0;
  private bgKey = "";
  private image: HTMLImageElement | null = null;
  private plan: BackgroundPlan | null = null;
  private bgSingle: Sprite | null = null;
  private overview: Sprite | null = null;
  private tiles = new Map<string, { sprite: Sprite; used: number }>();
  private gridKey = "";
  private maxTexture = 4096;

  private fogLayer: FogLayer;
  private propLayer: PropLayer;
  private cleanup: (() => void)[] = [];
  private invalidateHook: () => void = () => {};

  private constructor(
    app: Application,
    private host: HTMLElement,
    private c: MapController
  ) {
    this.app = app;
    this.theme = readTheme(host);
    this.rulerText = new Text({ text: "", style: { fontFamily: "system-ui, sans-serif", fontSize: 13, fontWeight: "600", fill: this.theme.onTint } });
    this.rulerText.anchor.set(0.5);
    this.propLayer = new PropLayer({
      textureFor: (url) => this.textureFor(url),
      releaseTexture: (url) => this.releaseTexture(url),
    });
    this.fogLayer = new FogLayer({
      theme: () => this.theme,
      reducedMotion: () => this.reducedMotion,
      maxTexture: () => this.maxTexture,
      redraw: () => this.requestRender()
    });
  }

  /** Crea l'applicazione PixiJS sul canvas. Rifiuta se non c'e' WebGL. */
  static async create(canvas: HTMLCanvasElement, host: HTMLElement, controller: MapController): Promise<PixiMapView> {
    const app = new Application();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    await app.init({
      canvas,
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      resolution: dpr,
      autoDensity: true,
      antialias: true,
      backgroundAlpha: 0,
      autoStart: false,
      preference: "webgl",
      powerPreference: "high-performance"
    });
    const view = new PixiMapView(app, host, controller);
    view.dpr = dpr;
    view.setup();
    return view;
  }

  private setup() {
    const { app, world } = this;
    app.stage.eventMode = "none"; // gli eventi sono gestiti dal DOM (input.ts), niente hit test di Pixi
    world.isRenderGroup = true;
    // Ordine: sfondo, tessere (giocatore), griglia, aiuto di vista, velo della nebbia, muri, anteprime, token.
    world.addChild(
      this.bgLayer, this.fogLayer.tilesLayer, this.propLayer.background, this.gridGfx, this.propLayer.ground, this.fogLayer.sightGfx,
      this.fogLayer.veilLayer, this.fogLayer.wallsGfx,
      this.cellsGfx, this.fogLayer.previewGfx, this.tokenLayer, this.propLayer.above, this.shapesGfx, this.pulseGfx, this.selectionGfx
    );
    this.bgLayer.addChild(this.bgFill);
    this.overlay.addChild(this.marqueeGfx, this.rulerGfx, this.rulerText, this.handlesGfx);
    app.stage.addChild(world, this.overlay);

    const gl = (app.renderer as unknown as { gl?: WebGL2RenderingContext }).gl;
    if (gl) this.maxTexture = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096;

    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (mq) {
      this.reducedMotion = mq.matches;
      const on = () => {
        this.reducedMotion = mq.matches;
      };
      mq.addEventListener?.("change", on);
      this.cleanup.push(() => mq.removeEventListener?.("change", on));
    }
    // Cambio di tema: chiaro/scuro di sistema oppure data-theme su un antenato.
    const scheme = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    const retheme = () => this.applyTheme();
    scheme?.addEventListener?.("change", retheme);
    this.cleanup.push(() => scheme?.removeEventListener?.("change", retheme));
    if (typeof MutationObserver !== "undefined") {
      const mo = new MutationObserver(retheme);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"], subtree: true });
      this.cleanup.push(() => mo.disconnect());
    }
  }

  /** Collega la vista al controller. Separato da create(): con il doppio montaggio di StrictMode una vista gia' scartata non deve rubare il gancio. */
  attach() {
    this.invalidateHook = () => this.requestRender();
    this.c.onInvalidate = this.invalidateHook;
  }

  private applyTheme() {
    this.theme = readTheme(this.host);
    this.rulerText.style.fill = this.theme.onTint;
    for (const v of this.views.values()) v.sig = ""; // forza il ridisegno dei token
    this.gridKey = "";
    this.fogLayer.invalidate();
    this.drawBgFill();
    if (this.c.scene) this.syncTokens(this.c.scene);
    this.requestRender();
  }

  /* ---------------- API ---------------- */

  /** Applica la scena (differenze rispetto alla precedente). */
  update(scene: MapScene) {
    if (this.disposed) return;
    this.syncBackground(scene);
    this.fogLayer.sync(scene);
    this.propLayer.sync(scene);
    this.syncTokens(scene);
    this.syncHover(scene);
    this.syncPulses(scene.pulses ?? []);
    this.requestRender();
  }

  resize(width: number, height: number) {
    if (this.disposed || width <= 0 || height <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.app.renderer.resolution = dpr;
    }
    this.app.renderer.resize(width, height);
    this.c.setSize(width, height);
    this.requestRender();
  }

  /** Quanti token sono stati disegnati nell'ultimo frame (utile a test e benchmark). */
  get visibleTokenCount(): number {
    let n = 0;
    for (const v of this.views.values()) if (v.root.visible) n++;
    return n;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f());
    // Solo se il gancio e' ancora il nostro: un'altra vista potrebbe essersi collegata nel frattempo (StrictMode).
    if (this.c.onInvalidate === this.invalidateHook) this.c.onInvalidate = () => {};
    for (const v of [...this.views.values()]) this.destroyView(v);
    this.views.clear();
    this.clearBackground();
    this.fogLayer.dispose();
    this.propLayer.dispose();
    for (const e of this.textures.values()) void e.texture.then((t) => t?.destroy(true));
    this.textures.clear();
    this.app.destroy({ removeView: false }, { children: true, texture: false });
  }

  /* ---------------- sfondo ---------------- */

  private drawBgFill() {
    const bg = this.c.scene?.background;
    this.bgFill.clear();
    if (bg) this.bgFill.rect(0, 0, bg.width, bg.height).fill(this.theme.surface);
  }

  private clearBackground() {
    this.bgToken++;
    this.bgSingle?.destroy();
    this.bgSingle = null;
    if (this.overview) {
      this.overview.texture.destroy(true);
      this.overview.destroy();
      this.overview = null;
    }
    for (const t of this.tiles.values()) {
      t.sprite.texture.destroy(true);
      t.sprite.destroy();
    }
    this.tiles.clear();
    this.image = null;
    this.plan = null;
  }

  private syncBackground(scene: MapScene) {
    const bg = scene.background;
    const key = `${bg.url}|${bg.width}|${bg.height}`;
    if (key !== this.bgKey) {
      this.bgKey = key;
      this.fogLayer.reset();
      this.clearBackground();
      this.drawBgFill();
      const mine = this.bgToken;
      loadImage(bg.url)
        .then(async (img) => {
          if (mine !== this.bgToken || this.disposed) return;
          this.image = img;
          const plan = planBackground(bg, this.maxTexture);
          this.plan = plan;
          if (plan.mode === "single") {
            this.bgSingle = new Sprite(mipmapped(new ImageSource({ resource: img, autoGenerateMipmaps: true })));
            this.bgSingle.width = bg.width;
            this.bgSingle.height = bg.height;
            this.bgLayer.addChild(this.bgSingle);
          } else {
            const ov = await this.makeOverview(img, plan.overview);
            if (mine !== this.bgToken || this.disposed) {
              ov.destroy(true);
              return;
            }
            this.overview = new Sprite(ov);
            this.overview.width = bg.width;
            this.overview.height = bg.height;
            this.bgLayer.addChild(this.overview);
          }
          this.requestRender();
        })
        .catch((err: unknown) => console.error("Sfondo della mappa non caricato:", err));
    }
    const gk = `${scene.grid.cellSize}|${scene.grid.offsetX}|${scene.grid.offsetY}|${scene.grid.color}|${scene.grid.opacity}|${scene.grid.visible}|${bg.width}|${bg.height}`;
    if (gk !== this.gridKey) {
      this.gridKey = gk;
      this.drawGrid(scene);
    }
  }

  private async makeOverview(img: HTMLImageElement, size: Size): Promise<Texture> {
    if (typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(img, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" });
        return mipmapped(new ImageSource({ resource: bmp, autoGenerateMipmaps: true }));
      } catch {
        /* ripiega sul canvas */
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext("2d")?.drawImage(img, 0, 0, size.width, size.height);
    return mipmapped(new CanvasSource({ resource: canvas, autoGenerateMipmaps: true }));
  }

  /** Crea (al massimo `budget` per frame) le tessere visibili e rilascia quelle lontane. */
  private updateTiles(area: ReturnType<typeof visibleRect>, scale: number, frame: number): boolean {
    const plan = this.plan;
    if (!plan || plan.mode !== "tiled" || !this.image) return false;
    const wantDetail = needsDetail(plan, scale, this.dpr);
    const visible = wantDetail ? visibleTiles(plan, area) : [];
    const keys = new Set(visible.map((t) => t.key));
    let created = 0;
    let pending = false;
    for (const t of visible) {
      const have = this.tiles.get(t.key);
      if (have) {
        have.used = frame;
        continue;
      }
      if (created >= TILES_PER_FRAME) {
        pending = true;
        continue;
      }
      const r = tileRect(plan, t.col, t.row);
      const canvas = document.createElement("canvas");
      canvas.width = r.width;
      canvas.height = r.height;
      canvas.getContext("2d")?.drawImage(this.image, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
      const sprite = new Sprite(mipmapped(new CanvasSource({ resource: canvas, autoGenerateMipmaps: true })));
      sprite.position.set(r.x, r.y);
      this.bgLayer.addChild(sprite);
      this.tiles.set(t.key, { sprite, used: frame });
      created++;
    }
    const loaded = new Map([...this.tiles].map(([k, v]) => [k, v.used]));
    for (const k of tilesToEvict(loaded, keys, MAX_LOADED_TILES)) {
      const t = this.tiles.get(k)!;
      t.sprite.texture.destroy(true);
      t.sprite.destroy();
      this.tiles.delete(k);
    }
    // Con poco zoom le tessere non servono: liberale tutte.
    if (!wantDetail && this.tiles.size) {
      for (const t of this.tiles.values()) {
        t.sprite.texture.destroy(true);
        t.sprite.destroy();
      }
      this.tiles.clear();
    }
    return pending;
  }

  /* ---------------- griglia ---------------- */

  private drawGrid(scene: MapScene) {
    const g = this.gridGfx;
    g.clear();
    const { cellSize: c, offsetX, offsetY } = scene.grid;
    if (scene.grid.visible === false || !(c > 0)) return;
    const w = scene.background.width;
    const h = scene.background.height;
    // Tutte le linee in un unico percorso: un solo oggetto, un solo stroke.
    for (let x = ((offsetX % c) + c) % c; x <= w; x += c) g.moveTo(x, 0).lineTo(x, h);
    for (let y = ((offsetY % c) + c) % c; y <= h; y += c) g.moveTo(0, y).lineTo(w, y);
    const col = parseCssColor(scene.grid.color);
    g.stroke({ width: 1, color: col.value, alpha: scene.grid.opacity * col.alpha, pixelLine: true });
  }

  /* ---------------- token ---------------- */

  private textureFor(url: string): Promise<Texture | null> {
    let e = this.textures.get(url);
    if (!e) {
      e = {
        refs: 0,
        texture: loadImage(url)
          .then((img) => mipmapped(new ImageSource({ resource: img, autoGenerateMipmaps: true })))
          .catch(() => null)
      };
      this.textures.set(url, e);
    }
    e.refs++;
    return e.texture;
  }

  private releaseTexture(url: string) {
    const e = this.textures.get(url);
    if (!e) return;
    if (--e.refs <= 0) {
      this.textures.delete(url);
      void e.texture.then((t) => t?.destroy(true));
    }
  }

  private syncTokens(scene: MapScene) {
    const seen = new Set<string>();
    const cell = scene.grid.cellSize;
    for (const t of scene.tokens) {
      if (!isTokenShown(t, scene.role)) continue;
      seen.add(t.id);
      let v = this.views.get(t.id);
      if (!v) {
        v = this.createView(t);
        this.views.set(t.id, v);
        this.tokenLayer.addChild(v.root);
        v.x = t.x;
        v.y = t.y;
      }
      v.token = t;
      const sig = tokenSignature(t, scene.role, cell, this.theme);
      if (sig !== v.sig) {
        v.sig = sig;
        this.buildView(v, scene);
      }
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        this.destroyView(v);
        this.views.delete(id);
      }
    }
    // L'ordine dell'elenco e' l'ordine di sovrapposizione.
    let i = 0;
    for (const t of scene.tokens) {
      const v = this.views.get(t.id);
      if (v && this.tokenLayer.children[i] !== v.root) this.tokenLayer.setChildIndex(v.root, i);
      if (v) i++;
    }
  }

  /** Mostra i badge delle condizioni solo sul token sotto il puntatore. */
  private syncHover(scene: MapScene) {
    for (const v of this.views.values()) {
      if (v.badges) v.badges.alpha = v.token.id === scene.hoverTokenId ? 1 : 0;
    }
  }

  private createView(t: MapToken): TokenView {
    const root = new Container();
    const body = new Container();
    const decor = new Container();
    root.addChild(body, decor);
    return { token: t, sig: "", root, body, decor, label: null, barBg: null, barFg: null, badges: null, hpText: null, effectBadge: null, x: t.x, y: t.y, imageUrl: null, layoutKey: "", shown: true };
  }

  private destroyView(v: TokenView) {
    if (v.imageUrl) this.releaseTexture(v.imageUrl);
    v.root.destroy({ children: true });
  }

  /** (Ri)costruisce corpo e decorazioni di un token: avviene solo se cambiano i suoi dati. */
  private buildView(v: TokenView, scene: MapScene) {
    const t = v.token;
    const r = tokenRadius(t, scene.grid.cellSize);
    const theme = this.theme;
    v.body.removeChildren().forEach((ch) => ch.destroy({ children: true }));
    v.decor.removeChildren().forEach((ch) => ch.destroy({ children: true }));
    v.label = v.barBg = v.barFg = v.badges = v.hpText = v.effectBadge = null;
    v.layoutKey = "";

    const base = kindColor(theme, t.kind);
    const fill = t.color ? parseCssColor(t.color).value : base;
    const g = new Graphics();
    shapePath(g, t.shape ?? "circle", r);
    g.fill(fill);
    shapePath(g, t.shape ?? "circle", r);
    g.stroke({ width: Math.max(2, r * 0.07), color: base });
    // Tacca di orientamento: mostra la rotazione anche senza immagine.
    g.poly([-r * 0.18, -r * 0.78, r * 0.18, -r * 0.78, 0, -r * 1.02]).fill(base);
    v.body.addChild(g);
    if (t.turn) {
      // Turno corrente: anello arancione con bordo chiaro, ben visibile anche sopra mappe scure o chiare.
      const ring = new Graphics();
      ring.circle(0, 0, r * 1.14).stroke({ width: Math.max(5, r * 0.16), color: theme.onTint, alpha: 0.9 });
      ring.circle(0, 0, r * 1.14).stroke({ width: Math.max(3, r * 0.09), color: theme.orange });
      v.body.addChild(ring);
    }
    v.body.alpha = t.hidden ? 0.5 : 1;

    if (v.imageUrl !== (t.imageUrl ?? null)) {
      if (v.imageUrl) this.releaseTexture(v.imageUrl);
      v.imageUrl = t.imageUrl ?? null;
      if (v.imageUrl) void this.textureFor(v.imageUrl);
    }
    if (t.imageUrl) {
      const sig = v.sig;
      void this.textureFor(t.imageUrl).then((tex) => {
        this.releaseTexture(t.imageUrl!); // il riferimento "extra" di questa richiesta
        if (!tex || this.disposed || v.sig !== sig || v.root.destroyed) return;
        const s = new Sprite(tex);
        s.anchor.set(0.5);
        s.width = s.height = r * 1.86;
        // L'immagine segue la forma del token (la maschera non è nella scena: solo ritaglio).
        const mask = new Graphics();
        shapePath(mask, t.shape ?? "circle", r);
        mask.fill(0xffffff);
        s.mask = mask;
        v.body.addChildAt(s, 1);
        // Non impostare `mask.renderable = false`: Pixi lo gestisce da solo (la maschera non si disegna
        // in scena). Con `false` la maschera era vuota e l'immagine non compariva.
        v.body.addChildAt(mask, 2);
        this.requestRender();
      });
    }

    if (t.label) {
      v.label = new Text({
        text: t.label,
        style: { fontFamily: "system-ui, -apple-system, sans-serif", fontSize: 12, fontWeight: "600", fill: theme.label, stroke: { color: theme.surface, width: 3 } }
      });
      v.label.anchor.set(0.5, 0);
      v.decor.addChild(v.label);
    }
    if (t.health && t.health.max > 0) {
      v.barBg = new Graphics().rect(0, 0, 1, 1).fill({ color: theme.scrim, alpha: 0.85 });
      const ratio = Math.min(1, Math.max(0, t.health.current / t.health.max));
      v.barFg = new Graphics().rect(0, 0, 1, 1).fill(healthColor(theme, ratio));
      v.barFg.scale.x = ratio;
      v.decor.addChild(v.barBg, v.barFg);
      // Numeri: attuali/massimi (+temporanei), come chiesto dal GM.
      const temp = t.health.temp ?? 0;
      v.hpText = new Text({
        text: `${t.health.current}/${t.health.max}${temp > 0 ? ` +${temp}` : ""}`,
        style: { fontFamily: "system-ui, sans-serif", fontSize: 10, fontWeight: "600", fill: theme.label, stroke: { color: theme.scrim, width: 3 } }
      });
      v.hpText.anchor.set(0.5, 0);
      v.decor.addChild(v.hpText);
    }
    if (t.conditions?.length) {
      v.badges = new Container();
      const shown = t.conditions.slice(0, 5);
      shown.forEach((cnd, i) => {
        const col = cnd.color ? parseCssColor(cnd.color).value : theme.tint;
        const b = new Container();
        b.addChild(new Graphics().circle(0, 0, 9).fill(col).stroke({ width: 1.5, color: theme.scrim }));
        const glyph = new Text({ text: cnd.icon ?? cnd.label.slice(0, 1).toUpperCase(), style: { fontFamily: "system-ui, sans-serif", fontSize: 11, fontWeight: "700", fill: theme.onTint } });
        glyph.anchor.set(0.5);
        b.addChild(glyph);
        b.position.set((i - (shown.length - 1) / 2) * 20, 0);
        v.badges!.addChild(b);
      });
      v.badges.alpha = 0; // visibili solo con il puntatore sopra (vedi syncTokens)
      v.decor.addChild(v.badges);
    }
    if (t.number !== undefined && t.number !== null) {
      // Numero del token: distingue i personaggi in battaglia (angolo in alto a sinistra).
      const nb = new Container();
      nb.label = "number-badge";
      const disc = new Graphics().circle(0, 0, 9).fill({ color: theme.scrim, alpha: 0.92 });
      const txt = new Text({ text: String(t.number), style: { fontFamily: "system-ui, sans-serif", fontSize: 11, fontWeight: "700", fill: theme.label } });
      txt.anchor.set(0.5);
      nb.addChild(disc, txt);
      v.decor.addChild(nb);
    }
    if (t.effects) {
      v.effectBadge = new Container();
      v.effectBadge.addChild(new Graphics().circle(0, 0, 9).fill(theme.orange).stroke({ width: 1.5, color: theme.scrim }));
      const n = new Text({ text: String(t.effects), style: { fontFamily: "system-ui, sans-serif", fontSize: 10, fontWeight: "700", fill: theme.onTint } });
      n.anchor.set(0.5);
      v.effectBadge.addChild(n);
      v.decor.addChild(v.effectBadge);
    }
    if (t.hidden) {
      // Icona "occhio barrato" per i token nascosti (visibili solo al GM).
      const eye = new Graphics();
      eye.circle(0, 0, 10).fill({ color: theme.scrim, alpha: 0.9 });
      eye.ellipse(0, 0, 6, 3.5).stroke({ width: 1.5, color: theme.label });
      eye.moveTo(-6, 6).lineTo(6, -6).stroke({ width: 1.5, color: theme.red });
      eye.label = "hidden-icon";
      v.decor.addChild(eye);
    }
  }

  /** Dimensioni delle decorazioni in pixel schermo (le decorazioni non scalano con lo zoom). */
  private layoutDecor(v: TokenView, effSize: number, scale: number, cell: number) {
    const key = `${effSize}|${scale}`;
    if (key === v.layoutKey) return;
    v.layoutKey = key;
    const rs = (effSize * cell * scale) / 2; // raggio in pixel schermo
    v.decor.scale.set(1 / scale);
    const small = rs < 10;
    if (v.label) {
      v.label.visible = !small;
      v.label.position.set(0, rs + 3);
    }
    if (v.barBg && v.barFg) {
      const w = Math.max(16, rs * 1.8);
      const y = v.label && !small ? rs + 18 : rs + 3;
      for (const b of [v.barBg, v.barFg]) {
        b.visible = !small || rs > 4;
        b.position.set(-w / 2, y);
        b.scale.y = 5;
      }
      v.barBg.scale.x = w;
      const ratio = v.token.health ? Math.min(1, Math.max(0, v.token.health.current / v.token.health.max)) : 0;
      v.barFg.scale.x = w * ratio;
      if (v.hpText) {
        v.hpText.visible = !small;
        v.hpText.position.set(0, y + 8);
      }
    }
    if (v.badges) {
      v.badges.visible = !small;
      v.badges.position.set(0, -rs - 12);
    }
    if (v.effectBadge) v.effectBadge.position.set(-rs * 0.7, -rs * 0.7);
    const icon = v.decor.getChildByLabel("hidden-icon");
    if (icon) icon.position.set(rs * 0.7, -rs * 0.7);
    const nb = v.decor.getChildByLabel("number-badge");
    if (nb) {
      nb.visible = !small;
      nb.position.set(-rs * 0.72, -rs * 0.72);
    }
  }

  /* ---------------- frame ---------------- */

  requestRender() {
    if (this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.disposed) return;
    const t0 = performance.now();
    const c = this.c;
    const scene = c.scene;
    const dt = this.lastFrame ? Math.min(64, now - this.lastFrame) : 16;
    this.lastFrame = now;
    if (!scene) {
      this.app.renderer.render(this.app.stage);
      return;
    }
    const vp = c.viewport;
    const s = vp.scale;
    this.world.position.set(vp.x, vp.y);
    this.world.scale.set(s);

    const cell = scene.grid.cellSize;
    const area = visibleRect(vp, c.size);
    let animating = false;

    // Griglia: nascosta quando le celle sono troppo piccole per essere utili.
    this.gridGfx.visible = scene.grid.visible !== false && cell * s >= GRID_MIN_SCREEN_CELL;

    const pending = this.updateTiles(area, s, now);
    if (this.fogLayer.frame(dt, s, c)) animating = true;
    if (this.propLayer.frame(dt, this.reducedMotion)) animating = true;

    // Token: posizione (con transizione), culling, decorazioni.
    const pad = cell * DECOR_PAD_CELLS;
    const handle = c.handlePreview;
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt / (EASE_MS / 3));
    for (const [id, v] of this.views) {
      const t = v.token;
      const dragged = c.preview.get(id);
      const tx = dragged?.x ?? t.x;
      const ty = dragged?.y ?? t.y;
      if (dragged || this.reducedMotion) {
        v.x = tx;
        v.y = ty;
      } else if (v.x !== tx || v.y !== ty) {
        v.x += (tx - v.x) * k;
        v.y += (ty - v.y) * k;
        if (Math.abs(tx - v.x) < 0.25 && Math.abs(ty - v.y) < 0.25) {
          v.x = tx;
          v.y = ty;
        } else animating = true;
      }
      const effSize = handle?.id === id && handle.size !== undefined ? handle.size : t.size;
      const effRot = handle?.id === id && handle.rotation !== undefined ? handle.rotation : t.rotation;
      const r = (effSize * cell) / 2 + pad;
      const vis = rectsIntersect({ x: v.x - r, y: v.y - r, width: r * 2, height: r * 2 }, area);
      v.root.visible = vis;
      if (!vis) continue;
      v.root.position.set(v.x, v.y);
      v.body.rotation = (effRot * Math.PI) / 180;
      v.body.scale.set(effSize / t.size);
      this.layoutDecor(v, effSize, s, cell);
    }

    this.drawSelection(s, cell);
    this.drawCells(s);
    if (this.drawShapes(scene, s, cell)) animating = true;
    if (this.drawPulses(s, cell, now)) animating = true;
    this.drawOverlay(s);

    this.app.renderer.render(this.app.stage);
    if (import.meta.env.DEV) {
      // Tempo CPU del frame (logica + invio dei comandi alla GPU), per il benchmark in pagina.
      const g = globalThis as unknown as { __mapFrameMs?: number[] };
      (g.__mapFrameMs ??= []).push(performance.now() - t0);
    }
    if (animating || pending) this.requestRender();
  };

  /* ---------------- richiami sui token ---------------- */

  private syncPulses(pulses: readonly MapPulse[]) {
    const now = performance.now();
    const live = new Set(pulses.map((p) => p.key));
    for (const p of pulses) {
      if (!this.pulseStart.has(p.key)) {
        this.pulseStart.set(p.key, now);
        this.pulseInfo.set(p.key, p);
      }
    }
    // Un richiamo gia' finito e non piu' richiesto si dimentica (non puo' ripartire).
    for (const [key, start] of this.pulseStart) {
      if (!live.has(key) && now - start > PULSE_STATIC_MS) {
        this.pulseStart.delete(key);
        this.pulseInfo.delete(key);
      }
    }
  }

  private drawPulses(scale: number, cell: number, now: number): boolean {
    const g = this.pulseGfx;
    g.clear();
    let animating = false;
    const th = this.theme;
    for (const [key, start] of this.pulseStart) {
      const info = this.pulseInfo.get(key);
      const v = info ? this.views.get(info.tokenId) : undefined;
      if (!info || !v || !v.root.visible) continue;
      const dur = this.reducedMotion ? PULSE_STATIC_MS : PULSE_MS;
      const t = (now - start) / dur;
      if (t >= 1) continue;
      const color = info.kind === "expired" ? th.gray : info.kind === "warn" ? th.orange : th.tint;
      const base = (v.token.size * cell) / 2;
      if (this.reducedMotion) {
        // Niente movimento: un anello fermo che si dissolve.
        g.circle(v.x, v.y, base * 1.25).stroke({ width: 4 / scale, color, alpha: 0.75 * (1 - t) });
      } else {
        const e = 1 - (1 - t) ** 3;
        g.circle(v.x, v.y, base * (1.1 + 0.9 * e)).stroke({ width: (5 - 3 * t) / scale, color, alpha: 0.85 * (1 - t) });
        animating = true;
      }
    }
    return animating;
  }

  /* ---------------- forme effimere e bozza di misura ---------------- */

  private shapeText(i: number): Text {
    let t = this.shapeTexts[i];
    if (!t) {
      t = new Text({ text: "", style: { fontFamily: "system-ui, -apple-system, sans-serif", fontSize: 13, fontWeight: "600", fill: this.theme.label, stroke: { color: this.theme.surface, width: 4 } } });
      t.anchor.set(0.5);
      this.overlay.addChild(t);
      this.shapeTexts[i] = t;
    }
    t.style.fill = this.theme.label;
    t.style.stroke = { color: this.theme.surface, width: 4 };
    return t;
  }

  /** Disegna forme effimere e bozza. Ritorna true se serve un altro frame (dissolvenza o ping in corso). */
  private drawShapes(scene: MapScene, scale: number, cell: number): boolean {
    const g = this.shapesGfx;
    g.clear();
    let textCount = 0;
    const place = (text: string, mapPoint: Point) => {
      if (!text) return;
      const t = this.shapeText(textCount++);
      t.text = text;
      const sp = this.toScreen(mapPoint);
      t.position.set(sp.x, sp.y);
      t.visible = true;
    };
    const now = Date.now();
    let animating = false;
    const items: MapEphemeral[] = [...(scene.ephemerals ?? [])];
    for (const e of items) {
      const remaining = e.expiresAt - now;
      if (remaining <= 0) continue;
      const alpha = ephemeralAlpha(remaining, FADE_MS, this.reducedMotion);
      const color = e.color ? parseCssColor(e.color).value : this.theme.tint;
      if (e.shape.kind === "cells") {
        const geo = scene.fog?.geometry;
        if (!geo) continue;
        for (const r of cellRects(e.shape.cells, geo)) {
          g.rect(r.x, r.y, r.width, r.height).fill({ color, alpha: 0.3 * alpha }).stroke({ width: 1.5 / scale, color, alpha: 0.8 * alpha });
        }
      } else {
        const phase = this.reducedMotion ? 0.5 : (now % 1200) / 1200;
        this.drawShape(g, e.shape, color, alpha, scale, cell, phase);
        place(measureLabel(e.shape, cell, scene.scale, scene.rulerMode), this.labelAnchor(e.shape, cell));
        if (e.shape.kind === "ping" && e.shape.label) place(e.shape.label, { x: e.shape.x, y: e.shape.y + cell * 0.95 });
      }
      if (!this.reducedMotion) animating = true;
    }
    const draft = this.c.shapeDraft;
    if (draft) {
      this.drawShape(g, draft.shape, this.theme.tint, 1, scale, cell, 0.5);
      place(draft.text, this.labelAnchor(draft.shape, cell));
    }
    for (let i = textCount; i < this.shapeTexts.length; i++) this.shapeTexts[i]!.visible = false;
    return animating;
  }

  private labelAnchor(shape: Shape, cell: number): Point {
    switch (shape.kind) {
      case "ruler": {
        const a = shape.points[0]!;
        const b = shape.points[shape.points.length - 1]!;
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - cell * 0.35 };
      }
      case "circle":
        return { x: shape.x, y: shape.y - shape.radius - cell * 0.35 };
      case "cone": {
        const d = (shape.direction * Math.PI) / 180;
        return { x: shape.x + (Math.cos(d) * shape.length) / 2, y: shape.y + (Math.sin(d) * shape.length) / 2 - cell * 0.35 };
      }
      case "line":
        return { x: (shape.x1 + shape.x2) / 2, y: (shape.y1 + shape.y2) / 2 - cell * 0.6 };
      default:
        return { x: 0, y: 0 };
    }
  }

  private drawShape(g: Graphics, shape: Shape, color: number, alpha: number, scale: number, cell: number, phase: number) {
    const stroke = { width: 2.5 / scale, color, alpha: 0.95 * alpha };
    const poly = outlinePolygon(shape);
    if (poly) {
      g.poly(poly, true).fill({ color, alpha: 0.2 * alpha }).stroke(stroke);
      if (shape.kind === "circle") g.circle(shape.x, shape.y, 3 / scale).fill({ color, alpha });
      return;
    }
    if (shape.kind === "ruler") {
      const pts = shape.points;
      g.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
      g.stroke({ width: 3 / scale, color, alpha: 0.95 * alpha });
      for (const p of pts) g.circle(p.x, p.y, 5 / scale).fill({ color, alpha });
    } else if (shape.kind === "arrow") {
      const dx = shape.x2 - shape.x1;
      const dy = shape.y2 - shape.y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const head = Math.min(len * 0.5, 18 / scale);
      g.moveTo(shape.x1, shape.y1).lineTo(shape.x2 - ux * head * 0.6, shape.y2 - uy * head * 0.6).stroke({ width: 4 / scale, color, alpha: 0.9 * alpha });
      g.poly([shape.x2, shape.y2, shape.x2 - ux * head - uy * head * 0.55, shape.y2 - uy * head + ux * head * 0.55, shape.x2 - ux * head + uy * head * 0.55, shape.y2 - uy * head - ux * head * 0.55]).fill({ color, alpha });
    } else if (shape.kind === "ping") {
      const r = cell * (0.3 + 0.5 * phase);
      g.circle(shape.x, shape.y, cell * 0.12).fill({ color, alpha });
      g.circle(shape.x, shape.y, r).stroke({ width: 3 / scale, color, alpha: alpha * (1 - 0.6 * phase) });
    }
  }

  private drawSelection(scale: number, cell: number) {
    const g = this.selectionGfx;
    g.clear();
    const c = this.c;
    for (const id of c.selection) {
      const v = this.views.get(id);
      if (!v || !v.root.visible) continue;
      const hp = c.handlePreview?.id === id ? c.handlePreview.size : undefined;
      const r = (((hp ?? v.token.size) * cell) / 2) + 3 / scale;
      g.circle(v.x, v.y, r).stroke({ width: 3 / scale, color: this.theme.tint });
    }
  }

  private drawCells(scale: number) {
    const g = this.cellsGfx;
    g.clear();
    for (const r of this.c.previewCells) {
      g.rect(r.x, r.y, r.width, r.height).fill({ color: this.theme.tint, alpha: 0.22 }).stroke({ width: 2 / scale, color: this.theme.tint, alpha: 0.9 });
    }
  }

  private toScreen(p: Point): Point {
    const vp = this.c.viewport;
    return { x: p.x * vp.scale + vp.x, y: p.y * vp.scale + vp.y };
  }

  private drawOverlay(scale: number) {
    const c = this.c;
    const th = this.theme;
    const m = this.marqueeGfx;
    m.clear();
    if (c.marquee) {
      m.rect(c.marquee.x, c.marquee.y, c.marquee.width, c.marquee.height).fill({ color: th.tint, alpha: 0.14 }).stroke({ width: 1, color: th.tint, alpha: 0.9 });
    }

    const rg = this.rulerGfx;
    rg.clear();
    const ruler = c.ruler;
    this.rulerText.visible = !!ruler;
    if (ruler) {
      const a = this.toScreen(ruler.a);
      const b = this.toScreen(ruler.b);
      rg.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 5, color: th.scrim, alpha: 0.5 });
      rg.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 2.5, color: th.tint });
      rg.circle(a.x, a.y, 5).fill(th.tint);
      rg.circle(b.x, b.y, 5).fill(th.tint);
      if (this.rulerText.text !== ruler.text) this.rulerText.text = ruler.text;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 18 };
      const w = this.rulerText.width + 16;
      rg.roundRect(mid.x - w / 2, mid.y - 12, w, 24, 12).fill(th.tint);
      this.rulerText.position.set(mid.x, mid.y);
    }

    const hg = this.handlesGfx;
    hg.clear();
    const h = c.handles();
    if (h) {
      const t = this.views.get(h.tokenId);
      if (t) {
        const ctr = this.toScreen({ x: t.x, y: t.y });
        const rot = this.toScreen(h.rotate);
        const rs = this.toScreen(h.resize);
        hg.moveTo(ctr.x, ctr.y).lineTo(rot.x, rot.y).stroke({ width: 1.5, color: th.tint, alpha: 0.8 });
        hg.circle(rot.x, rot.y, 9).fill(th.tint).stroke({ width: 2, color: th.onTint });
        hg.roundRect(rs.x - 8, rs.y - 8, 16, 16, 4).fill(th.tint).stroke({ width: 2, color: th.onTint });
      }
    }
    void scale;
  }
}
