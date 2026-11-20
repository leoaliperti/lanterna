import { describe, expect, it } from "vitest";
import { DEFAULT_GRID, DEFAULT_SCALE, type Token } from "./schema.js";
import { rng, token } from "./fixtures.test-utils.js";
import { computeLights, computeSight, computeVisibility, pointInPolygon, sightRadiusPx } from "./vision.js";
import type { Wall } from "./walls.js";

const W = 1000;
const H = 1000;

describe("linea di vista (raycasting)", () => {
  it("senza muri e senza raggio vede tutta la mappa", () => {
    const poly = computeVisibility({ x: 500, y: 500, radius: Infinity, segments: [], width: W, height: H });
    expect(pointInPolygon(10, 10, poly)).toBe(true);
    expect(pointInPolygon(990, 990, poly)).toBe(true);
  });

  it("il raggio limita la vista (cerchio approssimato)", () => {
    const poly = computeVisibility({ x: 500, y: 500, radius: 100, segments: [], width: W, height: H });
    expect(pointInPolygon(590, 500, poly)).toBe(true);
    expect(pointInPolygon(610, 500, poly)).toBe(false);
    for (let i = 0; i < poly.length; i += 2) {
      expect(Math.hypot(poly[i]! - 500, poly[i + 1]! - 500)).toBeLessThanOrEqual(100 + 1e-9);
    }
  });

  it("un muro proietta un'ombra; un muro oltre il raggio non conta", () => {
    const wall = [600, 300, 600, 700];
    const poly = computeVisibility({ x: 500, y: 500, radius: Infinity, segments: wall, width: W, height: H });
    expect(pointInPolygon(550, 500, poly)).toBe(true);
    expect(pointInPolygon(800, 500, poly)).toBe(false); // dietro il muro
    expect(pointInPolygon(650, 150, poly)).toBe(true); // di lato, fuori dall'ombra
    const near = computeVisibility({ x: 500, y: 500, radius: 50, segments: wall, width: W, height: H });
    const none = computeVisibility({ x: 500, y: 500, radius: 50, segments: [], width: W, height: H });
    expect(near).toEqual(none);
  });

  it("un muro che attraversa il cerchio senza estremi dentro taglia comunque la vista", () => {
    const poly = computeVisibility({ x: 500, y: 500, radius: 200, segments: [550, 0, 550, 1000], width: W, height: H });
    expect(pointInPolygon(540, 500, poly)).toBe(true);
    expect(pointInPolygon(600, 500, poly)).toBe(false);
    expect(pointInPolygon(400, 500, poly)).toBe(true);
  });

  it("porte aperte non bloccano, chiuse sì; il buio usa scurovisione e luce", () => {
    const scene = { id: "s", width: W, height: H, grid: { ...DEFAULT_GRID, cellSize: 50 }, scale: { ...DEFAULT_SCALE } };
    const door = (open: boolean): Wall => ({ id: "d", sceneId: "s", x1: 600, y1: 0, x2: 600, y2: 1000, door: true, open });
    const t = token("t", { sceneId: "s", x: 500, y: 500, vision: { range: null, darkvision: 60, bright: 0, dim: 0 } });
    const [closed] = computeSight(scene, "bright", [t], [door(false)]);
    const [opened] = computeSight(scene, "bright", [t], [door(true)]);
    expect(pointInPolygon(700, 500, closed!.polygon)).toBe(false);
    expect(pointInPolygon(700, 500, opened!.polygon)).toBe(true);
    // Al buio: 60 ft di scurovisione = 12 celle da 50 px = 600 px.
    expect(sightRadiusPx(t, scene, "dark")).toBe(600);
    expect(sightRadiusPx({ vision: null }, scene, "dark")).toBe(0);
    expect(sightRadiusPx({ vision: undefined }, scene, "bright")).toBe(Infinity);
    const torch = token("torch", { sceneId: "s", x: 100, y: 100, vision: { range: null, darkvision: 0, bright: 20, dim: 20 } });
    const [light] = computeLights(scene, [torch, t], []);
    expect(light!.tokenId).toBe("torch");
    expect(pointInPolygon(100, 290, light!.bright)).toBe(true);
    expect(pointInPolygon(100, 310, light!.bright)).toBe(false);
    expect(pointInPolygon(100, 390, light!.dim)).toBe(true);
  });
});

describe("prestazioni: 200 muri e 50 token", () => {
  function scenario(seed: number) {
    const r = rng(seed);
    const walls: Wall[] = [];
    for (let i = 0; i < 200; i++) {
      const x = r() * 4000;
      const y = r() * 4000;
      const a = r() * Math.PI;
      const len = 70 + r() * 400;
      walls.push({
        id: `w${i}`,
        sceneId: "s",
        x1: x,
        y1: y,
        x2: Math.min(4000, Math.max(0, x + Math.cos(a) * len)),
        y2: Math.min(4000, Math.max(0, y + Math.sin(a) * len)),
        door: false,
        open: false,
      });
    }
    const tokens: Token[] = [];
    for (let i = 0; i < 50; i++) {
      tokens.push(token(`t${i}`, { sceneId: "s", x: r() * 4000, y: r() * 4000, vision: { range: 60, darkvision: 0, bright: 0, dim: 0 } }));
    }
    return { walls, tokens };
  }
  const scene = { id: "s", width: 4000, height: 4000, grid: { ...DEFAULT_GRID }, scale: { ...DEFAULT_SCALE } };

  const measure = (fn: () => void): number => {
    for (let i = 0; i < 3; i++) fn(); // riscaldamento JIT
    const runs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      fn();
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    return runs[Math.floor(runs.length / 2)]!;
  };

  it("ricalcolo completo con raggio 60 ft (840 px) in pochi ms", () => {
    const { walls, tokens } = scenario(1);
    const ms = measure(() => computeSight(scene, "bright", tokens, walls));
    console.info(`[bench visione] 200 muri, 50 token, raggio 840 px: mediana ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(50);
  });

  it("caso pesante: raggio illimitato (tutti i muri per ogni token)", () => {
    const { walls, tokens } = scenario(2);
    const unlimited = tokens.map((t) => ({ ...t, vision: { range: null, darkvision: 0, bright: 0, dim: 0 } }));
    const ms = measure(() => computeSight(scene, "bright", unlimited, walls));
    console.info(`[bench visione] 200 muri, 50 token, raggio illimitato: mediana ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(500);
  });
});
