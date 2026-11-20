import { describe, expect, it } from "vitest";
import { DEFAULT_GRID, DEFAULT_SCALE, computeVisibility, pointInPolygon } from "@lanterna/shared";
import { SightEngine, dashedSegments, segmentsKey, type SightScene, type SightToken } from "./sight";
import { blockingOf, clampToMap, distanceToSegment, hitWall, moveEndpointPatch, snapVertex, wallAddCommand, wallRemoveCommand, wallUpdateCommand, type WallLike } from "./wallLogic";

const grid = { cellSize: 70, offsetX: 0, offsetY: 0 };
const wall = (id: string, x1: number, y1: number, x2: number, y2: number, over: Partial<WallLike> = {}): WallLike => ({ id, door: false, open: false, segments: [x1, y1, x2, y2], ...over });

describe("muri: aggancio, selezione, comandi", () => {
  it("aggancio agli incroci, ai mezzi passi o libero; clamp alla mappa", () => {
    expect(snapVertex({ x: 100, y: 34 }, grid, "grid")).toEqual({ x: 70, y: 0 });
    expect(snapVertex({ x: 100, y: 34 }, grid, "half")).toEqual({ x: 105, y: 35 });
    expect(snapVertex({ x: 100.5, y: 34 }, grid, "free")).toEqual({ x: 100.5, y: 34 });
    expect(snapVertex({ x: 100, y: 34 }, { cellSize: 70, offsetX: 10, offsetY: 5 }, "grid")).toEqual({ x: 80, y: 5 });
    expect(clampToMap({ x: -5, y: 2000 }, 1400, 1000)).toEqual({ x: 0, y: 1000 });
  });
  it("distanza punto-segmento, anche con segmento nullo", () => {
    expect(distanceToSegment({ x: 5, y: 5 }, 0, 0, 10, 0)).toBe(5);
    expect(distanceToSegment({ x: 15, y: 0 }, 0, 0, 10, 0)).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, 0, 0, 0, 0)).toBe(5);
  });
  it("hitWall: estremi prima del corpo, il piu' vicino vince, filtro per porte", () => {
    const walls = [wall("a", 0, 0, 100, 0), wall("b", 0, 8, 100, 8, { door: true })];
    expect(hitWall(walls, { x: 50, y: 2 }, 5)?.wall.id).toBe("a");
    expect(hitWall(walls, { x: 50, y: 7 }, 5)?.wall.id).toBe("b");
    expect(hitWall(walls, { x: 1, y: 1 }, 5)).toMatchObject({ part: "a" });
    expect(hitWall(walls, { x: 99, y: 1 }, 5)).toMatchObject({ part: "b" });
    expect(hitWall(walls, { x: 50, y: 30 }, 5)).toBeNull();
    expect(hitWall(walls, { x: 50, y: 2 }, 5, (w) => w.door)).toBeNull();
  });
  it("comandi: un muro di lunghezza nulla non parte; sposta un estremo", () => {
    expect(wallAddCommand("w1", "s", { x: 70, y: 70 }, { x: 70, y: 70 }, false)).toBeNull();
    expect(wallAddCommand("w1", "s", { x: 0, y: 0 }, { x: 70, y: 0 }, true)).toEqual({
      type: "wall.add",
      wall: { id: "w1", sceneId: "s", x1: 0, y1: 0, x2: 70, y2: 0, door: true, open: false }
    });
    expect(wallUpdateCommand("w1", { open: true })).toEqual({ type: "wall.update", wallId: "w1", patch: { open: true } });
    expect(wallRemoveCommand("w1")).toEqual({ type: "wall.remove", wallId: "w1" });
    const w = wall("w", 0, 0, 70, 0);
    expect(moveEndpointPatch(w, "b", { x: 70, y: 70 })).toEqual({ x1: 0, y1: 0, x2: 70, y2: 70 });
    expect(moveEndpointPatch(w, "a", { x: 70, y: 0 })).toBeNull(); // diventerebbe un punto
  });
  it("blockingOf: le porte aperte non bloccano la vista", () => {
    const walls = [wall("a", 0, 0, 1, 1), wall("p", 2, 2, 3, 3, { door: true, open: true }), wall("c", 4, 4, 5, 5, { door: true })];
    expect(blockingOf(walls)).toEqual([0, 0, 1, 1, 4, 4, 5, 5]);
  });
});

