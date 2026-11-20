import { describe, expect, it } from "vitest";
import { COVERED_MASK, REVEALED_MASK, type Fog } from "./fog.js";
import { GM, P1, P2 } from "./fixtures.test-utils.js";
import {
  CONE_ANGLE_DEG,
  ShapeSchema,
  circleContains,
  coneContains,
  lineContains,
  rulerDistance,
  shapeCells,
  shapeForViewer,
  shapePoints,
  unitsToPixels,
  type Shape,
} from "./shapes.js";

/** Griglia da 10 px senza offset: la cella (c, r) ha il centro in (10c + 5, 10r + 5). */
const G = { cellSize: 10, offsetX: 0, offsetY: 0 };
const pairs = (flat: number[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push(`${flat[i]},${flat[i + 1]}`);
  return out;
};
const cells = (shape: Shape, bounds?: { width: number; height: number }) => pairs(shapeCells(shape, G, bounds)!);

describe("cono 5e", () => {
  it("l'angolo totale è 2*atan(1/2), circa 53,13 gradi: larghezza = distanza", () => {
    expect(CONE_ANGLE_DEG).toBeCloseTo(53.1301, 4);
    // A distanza d lungo l'asse la larghezza del cono (corda) vale d: scarto laterale d/2.
    const cone = { x: 0, y: 0, direction: 0, length: 100 };
    for (const d of [10, 40, 85]) {
      expect(coneContains(cone, d, d / 2 - 1e-6)).toBe(true);
      expect(coneContains(cone, d, d / 2 + 0.01)).toBe(false);
      expect(coneContains(cone, d, -(d / 2) + 1e-6)).toBe(true);
      expect(coneContains(cone, d, -(d / 2) - 0.01)).toBe(false);
    }
  });

  it("rispetta lunghezza, direzione e angolo personalizzato", () => {
    expect(coneContains({ x: 0, y: 0, direction: 0, length: 30 }, 30, 0)).toBe(true);
    expect(coneContains({ x: 0, y: 0, direction: 0, length: 30 }, 30.5, 0)).toBe(false);
    expect(coneContains({ x: 0, y: 0, direction: 0, length: 30 }, -5, 0)).toBe(false); // dietro il vertice
    // 90 gradi verso il basso (y cresce verso il basso)
    expect(coneContains({ x: 50, y: 50, direction: 90, length: 30 }, 50, 70)).toBe(true);
    expect(coneContains({ x: 50, y: 50, direction: 90, length: 30 }, 70, 50)).toBe(false);
    // angolo 90: la diagonale a 45 è ancora dentro
    expect(coneContains({ x: 0, y: 0, direction: 0, length: 50, angle: 90 }, 20, 20)).toBe(true);
    expect(coneContains({ x: 0, y: 0, direction: 0, length: 50 }, 20, 20)).toBe(false);
    // direzioni equivalenti modulo 360
    expect(coneContains({ x: 0, y: 0, direction: 360, length: 30 }, 20, 0)).toBe(true);
    expect(coneContains({ x: 0, y: 0, direction: -360, length: 30 }, 20, 0)).toBe(true);
    expect(coneContains({ x: 0, y: 0, direction: 180, length: 30 }, -20, 0)).toBe(true);
    expect(coneContains({ x: 0, y: 0, direction: -180, length: 30 }, -20, 0)).toBe(true);
  });

  it("celle coperte da un cono di 15 ft (3 celle da 5 ft) verso destra", () => {
    // vertice nella cella (0,5) = centro (5, 55), lunghezza 30 px
    const covered = cells({ kind: "cone", x: 5, y: 55, direction: 0, length: 30 });
    // la lunghezza è radiale (30 px): (3,4) dista 31,6 e resta fuori; (2,4) è esattamente sul bordo dell angolo
    expect(covered).toEqual(["2,4", "0,5", "1,5", "2,5", "3,5", "2,6"]);
  });

  it("il cono ruotato di 90 gradi copre le stesse celle ruotate", () => {
    const right = cells({ kind: "cone", x: 55, y: 5, direction: 0, length: 30 });
    const down = cells({ kind: "cone", x: 55, y: 5, direction: 90, length: 30 });
    const rot = right.map((p) => {
      const [c, r] = p.split(",").map(Number) as [number, number];
      return `${5 + (r - 0)},${c - 5}`;
    });
    // ruotando di 90 gradi intorno al vertice (cella 5,0): (dc, dr) -> (-dr, dc)
    const expected = right.map((p) => {
      const [c, r] = p.split(",").map(Number) as [number, number];
      return `${5 - r},${0 + (c - 5)}`;
    });
    void rot;
    expect(new Set(down)).toEqual(new Set(expected));
  });
});

describe("cerchio", () => {
  it("contiene i punti entro il raggio (bordo incluso)", () => {
    const c = { x: 0, y: 0, radius: 10 };
    expect(circleContains(c, 10, 0)).toBe(true);
    expect(circleContains(c, 0, -10)).toBe(true);
    expect(circleContains(c, 7.07, 7.07)).toBe(true);
    expect(circleContains(c, 7.2, 7.2)).toBe(false);
  });

  it("celle: i centri entro il raggio; raggio piccolo copre almeno la cella d'origine", () => {
    // centro nel centro della cella (5,5) = (55,55), raggio 10 -> 5 celle a croce
    expect(cells({ kind: "circle", x: 55, y: 55, radius: 10 })).toEqual(["5,4", "4,5", "5,5", "6,5", "5,6"]);
    expect(cells({ kind: "circle", x: 55, y: 55, radius: 1 })).toEqual(["5,5"]);
    // raggio 15: i centri a (±10, ±10) distano 14,14 -> dentro, quindi 3x3
    expect(cells({ kind: "circle", x: 55, y: 55, radius: 15 })).toHaveLength(9);
  });

  it("è simmetrico e il numero di celle cresce col raggio", () => {
    const n = (r: number) => cells({ kind: "circle", x: 105, y: 105, radius: r }).length;
    expect(n(10)).toBeLessThan(n(20));
    expect(n(20)).toBeLessThan(n(40));
    const set = new Set(cells({ kind: "circle", x: 105, y: 105, radius: 30 }));
    for (const p of set) {
      const [c, r] = p.split(",").map(Number) as [number, number];
      expect(set.has(`${20 - c},${r}`)).toBe(true);
      expect(set.has(`${c},${20 - r}`)).toBe(true);
    }
  });
});

describe("linea", () => {
  it("contiene i punti entro mezza larghezza dall'asse, a estremi piatti", () => {
    const l = { x1: 0, y1: 0, x2: 100, y2: 0, width: 10 };
    expect(lineContains(l, 50, 5)).toBe(true);
    expect(lineContains(l, 50, -5)).toBe(true);
    expect(lineContains(l, 50, 5.5)).toBe(false);
    expect(lineContains(l, 100, 0)).toBe(true);
    expect(lineContains(l, 101, 0)).toBe(false);
    expect(lineContains(l, -1, 0)).toBe(false);
  });

  it("linea orizzontale di 3 celle larga 1 cella; diagonale; lunghezza zero", () => {
    expect(cells({ kind: "line", x1: 5, y1: 25, x2: 35, y2: 25, width: 10 })).toEqual(["0,2", "1,2", "2,2", "3,2"]);
    const diag = cells({ kind: "line", x1: 5, y1: 5, x2: 45, y2: 45, width: 10 });
    for (const d of ["0,0", "1,1", "2,2", "3,3", "4,4"]) expect(diag).toContain(d);
    expect(diag).not.toContain("0,4");
    expect(cells({ kind: "line", x1: 25, y1: 25, x2: 25, y2: 25, width: 10 })).toEqual(["2,2"]);
  });
});

describe("righello, freccia e ping", () => {
  it("la poligonale copre le celle attraversate, estremi compresi, senza duplicati", () => {
    const c = cells({ kind: "ruler", points: [{ x: 5, y: 5 }, { x: 45, y: 5 }, { x: 45, y: 25 }] });
    expect(c).toEqual(["0,0", "1,0", "2,0", "3,0", "4,0", "4,1", "4,2"]);
    expect(new Set(c).size).toBe(c.length);
    expect(cells({ kind: "arrow", x1: 5, y1: 5, x2: 5, y2: 5 })).toEqual(["0,0"]);
    expect(cells({ kind: "ping", x: 123, y: 47 })).toEqual(["12,4"]);
  });

  it("distanza: euclidea, regola semplice 5e e 5-10-5", () => {
    const pts = [{ x: 0, y: 0 }, { x: 40, y: 30 }]; // 4 x 3 celle da 10
    const scale = { unitsPerCell: 5 };
    expect(rulerDistance(pts, 10, scale, "euclid")).toBeCloseTo(25);
    expect(rulerDistance(pts, 10, scale, "chebyshev")).toBe(20);
    expect(rulerDistance(pts, 10, scale, "alternating")).toBe(25); // 4 + floor(3/2) = 5 celle
    expect(rulerDistance([{ x: 0, y: 0 }, { x: 20, y: 20 }], 10, scale, "alternating")).toBe(15); // 2 + 1
    expect(rulerDistance([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }], 10, scale)).toBe(20);
    expect(unitsToPixels(30, 70, { unitsPerCell: 5 })).toBe(420);
  });

  it("griglia con offset", () => {
    const c = pairs(shapeCells({ kind: "ping", x: 12, y: 12 }, { cellSize: 10, offsetX: 5, offsetY: 5 })!);
    expect(c).toEqual(["0,0"]);
  });
});

