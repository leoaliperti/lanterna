// Tipi dei dadi e mappatura valore -> faccia, tutta in funzioni pure.
//
// Convenzioni (verificate in dice.test.ts):
//  - d6, d8, d10, d12, d20: il valore e' scritto sulla faccia. Il dado e' letto sulla faccia
//    rivolta VERSO L'ALTO. Le facce opposte sommano (min + max): 7 sul d6, 9 sul d8, 11 sul d10, 13 sul d12, 21 sul d20.
//  - d4: un tetraedro poggiato su una faccia ha in alto un vertice, non una faccia. Il valore
//    appartiene al VERTICE: ogni faccia riporta i tre numeri dei propri vertici, ciascuno vicino al suo
//    vertice, e il risultato e' il numero del vertice in ALTO (lo stesso dei dadi veri a 3 numeri per faccia).
//    La faccia poggiata sul tavolo e' quella opposta a quel vertice.
//  - d10: numerato 1..10 (la faccia "10" mostra "10", non "0").
//  - d%: coppia di d10, decine (00, 10, ... 90) e unita' (0..9). 00 + 0 = 100.
//
// Math.random non compare mai in questo file: l'esito arriva sempre dal chiamante (il server).

import { type Quat, type Vec3, UP, add, cross, normalize, quatFromAxisAngle, quatFromUnitVectors, quatMul, quatRotate, scale, sub, dot } from "./math";
import { type Polyhedron, type Shape, getPolyhedron } from "./polyhedra";

export const DICE_SIDES = [4, 6, 8, 10, 12, 20, 100] as const;
export type DieSides = (typeof DICE_SIDES)[number];

export interface DieRequest {
  readonly sides: DieSides;
  readonly value: number;
}

/** Dado fisico sul tavolo. Il d% ne usa due (decine e unita'). */
export type DieKind = "d4" | "d6" | "d8" | "d10" | "d12" | "d20" | "d10tens" | "d10units";

export interface PhysicalDie {
  readonly kind: DieKind;
  readonly value: number;
  /** Indice della richiesta di origine. */
  readonly request: number;
}

