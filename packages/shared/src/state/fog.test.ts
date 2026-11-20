import { describe, expect, it } from "vitest";
import {
  COVERED_MASK,
  REVEALED_MASK,
  FogMaskSchema,
  allCellsRevealed,
  anyCellRevealed,
  isCanonicalRuns,
  isCellRevealed,
  maskCover,
  maskReveal,
  normalizeRuns,
  rasterizeShape,
  subtractRuns,
  tileCoverage,
  tileCoverageKey,
  unionRuns,
  type FogGeometry,
  type FogMask,
} from "./fog.js";
import { rng } from "./fixtures.test-utils.js";
import { clipSegmentToMask } from "./walls.js";

const G: FogGeometry = { cellSize: 10, offsetX: 0, offsetY: 0 };

/** Insieme di celle come stringhe "c,r" (modello di riferimento per i test). */
function cellsOf(runs: readonly number[]): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < runs.length; i += 3) for (let c = runs[i + 1]!; c < runs[i + 2]!; c++) s.add(`${c},${runs[i]}`);
  return s;
}

function randomRuns(r: () => number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(r() * 20);
    out.push(Math.floor(r() * 8), a, a + 1 + Math.floor(r() * 5));
  }
  return out;
}

describe("terne di celle", () => {
  it("normalizza in forma canonica (ordinata, fusa)", () => {
    expect(normalizeRuns([2, 5, 7, 0, 3, 4, 2, 1, 5, 2, 7, 9])).toEqual([0, 3, 4, 2, 1, 9]);
    expect(isCanonicalRuns([0, 3, 4, 2, 1, 9])).toBe(true);
    expect(isCanonicalRuns([0, 3, 4, 0, 4, 5])).toBe(false); // adiacenti non fuse
    expect(isCanonicalRuns([0, 3, 3])).toBe(false);
    expect(FogMaskSchema.safeParse({ base: "covered", runs: [1, 2, 1] }).success).toBe(false);
  });

  it("unione e differenza coincidono con il modello a insiemi (proprietà casuali)", () => {
    const r = rng(7);
    for (let k = 0; k < 300; k++) {
      const a = normalizeRuns(randomRuns(r, 6));
      const b = randomRuns(r, 6);
      const A = cellsOf(a);
      const B = cellsOf(normalizeRuns(b));
      const u = unionRuns(a, b);
      const d = subtractRuns(a, b);
      expect(isCanonicalRuns(u) && isCanonicalRuns(d)).toBe(true);
      expect(cellsOf(u)).toEqual(new Set([...A, ...B]));
      expect(cellsOf(d)).toEqual(new Set([...A].filter((x) => !B.has(x))));
    }
  });

  it("rivela/copre su entrambe le basi e le query sono coerenti", () => {
    const r = rng(11);
    for (let k = 0; k < 200; k++) {
      let mask: FogMask = r() < 0.5 ? COVERED_MASK : REVEALED_MASK;
      const revealed = new Set<string>();
      if (mask.base === "revealed") for (let c = -1; c < 30; c++) for (let row = -1; row < 12; row++) revealed.add(`${c},${row}`);
      for (let step = 0; step < 6; step++) {
        const cells = normalizeRuns(randomRuns(r, 3));
        const set = cellsOf(cells);
        if (r() < 0.5) {
          mask = maskReveal(mask, cells);
          for (const x of set) revealed.add(x);
        } else {
          mask = maskCover(mask, cells);
          for (const x of set) revealed.delete(x);
        }
      }
      for (let c = -1; c < 30; c++) {
        for (let row = -1; row < 12; row++) expect(isCellRevealed(mask, c, row)).toBe(revealed.has(`${c},${row}`));
      }
      const c0 = Math.floor(r() * 20);
      const r0 = Math.floor(r() * 8);
      let any = false;
      let all = true;
      for (let c = c0; c < c0 + 4; c++) {
        for (let row = r0; row < r0 + 3; row++) {
          const v = revealed.has(`${c},${row}`);
          any ||= v;
          all &&= v;
        }
      }
      expect(anyCellRevealed(mask, c0, r0, c0 + 4, r0 + 3)).toBe(any);
      expect(allCellsRevealed(mask, c0, r0, c0 + 4, r0 + 3)).toBe(all);
    }
  });
});