describe("limiti", () => {
  it("una forma troppo grande restituisce null (non si esamina un numero illimitato di celle)", () => {
    expect(shapeCells({ kind: "circle", x: 5000, y: 5000, radius: 5000 }, { cellSize: 4, offsetX: 0, offsetY: 0 })).toBeNull();
    expect(shapeCells({ kind: "cone", x: 5000, y: 5000, direction: 0, length: 19000 }, { cellSize: 4, offsetX: 0, offsetY: 0 })).toBeNull();
    const zigzag = Array.from({ length: 16 }, (_, i) => ({ x: i % 2 === 0 ? 0 : 20000, y: 0 }));
    expect(shapeCells({ kind: "ruler", points: zigzag }, { cellSize: 4, offsetX: 0, offsetY: 0 })).toBeNull();
  });

  it("le celle fuori dalla mappa si scartano con `bounds`", () => {
    const inside = cells({ kind: "circle", x: 5, y: 5, radius: 20 }, { width: 100, height: 100 });
    for (const p of inside) {
      const [c, r] = p.split(",").map(Number) as [number, number];
      expect(c).toBeGreaterThanOrEqual(0);
      expect(r).toBeGreaterThanOrEqual(0);
    }
    expect(cells({ kind: "circle", x: 5, y: 5, radius: 20 })).toContain("-1,0");
  });

  it("lo schema rifiuta forme non valide e campi sconosciuti", () => {
    const bad: unknown[] = [
      { kind: "circle", x: 1, y: 1, radius: 0 },
      { kind: "circle", x: 1, y: 1, radius: -3 },
      { kind: "circle", x: Number.NaN, y: 1, radius: 3 },
      { kind: "circle", x: 1, y: 1, radius: Infinity },
      { kind: "cone", x: 1, y: 1, direction: 0, length: 10, angle: 0 },
      { kind: "cone", x: 1, y: 1, direction: 0, length: 10, angle: 270 },
      { kind: "ruler", points: [{ x: 1, y: 1 }] },
      { kind: "ruler", points: Array.from({ length: 17 }, () => ({ x: 1, y: 1 })) },
      { kind: "ping", x: 1, y: 1, label: "<script>" },
      { kind: "ping", x: 1, y: 1, label: "x".repeat(33) },
      { kind: "line", x1: 1, y1: 1, x2: 2, y2: 2, width: 0 },
      { kind: "circle", x: 1, y: 1, radius: 5, extra: 1 },
      { kind: "cells", cells: [1, 2] },
      { kind: "nope" },
    ];
    for (const b of bad) expect(ShapeSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    expect(ShapeSchema.safeParse({ kind: "ping", x: 1, y: 1, label: "Qui!" }).success).toBe(true);
  });

  it("shapePoints elenca i punti notevoli", () => {
    expect(shapePoints({ kind: "line", x1: 1, y1: 2, x2: 3, y2: 4, width: 5 })).toHaveLength(2);
    expect(shapePoints({ kind: "circle", x: 1, y: 2, radius: 5 })).toEqual([{ x: 1, y: 2 }]);
  });
});

describe("filtro per destinatario con la nebbia", () => {
  const scene = { width: 200, height: 200 };
  /** Nebbia con celle da 10: tutto coperto tranne i rettangoli indicati per ciascun giocatore. */
  function fogWith(p1Cells: [number, number, number, number], everyone = false): Fog {
    const [c0, r0, c1, r1] = p1Cells;
    const runs: number[] = [];
    for (let r = r0; r < r1; r++) runs.push(r, c0, c1);
    return {
      sceneId: "s",
      cellSize: 10,
      offsetX: 0,
      offsetY: 0,
      lighting: "bright",
      everyone: everyone ? REVEALED_MASK : COVERED_MASK,
      players: [{ userId: "p1", mask: { base: "covered", runs } }],
    };
  }
  const circle: Shape = { kind: "circle", x: 55, y: 55, radius: 20 }; // celle ~ 3..7

  it("il GM e le scene senza nebbia: forma intera", () => {
    expect(shapeForViewer(circle, scene, fogWith([0, 0, 20, 20]), GM)).toEqual(circle);
    expect(shapeForViewer(circle, scene, null, P1)).toEqual(circle);
  });

  it("tutte le celle rivelate: forma intera", () => {
    expect(shapeForViewer(circle, scene, fogWith([0, 0, 20, 20]), P1)).toEqual(circle);
  });

  it("celle non rivelate: nulla; rivelate solo in parte: solo le celle rivelate, senza coordinate", () => {
    const fog = fogWith([5, 0, 20, 20]); // P1 vede da colonna 5 in poi
    expect(shapeForViewer(circle, scene, fog, P2)).toBeNull(); // P2: tutto coperto
    const partial = shapeForViewer(circle, scene, fog, P1)!;
    expect(partial.kind).toBe("cells");
    if (partial.kind !== "cells") return;
    const ps = pairs(partial.cells);
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) expect(Number(p.split(",")[0])).toBeGreaterThanOrEqual(5);
    const json = JSON.stringify(partial);
    expect(json).not.toContain("radius");
    expect(json).not.toContain('"x"');
  });

  it("un ping in una cella coperta non arriva", () => {
    const fog = fogWith([0, 0, 3, 3]);
    expect(shapeForViewer({ kind: "ping", x: 155, y: 155 }, scene, fog, P1)).toBeNull();
    expect(shapeForViewer({ kind: "ping", x: 15, y: 15 }, scene, fog, P1)).toEqual({ kind: "ping", x: 15, y: 15 });
  });

  it("un righello che parte da una zona rivelata e finisce in una coperta non rivela dove finisce", () => {
    const fog = fogWith([0, 0, 4, 4]);
    const ruler: Shape = { kind: "ruler", points: [{ x: 5, y: 5 }, { x: 185, y: 185 }] };
    const out = shapeForViewer(ruler, scene, fog, P1)!;
    expect(out.kind).toBe("cells");
    expect(JSON.stringify(out)).not.toContain("185");
    for (const p of pairs((out as { cells: number[] }).cells)) {
      const [c, r] = p.split(",").map(Number) as [number, number];
      expect(c).toBeLessThan(4);
      expect(r).toBeLessThan(4);
    }
  });

  it("una forma troppo grande per il calcolo non arriva ai giocatori", () => {
    const fog = { ...fogWith([0, 0, 20, 20]), cellSize: 4 };
    const huge: Shape = { kind: "circle", x: 5000, y: 5000, radius: 9000 };
    expect(shapeForViewer(huge, { width: 20000, height: 20000 }, fog, P1)).toBeNull();
  });

  it("senza celle nella mappa (forma tutta fuori) non arriva", () => {
    const fog = fogWith([0, 0, 20, 20], true);
    expect(shapeForViewer({ kind: "ping", x: 500, y: 500 }, scene, fog, P1)).toBeNull();
  });
});
