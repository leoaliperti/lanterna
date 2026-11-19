// Geometria dei solidi dei dadi, come dati puri (nessuna dipendenza da Three.js).
// Tutti i solidi sono centrati nell'origine con raggio circoscritto 1.

import { type Vec3, add, centroid, cross, dot, length, negate, normalize, scale, sub } from "./math";

export type Shape = "tetrahedron" | "cube" | "octahedron" | "dodecahedron" | "icosahedron" | "trapezohedron";

export interface Face {
  /** Indici dei vertici, in senso antiorario visto da fuori. Il primo è il "puntatore" usato per orientare il testo. */
  readonly vertices: readonly number[];
  readonly normal: Vec3;
  readonly center: Vec3;
  /** Radice dell'area: lato di un quadrato equivalente. */
  readonly size: number;
}

export interface Polyhedron {
  readonly shape: Shape;
  readonly vertices: readonly Vec3[];
  readonly faces: readonly Face[];
  /** Distanza dal centro alla faccia più vicina: altezza del centro quando il dado poggia su una faccia. */
  readonly inradius: number;
}

const PHI = (1 + Math.sqrt(5)) / 2;
const EPS = 1e-6;

function signs(n: number): number[][] {
  const out: number[][] = [];
  for (let m = 0; m < 1 << n; m++) out.push(Array.from({ length: n }, (_, i) => ((m >> i) & 1 ? -1 : 1)));
  return out;
}

function toUnitRadius(vertices: readonly Vec3[]): Vec3[] {
  const r = Math.max(...vertices.map(length));
  return vertices.map((v) => scale(v, 1 / r));
}

/** Costruisce una faccia da vertici già ordinati, orientandola verso l'esterno. */
function makeFace(vertices: readonly Vec3[], indices: readonly number[]): Face {
  const pts = indices.map((i) => vertices[i] as Vec3);
  const center = centroid(pts);
  // Metodo di Newell: normale robusta anche per poligoni non triangolari.
  let n: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as Vec3;
    const b = pts[(i + 1) % pts.length] as Vec3;
    n = add(n, cross(a, b));
  }
  const area = length(n) / 2;
  let normal = normalize(n);
  let ordered = [...indices];
  if (dot(normal, center) < 0) {
    normal = negate(normal);
    const [first, ...rest] = ordered;
    ordered = [first as number, ...rest.reverse()];
  }
  return { vertices: ordered, normal, center, size: Math.sqrt(area) };
}

/**
 * Per ogni normale prende i vertici che stanno sul piano (quelli col prodotto scalare massimo)
 * e li ordina attorno alla normale.
 */
function facesFromNormals(vertices: readonly Vec3[], normals: readonly Vec3[]): Face[] {
  return normals.map((nRaw) => {
    const n = normalize(nRaw);
    const best = Math.max(...vertices.map((v) => dot(v, n)));
    const idx = vertices.flatMap((v, i) => (dot(v, n) > best - EPS ? [i] : []));
    const pts = idx.map((i) => vertices[i] as Vec3);
    const c = centroid(pts);
    const e1 = normalize(sub(pts[0] as Vec3, c));
    const e2 = cross(n, e1);
    const angle = (i: number) => {
      const d = sub(vertices[i] as Vec3, c);
      return Math.atan2(dot(d, e2), dot(d, e1));
    };
    return makeFace(vertices, idx.sort((a, b) => angle(a) - angle(b)));
  });
}

function finish(shape: Shape, vertices: Vec3[], faces: Face[]): Polyhedron {
  const inradius = Math.min(...faces.map((f) => dot(f.normal, vertices[f.vertices[0] as number] as Vec3)));
  return { shape, vertices, faces, inradius };
}

function icosahedronVertices(): Vec3[] {
  const v: Vec3[] = [];
  for (const [a, b] of signs(2) as [number, number][]) {
    v.push([0, a, b * PHI], [a, b * PHI, 0], [a * PHI, 0, b]);
  }
  return v;
}

