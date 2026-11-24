import { Container, Sprite, type Texture } from "pixi.js";
import { fadeFactorStep, propFadeTargets } from "./propLogic";
import type { MapProp, MapScene } from "./types";

/**
 * Oggetti di scena su livelli (M10). Il canvas mostra cio' che il server ha inviato: non decide chi vede cosa.
 * I tre contenitori vanno nel mondo: `background` sotto la griglia, `ground` sotto la nebbia e i token,
 * `above` sopra i token. Gli `above` con `fade` si schiariscono quando un token del giocatore e' sotto.
 */
export interface PropLayerHost {
  textureFor(url: string): Promise<Texture | null>;
  releaseTexture(url: string): void;
}

interface Entry {
  prop: MapProp;
  sprite: Sprite;
  url: string;
  /** 0 = pieno, 1 = schiarito del tutto. */
  fade: number;
  alive: boolean;
}

export class PropLayer {
  readonly background = new Container();
  readonly ground = new Container();
  readonly above = new Container();
  private entries = new Map<string, Entry>();
  private targets = new Set<string>();

  constructor(private host: PropLayerHost) {}

  private container(layer: MapProp["layer"]): Container {
    return layer === "background" ? this.background : layer === "ground" ? this.ground : this.above;
  }

  /** Allinea gli sprite alla scena (per id). */
  sync(scene: MapScene) {
    const props = scene.objects ?? [];
    const seen = new Set<string>();
    for (const p of props) {
      seen.add(p.id);
      let e = this.entries.get(p.id);
      if (e && e.url !== p.url) {
        this.destroy(e);
        this.entries.delete(p.id);
        e = undefined;
      }
      if (!e) {
        const sprite = new Sprite();
        sprite.anchor.set(0.5);
        e = { prop: p, sprite, url: p.url, fade: 0, alive: true };
        this.entries.set(p.id, e);
        const entry = e;
        void this.host.textureFor(p.url).then((tex) => {
          if (entry.alive && tex) {
            entry.sprite.texture = tex;
            this.layout(entry);
          }
        });
      }
      e.prop = p;
      const parent = this.container(p.layer);
      if (e.sprite.parent !== parent) parent.addChild(e.sprite);
      this.layout(e);
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        this.destroy(e);
        this.entries.delete(id);
      }
    }
    // L'ordine dell'elenco e' l'ordine di sovrapposizione dentro il livello.
    for (const layer of ["background", "ground", "above"] as const) {
      const c = this.container(layer);
      let i = 0;
      for (const p of props) {
        const e = this.entries.get(p.id);
        if (e && p.layer === layer) c.setChildIndex(e.sprite, i++);
      }
    }
    this.targets = propFadeTargets(props, scene);
  }

  private layout(e: Entry) {
    const { prop, sprite } = e;
    sprite.position.set(prop.x, prop.y);
    sprite.width = prop.width;
    sprite.height = prop.height;
    sprite.rotation = (prop.rotation * Math.PI) / 180;
  }

  /** Dissolvenza per frame; `true` finche' c'e' un'animazione in corso. */
  frame(dt: number, reducedMotion: boolean): boolean {
    let animating = false;
    for (const e of this.entries.values()) {
      const goal = this.targets.has(e.prop.id) ? 1 : 0;
      const next = reducedMotion ? goal : fadeFactorStep(e.fade, goal, dt);
      if (next !== goal) animating = true;
      e.fade = next;
      e.sprite.alpha = e.prop.opacity * (e.prop.hidden ? 0.4 : 1) * (1 - 0.75 * next);
    }
    return animating;
  }

  dispose() {
    for (const e of this.entries.values()) this.destroy(e);
    this.entries.clear();
  }

  private destroy(e: Entry) {
    e.alive = false;
    e.sprite.destroy();
    this.host.releaseTexture(e.url);
  }
}