describe("rasterizzazione delle forme (centro della cella dentro la forma)", () => {
  it("rettangolo, cerchio, poligono e celle", () => {
    expect(rasterizeShape({ kind: "rect", x: 0, y: 0, width: 30, height: 20 }, G, 100, 100)).toEqual([0, 0, 3, 1, 0, 3]);
    // Un rettangolo che contiene solo metà della cella non la prende.
    expect(rasterizeShape({ kind: "rect", x: 0, y: 0, width: 4, height: 4 }, G, 100, 100)).toEqual([]);
    const circle = cellsOf(rasterizeShape({ kind: "circle", x: 50, y: 50, radius: 16 }, G, 100, 100));
    expect(circle.has("4,4") && circle.has("5,5") && circle.has("3,4")).toBe(true);
    expect(circle.has("2,2")).toBe(false);
    const tri = cellsOf(rasterizeShape({ kind: "polygon", points: [0, 0, 100, 0, 0, 100] }, G, 100, 100));
    expect(tri.has("0,0") && tri.has("8,0") && tri.has("0,8")).toBe(true);
    expect(tri.has("9,9") || tri.has("5,5")).toBe(false);
    expect(rasterizeShape({ kind: "cells", cells: [3, 1, 4, 1, 99, 99] }, G, 100, 100)).toEqual([1, 3, 5]);
  });

  it("resta dentro la mappa anche con forme enormi", () => {
    const runs = rasterizeShape({ kind: "rect", x: -1e6, y: -1e6, width: 2e6, height: 2e6 }, G, 95, 40);
    expect(runs).toEqual([0, 0, 10, 1, 0, 10, 2, 0, 10, 3, 0, 10]);
  });

  it("con offset la riga/colonna -1 copre il bordo della mappa", () => {
    const g = { cellSize: 10, offsetX: 5, offsetY: 5 };
    const runs = rasterizeShape({ kind: "rect", x: 0, y: 0, width: 20, height: 0 }, g, 100, 100);
    expect(runs).toEqual([-1, -1, 2]);
  });
});

describe("tessere", () => {
  it("nessuna, parziale o piena, e chiave che cambia solo con la copertura", () => {
    const g = { cellSize: 64, offsetX: 0, offsetY: 0 };
    let mask = maskReveal(COVERED_MASK, rasterizeShape({ kind: "rect", x: 0, y: 0, width: 512, height: 512 }, g, 2000, 1000));
    expect(tileCoverage(mask, g, 0, 0, 2000, 1000)).toBe("full");
    expect(tileCoverage(mask, g, 1, 0, 2000, 1000)).toBe("none");
    const k1 = tileCoverageKey(mask, g, 1, 0, 2000, 1000);
    mask = maskReveal(mask, rasterizeShape({ kind: "cells", cells: [9, 0] }, g, 2000, 1000));
    expect(tileCoverage(mask, g, 1, 0, 2000, 1000)).toBe("partial");
    expect(tileCoverageKey(mask, g, 1, 0, 2000, 1000)).not.toBe(k1);
    expect(tileCoverageKey(mask, g, 0, 0, 2000, 1000)).toBe(tileCoverageKey(mask, g, 0, 0, 2000, 1000));
    // Tessera fuori dalla mappa.
    expect(tileCoverage(REVEALED_MASK, g, 9, 9, 2000, 1000)).toBe("none");
  });
});

describe("muri ritagliati dalla maschera", () => {
  it("solo i pezzi nelle celle rivelate, mai coordinate oltre", () => {
    const mask = maskReveal(COVERED_MASK, [0, 0, 2]); // celle (0,0) e (1,0): x in [0,20), y in [0,10)
    const out = clipSegmentToMask(5, 5, 95, 5, G, mask);
    expect(out).toEqual([5, 5, 20, 5]);
    expect(clipSegmentToMask(50, 50, 90, 90, G, mask)).toEqual([]);
    expect(clipSegmentToMask(0, 0, 10, 10, G, REVEALED_MASK)).toEqual([0, 0, 10, 10]);
  });

  it("un muro sul bordo di una stanza rivelata si vede", () => {
    const mask = maskReveal(COVERED_MASK, [0, 0, 2]);
    // Muro lungo la linea y = 10 (bordo inferiore delle celle rivelate).
    expect(clipSegmentToMask(0, 10, 50, 10, G, mask)).toEqual([0, 10, 20, 10]);
  });
});
