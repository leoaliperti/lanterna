// Scena Three.js dei dadi. E' l'unico file (con le sue dipendenze) che importa "three":
// si carica con import() dinamico solo quando serve, cosi' non pesa sul bundle iniziale.
//
// Ripreso da DiceGen (MIT, stesso autore): camera, luci, etichette sulle facce, ingresso dei dadi
// lanciati da fuori tavolo. Cambiato: l'esito non si sceglie qui (arriva in `PhysicalDie.value`),
// il rendering avviene solo durante l'animazione e ogni risorsa GPU viene rilasciata in dispose().

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DirectionalLight,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { type RollPlan, planRoll, samplePlan } from "./animation";
import { type DieKind, type PhysicalDie, KIND_SHAPES, getLayout, labelRight, labelText } from "./dice";
import { layoutTable } from "./layout";
import type { Vec3 } from "./math";
import { type Shape, getPolyhedron, triangulate } from "./polyhedra";

const DIE_SCALE = 0.8;
const LABEL_LIFT = 0.004;

const COLORS: Record<DieKind, string> = {
  d4: "#c2412d",
  d6: "#2f6fb0",
  d8: "#3f8f5a",
  d10: "#8a4fb0",
  d12: "#c98a1b",
  d20: "#1f8a8a",
  d10tens: "#5b5b8f",
  d10units: "#7b7bb0",
};

interface ActiveDie {
  readonly group: Group;
  readonly inradius: number;
  plan: RollPlan;
  restY: number;
  done: boolean;
}

const v3 = (v: Vec3) => new Vector3(v[0], v[1], v[2]);

