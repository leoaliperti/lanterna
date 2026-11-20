import { describe, expect, it } from "vitest";
import { needsDetail, planBackground, tileRect, tilesToEvict, visibleTiles } from "./tiles";

describe("planBackground", () => {
  it("una mappa piccola e' una sola texture", () => {
    expect(planBackground({ width: 2000, height: 1500 }, 8192)).toEqual({ mode: "single", width: 2000, height: 1500 });
    expect(planBackground({ width: 4096, height: 4096 }, 16384).mode).toBe("single");
  });
  it("una mappa 8000x6000 supera il budget e viene divisa in tessere da 2048", () => {
    const plan = planBackground({ width: 8000, height: 6000 }, 16384);
    expect(plan.mode).toBe("tiled");
    if (plan.mode !== "tiled") return;
    expect([plan.tileSize, plan.cols, plan.rows]).toEqual([2048, 4, 3]);
    expect(plan.overview).toEqual({ width: 2048, height: 1536 });
    expect(plan.overviewScale).toBeCloseTo(0.256);
  });
  it("una mappa piu' larga del limite GPU e' sempre a tessere, con tessere che rispettano il limite", () => {
    const plan = planBackground({ width: 5000, height: 500 }, 4096);
    expect(plan.mode).toBe("tiled");
    const small = planBackground({ width: 5000, height: 500 }, 1024, 2048);
    if (small.mode === "tiled") expect(small.tileSize).toBe(1024);
  });
});

describe("tessere", () => {
  const plan = planBackground({ width: 8000, height: 6000 }, 16384);
  if (plan.mode !== "tiled") throw new Error("atteso tiled");
  it("l'ultima tessera e' ritagliata ai bordi", () => {
    expect(tileRect(plan, 3, 2)).toEqual({ x: 6144, y: 4096, width: 1856, height: 1904 });
    expect(tileRect(plan, 0, 0)).toEqual({ x: 0, y: 0, width: 2048, height: 2048 });
  });
  it("seleziona solo le tessere visibili", () => {
    const keys = visibleTiles(plan, { x: 1000, y: 1000, width: 2000, height: 500 }).map((t) => t.key);
    expect(keys).toEqual(["0:0", "1:0"]);
    expect(visibleTiles(plan, { x: -500, y: -500, width: 400, height: 400 })).toEqual([]);
    expect(visibleTiles(plan, { x: 0, y: 0, width: 99999, height: 99999 })).toHaveLength(12);
  });
  it("il dettaglio serve solo quando si zooma oltre la panoramica", () => {
    expect(needsDetail(plan, 0.1)).toBe(false);
    expect(needsDetail(plan, 0.5)).toBe(true);
    expect(needsDetail(plan, 0.2, 2)).toBe(true);
    expect(needsDetail({ mode: "single", width: 10, height: 10 }, 8)).toBe(false);
  });
  it("rilascia le tessere meno recenti e non visibili oltre il tetto", () => {
    const loaded = new Map([["a", 1], ["b", 5], ["c", 3], ["d", 9]]);
    expect(tilesToEvict(loaded, new Set(["a"]), 2).sort()).toEqual(["b", "c"]);
    expect(tilesToEvict(loaded, new Set(), 4)).toEqual([]);
    expect(tilesToEvict(loaded, new Set(["a", "b", "c", "d"]), 1)).toEqual([]);
  });
});