interface KindSpec {
  readonly shape: Shape;
  /** Valori mostrati dal dado, in ordine crescente. */
  readonly labels: readonly number[];
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const KIND_SPECS: Record<DieKind, KindSpec> = {
  d4: { shape: "tetrahedron", labels: range(1, 4) },
  d6: { shape: "cube", labels: range(1, 6) },
  d8: { shape: "octahedron", labels: range(1, 8) },
  d10: { shape: "trapezohedron", labels: range(1, 10) },
  d12: { shape: "dodecahedron", labels: range(1, 12) },
  d20: { shape: "icosahedron", labels: range(1, 20) },
  d10tens: { shape: "trapezohedron", labels: range(0, 9).map((d) => d * 10) },
  d10units: { shape: "trapezohedron", labels: range(0, 9) },
};

export const KIND_SHAPES: Readonly<Record<DieKind, Shape>> = Object.fromEntries(
  Object.entries(KIND_SPECS).map(([k, s]) => [k, s.shape]),
) as Record<DieKind, Shape>;

export function kindValues(kind: DieKind): readonly number[] {
  return KIND_SPECS[kind].labels;
}

/** Testo scritto sulla faccia (il d% delle decine mostra 00, 10, ... 90). */
export function labelText(kind: DieKind, value: number): string {
  return kind === "d10tens" ? String(value).padStart(2, "0") : String(value);
}

// ---------- Richieste ----------

export function isDieSides(n: unknown): n is DieSides {
  return (DICE_SIDES as readonly unknown[]).includes(n);
}

export function validateRequest(die: DieRequest): void {
  if (!isDieSides(die.sides)) throw new RangeError(`Dado non supportato: d${String(die.sides)}`);
  if (!Number.isInteger(die.value) || die.value < 1 || die.value > die.sides) {
    throw new RangeError(`Valore ${die.value} fuori intervallo per d${die.sides}`);
  }
}

/** d% -> decine + unita'. 100 diventa 00 + 0; da 1 a 99 le decine sono 00..90. */
export function splitPercentile(value: number): { tens: number; units: number } {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new RangeError(`Valore d% non valido: ${value}`);
  if (value === 100) return { tens: 0, units: 0 };
  return { tens: Math.floor(value / 10) * 10, units: value % 10 };
}

/** Operazione inversa: 00 + 0 = 100. */
export function combinePercentile(tens: number, units: number): number {
  return tens + units === 0 ? 100 : tens + units;
}

export function expandRequests(requests: readonly DieRequest[]): PhysicalDie[] {
  const out: PhysicalDie[] = [];
  requests.forEach((die, request) => {
    validateRequest(die);
    if (die.sides === 100) {
      const { tens, units } = splitPercentile(die.value);
      out.push({ kind: "d10tens", value: tens, request }, { kind: "d10units", value: units, request });
    } else {
      out.push({ kind: `d${die.sides}` as DieKind, value: die.value, request });
    }
  });
  return out;
}

/** Riepilogo testuale, es. "d20 14 · d6 3". Usato anche come fallback senza WebGL. */
export function formatResults(requests: readonly DieRequest[]): string {
  const label = (d: DieRequest) => (d.sides === 100 ? "d%" : `d${d.sides}`);
  return requests.map((d) => `${label(d)} ${d.value}`).join(" · ");
}

// ---------- Mappatura valore -> faccia ----------

export interface LabelPlacement {
  readonly value: number;
  readonly position: Vec3;
  readonly normal: Vec3;
  /** Direzione "su" del testo, nel piano della faccia. */
  readonly up: Vec3;
  readonly size: number;
}

export interface DieLayout {
  readonly kind: DieKind;
  readonly poly: Polyhedron;
  readonly placements: readonly LabelPlacement[];
  /**
   * Direzione (nel sistema del dado) che deve puntare verso l'alto perche' il dado mostri il valore:
   * la normale della faccia, o per il d4 la direzione del vertice.
   */
  readonly readouts: ReadonlyMap<number, Vec3>;
}

/**
 * Assegna i valori alle facce: in ordine, e l'opposta di ciascuna riceve il valore complementare
 * (min + max). Restituisce il valore per ogni indice di faccia. Solo per solidi con facce opposte a coppie.
 */
export function assignFaceValues(poly: Polyhedron, labels: readonly number[]): number[] {
  const n = poly.faces.length;
  if (labels.length !== n) throw new Error(`${labels.length} valori per ${n} facce`);
  const result: (number | undefined)[] = new Array<number | undefined>(n).fill(undefined);
  let p = 0;
  for (let i = 0; i < n; i++) {
    if (result[i] !== undefined) continue;
    const ni = (poly.faces[i] as { normal: Vec3 }).normal;
    const opposite = poly.faces.findIndex((f, j) => j !== i && dot(f.normal, ni) < -1 + 1e-6);
    if (opposite < 0) throw new Error("Solido senza facce opposte: non gestito");
    result[i] = labels[p] as number;
    result[opposite] = labels[n - 1 - p] as number;
    p++;
  }
  return result as number[];
}

const layouts = new Map<DieKind, DieLayout>();

export function getLayout(kind: DieKind): DieLayout {
  const cached = layouts.get(kind);
  if (cached) return cached;
  const spec = KIND_SPECS[kind];
  const poly = getPolyhedron(spec.shape);
  const placements: LabelPlacement[] = [];
  const readouts = new Map<number, Vec3>();

  if (spec.shape === "tetrahedron") {
    // Valore i+1 sul vertice i.
    spec.labels.forEach((value, i) => readouts.set(value, normalize(poly.vertices[i] as Vec3)));
    for (const f of poly.faces) {
      for (const vi of f.vertices) {
        const v = poly.vertices[vi] as Vec3;
        const toVertex = sub(v, f.center);
        placements.push({
          value: spec.labels[vi] as number,
          position: add(f.center, scale(toVertex, 0.5)),
          normal: f.normal,
          up: normalize(toVertex),
          size: f.size * 0.32,
        });
      }
    }
  } else {
    const values = assignFaceValues(poly, spec.labels);
    poly.faces.forEach((f, i) => {
      const value = values[i] as number;
      readouts.set(value, f.normal);
      placements.push({
        value,
        position: f.center,
        normal: f.normal,
        up: normalize(sub(poly.vertices[f.vertices[0] as number] as Vec3, f.center)),
        size: f.size * 0.45,
      });
    });
  }
  const layout: DieLayout = { kind, poly, placements, readouts };
  layouts.set(kind, layout);
  return layout;
}

/** Asse destro del testo (up x normale), completa la base destrorsa. */
export function labelRight(p: LabelPlacement): Vec3 {
  return cross(p.up, p.normal);
}

export function readoutDirection(kind: DieKind, value: number): Vec3 {
  const dir = getLayout(kind).readouts.get(value);
  if (!dir) throw new RangeError(`Il dado ${kind} non ha il valore ${value}`);
  return dir;
}

/**
 * Orientamento finale del dado perche' `value` sia in alto. `spin` e' una rotazione cosmetica
 * attorno alla verticale (non cambia quale faccia e' in alto).
 */
export function restQuaternion(kind: DieKind, value: number, spin = 0): Quat {
  return quatMul(quatFromAxisAngle(UP, spin), quatFromUnitVectors(readoutDirection(kind, value), UP));
}

/** Valore letto in alto dato l'orientamento del dado: la direzione piu' vicina alla verticale. */
export function readUpValue(kind: DieKind, orientation: Quat): number {
  let best = Number.NEGATIVE_INFINITY;
  let bestValue = Number.NaN;
  for (const [value, dir] of getLayout(kind).readouts) {
    const d = dot(quatRotate(orientation, dir), UP);
    if (d > best) {
      best = d;
      bestValue = value;
    }
  }
  return bestValue;
}