export class DiceScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(34, 1, 0.1, 100);
  private dice: ActiveDie[] = [];
  private t0 = 0;
  private raf = 0;
  private finish: (() => void) | null = null;
  private disposed = false;
  private width = 1;
  private height = 1;

  // Risorse condivise, rilasciate in dispose().
  private readonly geometries = new Map<Shape, BufferGeometry>();
  private readonly edges = new Map<Shape, EdgesGeometry>();
  private readonly planes = new Map<string, PlaneGeometry>();
  private readonly bodyMaterials = new Map<DieKind, MeshStandardMaterial>();
  private readonly labelMaterials = new Map<string, MeshBasicMaterial>();
  private readonly textures: CanvasTexture[] = [];
  private readonly lineMaterial = new LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 });

  /** Lancia un'eccezione se il contesto WebGL non si puo' creare. */
  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.camera.position.set(0, 8.5, 7.5);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(new AmbientLight(0xffffff, 0.6));
    const key = new DirectionalLight(0xffffff, 1.2);
    key.position.set(4, 10, 6);
    const fill = new DirectionalLight(0xffffff, 0.4);
    fill.position.set(-5, 6, -3);
    this.scene.add(key, fill);
  }

  /** Anima i dadi fino a fermarli sul valore ricevuto. Risolve a fine animazione o se interrotta da un nuovo tiro. */
  roll(dice: readonly PhysicalDie[], reducedMotion: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.cancel();
    this.clearDice();
    const { positions, scale } = this.layout(dice.length);
    dice.forEach((die, i) => {
      const group = this.buildDie(die.kind);
      const inradius = getPolyhedron(KIND_SHAPES[die.kind]).inradius;
      const target = positions[i] as { x: number; z: number };
      group.scale.setScalar(DIE_SCALE * scale);
      this.scene.add(group);
      this.dice.push({
        group,
        inradius,
        plan: planRoll({ kind: die.kind, value: die.value, target, reducedMotion }),
        restY: inradius * DIE_SCALE * scale,
        done: false,
      });
    });
    this.t0 = performance.now();
    this.apply(0);
    this.renderOnce();
    if (this.dice.every((d) => d.done)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.finish = resolve;
      this.raf = requestAnimationFrame(this.frame);
    });
  }

  clear(): void {
    this.cancel();
    this.clearDice();
    this.renderOnce();
  }

  resize(width: number, height: number): void {
    if (this.disposed || width < 1 || height < 1) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.dice.length) {
      const { positions, scale } = this.layout(this.dice.length);
      this.dice.forEach((d, i) => {
        const p = positions[i] as { x: number; z: number };
        d.plan = { ...d.plan, to: [p.x, 0, p.z] };
        d.group.scale.setScalar(DIE_SCALE * scale);
        d.restY = d.inradius * DIE_SCALE * scale;
      });
      if (!this.raf) this.apply(Number.POSITIVE_INFINITY);
    }
    if (!this.raf) this.renderOnce();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.clearDice();
    for (const g of this.geometries.values()) g.dispose();
    for (const g of this.edges.values()) g.dispose();
    for (const g of this.planes.values()) g.dispose();
    for (const m of this.bodyMaterials.values()) m.dispose();
    for (const m of this.labelMaterials.values()) m.dispose();
    for (const t of this.textures) t.dispose();
    this.lineMaterial.dispose();
    this.geometries.clear();
    this.edges.clear();
    this.planes.clear();
    this.bodyMaterials.clear();
    this.labelMaterials.clear();
    this.textures.length = 0;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // ---- interno ----

  private readonly frame = (now: number): void => {
    this.raf = 0;
    if (this.disposed) return;
    this.apply(now - this.t0);
    this.renderOnce();
    if (this.dice.every((d) => d.done)) {
      const finish = this.finish;
      this.finish = null;
      finish?.();
    } else {
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  /** Ferma il ciclo di rendering e risolve la promessa del tiro in corso. */
  private cancel(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    const finish = this.finish;
    this.finish = null;
    finish?.();
  }

  private apply(elapsedMs: number): void {
    for (const d of this.dice) {
      const s = samplePlan(d.plan, elapsedMs, d.restY);
      d.group.quaternion.set(s.quaternion[0], s.quaternion[1], s.quaternion[2], s.quaternion[3]);
      d.group.position.set(s.position[0], s.position[1], s.position[2]);
      d.done = s.done;
    }
  }

  private renderOnce(): void {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  }

  private layout(count: number) {
    const dist = this.camera.position.length();
    const visH = 2 * dist * Math.tan((this.camera.fov * Math.PI) / 360);
    const visW = visH * (this.width / this.height);
    return layoutTable(count, visW * 0.92, visH * 0.92);
  }

  private clearDice(): void {
    for (const d of this.dice) this.scene.remove(d.group); // geometrie e materiali sono condivisi: si rilasciano in dispose()
    this.dice = [];
  }

  private buildDie(kind: DieKind): Group {
    const shape = KIND_SHAPES[kind];
    const poly = getPolyhedron(shape);
    let geometry = this.geometries.get(shape);
    if (!geometry) {
      geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(triangulate(poly), 3));
      this.geometries.set(shape, geometry);
    }
    let edges = this.edges.get(shape);
    if (!edges) {
      edges = new EdgesGeometry(geometry, 20);
      this.edges.set(shape, edges);
    }
    let body = this.bodyMaterials.get(kind);
    if (!body) {
      body = new MeshStandardMaterial({ color: COLORS[kind], roughness: 0.35, metalness: 0.05, flatShading: true });
      this.bodyMaterials.set(kind, body);
    }
    const group = new Group();
    group.add(new Mesh(geometry, body), new LineSegments(edges, this.lineMaterial));
    for (const p of getLayout(kind).placements) {
      const label = new Mesh(this.plane(p.size), this.labelMaterial(labelText(kind, p.value)));
      label.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(v3(labelRight(p)), v3(p.up), v3(p.normal)));
      label.position.copy(v3(p.position)).addScaledVector(v3(p.normal), LABEL_LIFT);
      group.add(label);
    }
    return group;
  }

  private plane(size: number): PlaneGeometry {
    const key = size.toFixed(4);
    let g = this.planes.get(key);
    if (!g) {
      g = new PlaneGeometry(size, size);
      this.planes.set(key, g);
    }
    return g;
  }

  private labelMaterial(text: string): MeshBasicMaterial {
    let m = this.labelMaterials.get(text);
    if (!m) {
      const texture = labelTexture(text);
      this.textures.push(texture);
      m = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      this.labelMaterials.set(text, m);
    }
    return m;
  }
}

function labelTexture(text: string): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d");
  if (x) {
    x.fillStyle = "#ffffff";
    x.font = text.length > 1 ? "bold 64px system-ui, sans-serif" : "bold 80px system-ui, sans-serif";
    x.textAlign = "center";
    x.textBaseline = "middle";
    x.shadowColor = "rgba(0,0,0,0.45)";
    x.shadowBlur = 8;
    x.fillText(text, 64, 64);
    if (text === "6" || text === "9") {
      // Sottolineatura per distinguere 6 e 9 quando il dado e' girato.
      x.fillRect(40, 112, 48, 8);
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