describe("tratteggio", () => {
  it("spezza una linea in tratti e spazi regolari", () => {
    const segs = dashedSegments([0, 0, 100, 0], 10, 10, false);
    expect(segs.length / 4).toBe(5);
    expect(segs.slice(0, 4)).toEqual([0, 0, 10, 0]);
    expect(segs.slice(4, 8)).toEqual([20, 0, 30, 0]);
  });
  it("la fase continua da un lato all'altro; poligono chiuso", () => {
    const segs = dashedSegments([0, 0, 15, 0, 15, 15], 10, 10, true);
    // lato 1 (15): tratto 0-10, spazio fino a 15 (5 di spazio), lato 2: altri 5 di spazio, poi tratto 5-15
    expect(segs.slice(0, 4)).toEqual([0, 0, 10, 0]);
    expect(segs.slice(4, 8)).toEqual([15, 5, 15, 15]);
    expect(dashedSegments([0, 0], 10, 10)).toEqual([]);
  });
});

const scene: SightScene = { id: "s", width: 1400, height: 1000, grid: { ...DEFAULT_GRID }, scale: { ...DEFAULT_SCALE } };
const tok = (id: string, x: number, y: number, range: number | null = 30): SightToken => ({ id, x, y, vision: { range, darkvision: 0, bright: 0, dim: 0 } });