/** Centri delle 20 facce triangolari dell'icosaedro (= vertici del dodecaedro duale). */
function icosahedronFaceDirections(ico: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  const dist = (i: number, j: number) => length(sub(ico[i] as Vec3, ico[j] as Vec3));
  const edge = Math.min(...ico.flatMap((_, i) => ico.slice(i + 1).map((_v, k) => dist(i, i + 1 + k))));
  const adjacent = (i: number, j: number) => Math.abs(dist(i, j) - edge) < EPS;
  for (let i = 0; i < ico.length; i++) {
    for (let j = i + 1; j < ico.length; j++) {
      for (let k = j + 1; k < ico.length; k++) {
        if (adjacent(i, j) && adjacent(j, k) && adjacent(i, k)) {
          out.push(normalize(centroid([ico[i] as Vec3, ico[j] as Vec3, ico[k] as Vec3])));
        }
      }
    }
  }
  return out;
}

function tetrahedron(): Polyhedron {
  const vertices = toUnitRadius([
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ]);
  // Faccia i = quella opposta al vertice i.
  return finish("tetrahedron", vertices, facesFromNormals(vertices, vertices.map(negate)));
}

function cube(): Polyhedron {
  const vertices = toUnitRadius(signs(3).map((s) => [s[0], s[1], s[2]] as Vec3));
  const normals: Vec3[] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  return finish("cube", vertices, facesFromNormals(vertices, normals));
}

function octahedron(): Polyhedron {
  const vertices: Vec3[] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  const normals = signs(3).map((s) => [s[0], s[1], s[2]] as Vec3);
  return finish("octahedron", vertices, facesFromNormals(vertices, normals));
}

function icosahedron(): Polyhedron {
  const vertices = toUnitRadius(icosahedronVertices());
  return finish("icosahedron", vertices, facesFromNormals(vertices, icosahedronFaceDirections(vertices)));
}

function dodecahedron(): Polyhedron {
  const ico = toUnitRadius(icosahedronVertices());
  const vertices = toUnitRadius(icosahedronFaceDirections(ico));
  return finish("dodecahedron", vertices, facesFromNormals(vertices, ico));
}

/**
 * Trapezoedro pentagonale (d10). Due vertici ai poli (y = +-1) e due anelli di cinque
 * vertici a y = +-h, sfasati di mezzo passo. Le facce sono dieci aquilone.
 * Un aquilone e' piano solo con h = (1 - cos 36) / (1 + cos 36): DiceGen usava 0.105
 * (approssimato), qui il valore e' esatto.
 */
function trapezohedron(): Polyhedron {
  const c = Math.cos(Math.PI / 5);
  const h = (1 - c) / (1 + c);
  const raw: Vec3[] = [[0, 1, 0], [0, -1, 0]];
  const A = (k: number) => 2 + (k % 5); // anello alto
  const B = (k: number) => 7 + (k % 5); // anello basso
  for (let k = 0; k < 5; k++) raw.push([Math.cos((2 * Math.PI * k) / 5), h, Math.sin((2 * Math.PI * k) / 5)]);
  for (let k = 0; k < 5; k++) {
    raw.push([Math.cos((2 * Math.PI * (k + 0.5)) / 5), -h, Math.sin((2 * Math.PI * (k + 0.5)) / 5)]);
  }
  const vertices = toUnitRadius(raw); // raggio dell'anello = sqrt(1 + h^2) > 1
  const faces: Face[] = [];
  for (let k = 0; k < 5; k++) {
    // Il primo indice e' sempre il polo: il testo si orienta verso l'apice.
    faces.push(makeFace(vertices, [0, A(k), B(k), A(k + 1)]));
    faces.push(makeFace(vertices, [1, B(k), A(k + 1), B(k + 1)]));
  }
  return finish("trapezohedron", vertices, faces);
}

const BUILDERS: Record<Shape, () => Polyhedron> = {
  tetrahedron,
  cube,
  octahedron,
  dodecahedron,
  icosahedron,
  trapezohedron,
};

const cache = new Map<Shape, Polyhedron>();

export function getPolyhedron(shape: Shape): Polyhedron {
  let p = cache.get(shape);
  if (!p) {
    p = BUILDERS[shape]();
    cache.set(shape, p);
  }
  return p;
}

/** Posizioni dei triangoli (ventaglio per ogni faccia), con avvolgimento verso l'esterno. */
export function triangulate(poly: Polyhedron): Float32Array {
  const out: number[] = [];
  for (const f of poly.faces) {
    const [v0, ...rest] = f.vertices.map((i) => poly.vertices[i] as Vec3);
    for (let i = 0; i < rest.length - 1; i++) {
      for (const p of [v0 as Vec3, rest[i] as Vec3, rest[i + 1] as Vec3]) out.push(p[0], p[1], p[2]);
    }
  }
  return new Float32Array(out);
}
