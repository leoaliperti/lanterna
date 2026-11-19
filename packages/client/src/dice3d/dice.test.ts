import { describe, expect, it } from "vitest";
import { planRoll, samplePlan } from "./animation";
import {
  DICE_SIDES,
  type DieKind,
  type DieRequest,
  combinePercentile,
  expandRequests,
  formatResults,
  getLayout,
  kindValues,
  readUpValue,
  readoutDirection,
  restQuaternion,
  splitPercentile,
} from "./dice";
import { type Vec3, UP, cross, dot, length, quatRotate, sub } from "./math";
import { type Shape, getPolyhedron, triangulate } from "./polyhedra";

const KINDS: DieKind[] = ["d4", "d6", "d8", "d10", "d12", "d20", "d10tens", "d10units"];
const FACES: Record<Shape, number> = {
  tetrahedron: 4,
  cube: 6,
  octahedron: 8,
  trapezohedron: 10,
  dodecahedron: 12,
  icosahedron: 20,
};
const EDGES: Record<Shape, number> = {
  tetrahedron: 6,
  cube: 12,
  octahedron: 12,
  trapezohedron: 20,
  dodecahedron: 30,
  icosahedron: 30,
};

describe("geometria", () => {
  for (const shape of Object.keys(FACES) as Shape[]) {
    it(`${shape}: numero di facce corretto, convesso e chiuso`, () => {
      const p = getPolyhedron(shape);
      expect(p.faces).toHaveLength(FACES[shape]);
      // Formula di Eulero: V - E + F = 2, con E = somma dei lati / 2.
      const sides = p.faces.reduce((s, f) => s + f.vertices.length, 0);
      expect(sides / 2).toBe(EDGES[shape]);
      expect(p.vertices.length - sides / 2 + p.faces.length).toBe(2);
      // Convesso: tutti i vertici dietro il piano di ogni faccia.
      for (const f of p.faces) {
        for (const v of p.vertices) expect(dot(f.normal, v)).toBeLessThanOrEqual(dot(f.normal, f.center) + 1e-9);
      }
    });

    it(`${shape}: facce piane e normali verso l'esterno`, () => {
      const p = getPolyhedron(shape);
      for (const f of p.faces) {
        const d = dot(f.normal, f.center);
        expect(d).toBeGreaterThan(0);
        for (const i of f.vertices) expect(dot(f.normal, p.vertices[i]!)).toBeCloseTo(d, 9);
      }
      expect(Math.max(...p.vertices.map(length))).toBeCloseTo(1, 9);
    });

    it(`${shape}: la triangolazione ha un ventaglio per faccia`, () => {
      const p = getPolyhedron(shape);
      const tris = p.faces.reduce((s, f) => s + f.vertices.length - 2, 0);
      const pos = triangulate(p);
      expect(pos).toHaveLength(tris * 9);
      // Avvolgimento antiorario visto da fuori: la normale di ogni triangolo punta fuori dal solido.
      for (let t = 0; t < pos.length; t += 9) {
        const a: Vec3 = [pos[t]!, pos[t + 1]!, pos[t + 2]!];
        const b: Vec3 = [pos[t + 3]!, pos[t + 4]!, pos[t + 5]!];
        const c: Vec3 = [pos[t + 6]!, pos[t + 7]!, pos[t + 8]!];
        expect(dot(cross(sub(b, a), sub(c, a)), a)).toBeGreaterThan(0);
      }
    });
  }

  it("d10: le facce sono a coppie opposte", () => {
    const p = getPolyhedron("trapezohedron");
    for (const f of p.faces) {
      expect(p.faces.some((g) => dot(f.normal, g.normal) < -0.999999)).toBe(true);
    }
  });
});