describe("aiuto visivo: ricalcolo selettivo", () => {
  const room = [300, 0, 300, 1000]; // un muro verticale
  it("il poligono e' quello di computeVisibility della logica condivisa (il muro taglia la vista)", () => {
    const engine = new SightEngine();
    const { areas } = engine.compute(scene, "bright", [tok("a", 200, 500, 60)], room);
    const expected = computeVisibility({ x: 200, y: 500, radius: 60 * (DEFAULT_GRID.cellSize / DEFAULT_SCALE.unitsPerCell), segments: room, width: 1400, height: 1000 });
    expect(areas[0]!.polygon).toEqual(expected);
    expect(pointInPolygon(100, 500, areas[0]!.polygon)).toBe(true);
    expect(pointInPolygon(400, 500, areas[0]!.polygon)).toBe(false); // dietro il muro
  });
  it("nessun cambiamento = nessun ricalcolo e lo STESSO array", () => {
    const engine = new SightEngine();
    const tokens = [tok("a", 200, 500), tok("b", 800, 500)];
    const first = engine.compute(scene, "bright", tokens, room);
    expect(first.stats.recomputed).toBe(2);
    const again = engine.compute(scene, "bright", tokens.map((t) => ({ ...t })), [...room]);
    expect(again.stats.recomputed).toBe(0);
    expect(again.areas).toBe(first.areas);
  });
  it("si muove un solo token: si ricalcola solo quello", () => {
    const engine = new SightEngine();
    const first = engine.compute(scene, "bright", [tok("a", 200, 500), tok("b", 800, 500), tok("c", 1000, 200)], room);
    const next = engine.compute(scene, "bright", [tok("a", 200, 500), tok("b", 870, 500), tok("c", 1000, 200)], room);
    expect(next.stats.recomputed).toBe(1);
    expect(next.areas[0]).toBe(first.areas[0]);
    expect(next.areas[1]).not.toBe(first.areas[1]);
    expect(next.areas[2]).toBe(first.areas[2]);
  });
  it("cambiano i muri, la luce o la scena: si ricalcolano tutti", () => {
    const engine = new SightEngine();
    const tokens = [tok("a", 200, 500), tok("b", 800, 500)];
    engine.compute(scene, "bright", tokens, room);
    expect(engine.compute(scene, "bright", tokens, [300, 0, 300, 900]).stats.recomputed).toBe(2);
    expect(engine.compute(scene, "dark", tokens, [300, 0, 300, 900]).stats.recomputed).toBe(2);
    expect(engine.compute({ ...scene, id: "t" }, "dark", tokens, [300, 0, 300, 900]).stats.recomputed).toBe(2);
  });
  it("i token senza vista non si calcolano; quelli spariti escono dalla cache", () => {
    const engine = new SightEngine();
    engine.compute(scene, "bright", [tok("a", 200, 500), { id: "n", x: 1, y: 1, vision: null }, { id: "m", x: 2, y: 2 }], []);
    expect(engine.size).toBe(1);
    engine.compute(scene, "bright", [], []);
    expect(engine.size).toBe(0);
  });
  it("budget: oltre il tempo concesso il resto aspetta la passata successiva (almeno un token per passata)", () => {
    let t = 0;
    const engine = new SightEngine(() => (t += 10)); // ogni lettura dell'orologio costa 10 ms
    const tokens = Array.from({ length: 5 }, (_, i) => tok(`t${i}`, 100 + i * 100, 500));
    const first = engine.compute(scene, "bright", tokens, [], 15);
    expect(first.stats.recomputed).toBeGreaterThanOrEqual(1);
    expect(first.stats.recomputed).toBeLessThan(5);
    expect(first.stats.pending).toBe(5 - first.stats.recomputed);
    let guard = 0;
    let pending = first.stats.pending;
    while (pending > 0 && guard++ < 10) pending = engine.compute(scene, "bright", tokens, [], 15).stats.pending;
    expect(pending).toBe(0);
    expect(engine.compute(scene, "bright", tokens, [], 15).areas).toHaveLength(5);
  });
  it("luce emessa: due poligoni (intensa e fino a fioca)", () => {
    const engine = new SightEngine();
    const t: SightToken = { id: "l", x: 500, y: 500, vision: { range: 0, darkvision: 0, bright: 20, dim: 20 } };
    const { areas } = engine.compute(scene, "bright", [t], []);
    expect(areas[0]!.polygon).toEqual([]); // range 0: non vede
    expect(areas[0]!.light!.bright.length).toBeGreaterThan(6);
    expect(areas[0]!.light!.dim.length).toBeGreaterThan(6);
  });
  it("impronta dei muri: stabile e sensibile ai cambiamenti", () => {
    expect(segmentsKey([1, 2, 3, 4])).toBe(segmentsKey([1, 2, 3, 4]));
    expect(segmentsKey([1, 2, 3, 4])).not.toBe(segmentsKey([1, 2, 3, 5]));
  });
  it("tempo di ricalcolo: 50 token con 200 muri entro un budget ragionevole", () => {
    const walls: number[] = [];
    for (let i = 0; i < 200; i++) walls.push((i * 97) % 1300, (i * 53) % 900, ((i * 97) % 1300) + 60, ((i * 53) % 900) + 5);
    const tokens = Array.from({ length: 50 }, (_, i) => tok(`t${i}`, 50 + ((i * 131) % 1300), 50 + ((i * 71) % 900), 60));
    const engine = new SightEngine();
    const t0 = performance.now();
    engine.compute(scene, "bright", tokens, walls, Infinity);
    const full = performance.now() - t0;
    tokens[3] = { ...tokens[3]!, x: tokens[3]!.x + 70 };
    const t1 = performance.now();
    const r = engine.compute(scene, "bright", tokens, walls, Infinity);
    const one = performance.now() - t1;
    expect(r.stats.recomputed).toBe(1);
    expect(full).toBeLessThan(500);
    expect(one).toBeLessThan(50);
  });
});