describe("mappatura valore -> faccia", () => {
  for (const kind of KINDS) {
    it(`${kind}: ogni valore dell'intervallo ha esattamente una direzione di lettura`, () => {
      const values = kindValues(kind);
      const readouts = getLayout(kind).readouts;
      expect([...readouts.keys()].sort((a, b) => a - b)).toEqual([...values]);
      for (const a of values) {
        for (const b of values) {
          if (a !== b) expect(dot(readoutDirection(kind, a), readoutDirection(kind, b))).toBeLessThan(0.999999);
        }
      }
    });

    it(`${kind}: dopo l'animazione il valore in alto e' quello richiesto`, () => {
      for (const value of kindValues(kind)) {
        for (const spin of [0, 1.234, 4]) {
          const q = restQuaternion(kind, value, spin);
          expect(readUpValue(kind, q)).toBe(value);
          const up = quatRotate(q, readoutDirection(kind, value));
          expect(dot(up, UP)).toBeCloseTo(1, 9);
        }
      }
    });
  }

  for (const kind of ["d6", "d8", "d10", "d12", "d20"] as const) {
    it(`${kind}: le facce opposte sommano min + max`, () => {
      const values = kindValues(kind);
      const sum = values[0]! + values[values.length - 1]!;
      const readouts = [...getLayout(kind).readouts];
      for (const [value, dir] of readouts) {
        const opp = readouts.find(([, d]) => dot(d, dir) < -0.999999);
        expect(opp?.[0]).toBe(sum - value);
      }
    });

    it(`${kind}: ogni numero compare su una sola faccia`, () => {
      const placed = getLayout(kind).placements.map((p) => p.value).sort((a, b) => a - b);
      expect(placed).toEqual([...kindValues(kind)]);
    });
  }

  it("d4: il valore e' sul vertice, e la faccia poggiata e' quella opposta", () => {
    const layout = getLayout("d4");
    for (const value of kindValues("d4")) {
      const q = restQuaternion("d4", value);
      const down = layout.poly.faces.find((f) => dot(quatRotate(q, f.normal), UP) < -0.999999);
      expect(down).toBeDefined();
      const valuesOnDown = down!.vertices.map((vi) => kindValues("d4")[vi]);
      expect(valuesOnDown).toHaveLength(3);
      expect(valuesOnDown).not.toContain(value);
    }
  });

  it("d4: ogni faccia mostra i tre numeri dei propri vertici (12 etichette, ogni numero 3 volte)", () => {
    const placed = getLayout("d4").placements.map((p) => p.value);
    expect(placed).toHaveLength(12);
    for (const v of kindValues("d4")) expect(placed.filter((x) => x === v)).toHaveLength(3);
  });

  it("l'orientamento finale non dipende dal generatore casuale", () => {
    for (const kind of KINDS) {
      for (const value of kindValues(kind)) {
        for (const seed of [0, 0.37, 0.99]) {
          const plan = planRoll({ kind, value, target: { x: 0, z: 0 }, rng: () => seed });
          expect(readUpValue(kind, plan.qEnd)).toBe(value);
          const end = samplePlan(plan, plan.durationMs + 1, 0.5);
          expect(end.done).toBe(true);
          expect(readUpValue(kind, end.quaternion)).toBe(value);
        }
      }
    }
  });
});

describe("d10 dei punti percentuali", () => {
  it("decine 00..90 e unita' 0..9", () => {
    expect(kindValues("d10tens")).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(kindValues("d10units")).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("ogni valore 1..100 si scompone e ricompone", () => {
    for (let v = 1; v <= 100; v++) {
      const { tens, units } = splitPercentile(v);
      expect(kindValues("d10tens")).toContain(tens);
      expect(kindValues("d10units")).toContain(units);
      expect(combinePercentile(tens, units)).toBe(v);
    }
    expect(splitPercentile(100)).toEqual({ tens: 0, units: 0 });
    expect(splitPercentile(10)).toEqual({ tens: 10, units: 0 });
    expect(splitPercentile(7)).toEqual({ tens: 0, units: 7 });
  });

  it("il d% finale mostra in alto decine e unita' che ricompongono il valore richiesto", () => {
    for (let v = 1; v <= 100; v++) {
      const [tens, units] = expandRequests([{ sides: 100, value: v }]);
      const t = readUpValue("d10tens", restQuaternion("d10tens", tens!.value));
      const u = readUpValue("d10units", restQuaternion("d10units", units!.value));
      expect(combinePercentile(t, u)).toBe(v);
    }
  });
});

describe("richieste", () => {
  it("espande d% in due dadi fisici e mantiene l'indice della richiesta", () => {
    const dice = expandRequests([
      { sides: 20, value: 14 },
      { sides: 100, value: 42 },
    ]);
    expect(dice).toEqual([
      { kind: "d20", value: 14, request: 0 },
      { kind: "d10tens", value: 40, request: 1 },
      { kind: "d10units", value: 2, request: 1 },
    ]);
  });

  it("rifiuta lati non supportati e valori fuori intervallo", () => {
    const bad = (d: unknown) => () => expandRequests([d as DieRequest]);
    expect(bad({ sides: 7, value: 1 })).toThrow(RangeError);
    expect(bad({ sides: 6, value: 0 })).toThrow(RangeError);
    expect(bad({ sides: 6, value: 7 })).toThrow(RangeError);
    expect(bad({ sides: 6, value: 2.5 })).toThrow(RangeError);
    expect(bad({ sides: 100, value: 101 })).toThrow(RangeError);
    for (const sides of DICE_SIDES) expect(() => expandRequests([{ sides, value: sides }])).not.toThrow();
  });

  it("formatta il riepilogo testuale", () => {
    expect(
      formatResults([
        { sides: 20, value: 14 },
        { sides: 100, value: 100 },
      ]),
    ).toBe("d20 14 · d% 100");
  });
});

describe("animazione", () => {
  it("con prefers-reduced-motion e' gia' ferma e nella posa finale", () => {
    const plan = planRoll({ kind: "d20", value: 7, target: { x: 1, z: 2 }, reducedMotion: true });
    const s = samplePlan(plan, 0, 0.6);
    expect(s.done).toBe(true);
    expect(s.position).toEqual([1, 0.6, 2]);
    expect(readUpValue("d20", s.quaternion)).toBe(7);
  });

  it("durante il movimento non e' finita e poi arriva a destinazione", () => {
    const plan = planRoll({ kind: "d6", value: 3, target: { x: 0, z: 0 } });
    expect(samplePlan(plan, plan.durationMs / 2, 0.5).done).toBe(false);
    const end = samplePlan(plan, plan.durationMs, 0.5);
    expect(end.done).toBe(true);
    expect(length(sub(end.position, [0, 0.5, 0]))).toBe(0);
  });
});
