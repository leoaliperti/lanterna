import { describe, expect, it } from "vitest";
import {
  angleFrom, cellAt, clampViewport, cullTokens, destinationRect, distanceInUnits, fitViewport, formatDistance, gridLines,
  hitTestToken, isTokenShown, mapToScreen, normalizeRect, resolveDropPosition, screenToMap, sizeFromHandle, snapAngle,
  snapTokenCenter, tokensInRect, visibleRect, zoomAt
} from "./geometry";
import type { GridConfig, MapToken, Viewport } from "./types";

const grid: GridConfig = { cellSize: 50, color: "#ffffff", opacity: 0.5, offsetX: 10, offsetY: 20, snap: true };
const tok = (id: string, x: number, y: number, size = 1, extra: Partial<MapToken> = {}): MapToken => ({ id, x, y, size, rotation: 0, kind: "npc", ...extra });

describe("viewport", () => {
  const vp: Viewport = { x: 100, y: -40, scale: 2 };
  it("schermo e mappa sono l'uno l'inverso dell'altro", () => {
    const p = { x: 321, y: 77 };
    expect(screenToMap(vp, mapToScreen(vp, p))).toEqual(p);
    expect(mapToScreen(vp, { x: 0, y: 0 })).toEqual({ x: 100, y: -40 });
  });
  it("lo zoom mantiene fermo il punto sotto il cursore", () => {
    const anchor = { x: 400, y: 300 };
    const before = screenToMap(vp, anchor);
    const next = zoomAt(vp, anchor, 1.5);
    expect(next.scale).toBeCloseTo(3);
    const after = screenToMap(next, anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it("lo zoom rispetta i limiti e in quel caso non sposta nulla", () => {
    const max = zoomAt({ x: 5, y: 5, scale: 8 }, { x: 50, y: 50 }, 2);
    expect(max).toEqual({ x: 5, y: 5, scale: 8 });
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 0.0001).scale).toBe(0.05);
  });
  it("fit centra la mappa e non ingrandisce oltre 1", () => {
    const v = fitViewport({ width: 8000, height: 6000 }, { width: 1000, height: 800 }, 0);
    expect(v.scale).toBeCloseTo(0.125);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo((800 - 750) / 2);
    expect(fitViewport({ width: 100, height: 100 }, { width: 1000, height: 800 }).scale).toBe(1);
    expect(fitViewport({ width: 0, height: 0 }, { width: 10, height: 10 })).toEqual({ x: 0, y: 0, scale: 1 });
  });
  it("clamp impedisce di perdere la mappa", () => {
    const map = { width: 1000, height: 1000 };
    const screen = { width: 800, height: 600 };
    const lost = clampViewport({ x: 5000, y: -9000, scale: 1 }, map, screen, 100);
    expect(lost).toEqual({ scale: 1, x: 700, y: -900 });
    const ok = { x: 10, y: 10, scale: 1 };
    expect(clampViewport(ok, map, screen)).toEqual(ok);
  });
  it("il rettangolo visibile coincide con lo schermo in coordinate di mappa", () => {
    const r = visibleRect({ x: 100, y: 50, scale: 2 }, { width: 400, height: 200 });
    expect(r).toEqual({ x: -50, y: -25, width: 200, height: 100 });
    expect(visibleRect({ x: 0, y: 0, scale: 1 }, { width: 10, height: 10 }, 5)).toEqual({ x: -5, y: -5, width: 20, height: 20 });
  });
});

describe("snap alla griglia", () => {
  it("un token 1x1 va al centro della cella piu' vicina (con offset)", () => {
    // celle: x da 10 + 50k, y da 20 + 50k. Il centro cella 0,0 e' (35, 45).
    expect(snapTokenCenter({ x: 40, y: 40 }, 1, grid)).toEqual({ x: 35, y: 45 });
    expect(snapTokenCenter({ x: 70, y: 100 }, 1, grid)).toEqual({ x: 85, y: 95 });
  });
  it("un token 2x2 si aggancia a un incrocio", () => {
    expect(snapTokenCenter({ x: 62, y: 71 }, 2, grid)).toEqual({ x: 60, y: 70 });
  });
  it("un token da mezza cella ha l'angolo su un incrocio", () => {
    const p = snapTokenCenter({ x: 36, y: 44 }, 0.5, grid);
    expect(p).toEqual({ x: 22.5, y: 32.5 });
  });
  it("e' idempotente", () => {
    const once = snapTokenCenter({ x: 123, y: 321 }, 1, grid);
    expect(snapTokenCenter(once, 1, grid)).toEqual(once);
  });
  it("senza snap la posizione resta libera", () => {
    const free = { ...grid, snap: false };
    expect(resolveDropPosition({ x: 41.3, y: 7 }, 1, free)).toEqual({ x: 41.3, y: 7 });
    expect(resolveDropPosition({ x: 40, y: 40 }, 1, grid)).toEqual({ x: 35, y: 45 });
    // con i limiti della mappa il centro non esce mai: senza snap sul bordo, con snap di celle intere
    expect(resolveDropPosition({ x: -30, y: 900 }, 1, free, { width: 400, height: 300 })).toEqual({ x: 0, y: 300 });
    const inside = resolveDropPosition({ x: 5000, y: -400 }, 1, grid, { width: 400, height: 300 });
    expect(inside.x).toBeLessThanOrEqual(400);
    expect(inside.y).toBeGreaterThanOrEqual(0);
  });
  it("calcola la cella di destinazione e la cella sotto un punto", () => {
    expect(destinationRect({ x: 35, y: 45 }, 1, 50)).toEqual({ x: 10, y: 20, width: 50, height: 50 });
    expect(cellAt({ x: 9, y: 19 }, grid)).toEqual({ col: -1, row: -1 });
    expect(cellAt({ x: 60, y: 70 }, grid)).toEqual({ col: 1, row: 1 });
  });
  it("gridLines elenca le linee nell'area, rispettando l'offset", () => {
    const { xs, ys } = gridLines({ x: 0, y: 0, width: 120, height: 100 }, grid);
    expect(xs).toEqual([10, 60, 110]);
    expect(ys).toEqual([20, 70]);
    expect(gridLines({ x: 0, y: 0, width: 10, height: 10 }, { ...grid, cellSize: 0 })).toEqual({ xs: [], ys: [] });
  });
});

describe("hit test e selezione", () => {
  const tokens = [tok("a", 100, 100), tok("b", 110, 100), tok("c", 400, 400, 2), tok("h", 200, 200, 1, { hidden: true })];
  it("sceglie il token in cima (ultimo dell'elenco)", () => {
    expect(hitTestToken(tokens, { x: 105, y: 100 }, 50)?.id).toBe("b");
    expect(hitTestToken(tokens, { x: 80, y: 100 }, 50)?.id).toBe("a");
  });
  it("e' circolare e rispetta la dimensione", () => {
    expect(hitTestToken(tokens, { x: 400 + 49, y: 400 }, 50)?.id).toBe("c");
    expect(hitTestToken(tokens, { x: 400 + 40, y: 400 + 40 }, 50)).toBeNull();
  });
  it("ignora i token non visibili e allarga con minRadius", () => {
    const visible = (t: MapToken) => isTokenShown(t, "player");
    expect(hitTestToken(tokens, { x: 200, y: 200 }, 50, 0, visible)).toBeNull();
    expect(hitTestToken(tokens, { x: 200, y: 200 }, 50, 0)?.id).toBe("h");
    expect(hitTestToken(tokens, { x: 130, y: 130 }, 50, 0)).toBeNull();
    expect(hitTestToken(tokens, { x: 130, y: 130 }, 50, 45)?.id).toBe("b");
  });
  it("il rettangolo seleziona i token che interseca", () => {
    expect(tokensInRect(tokens, normalizeRect({ x: 90, y: 90 }, { x: 125, y: 125 }), 50)).toEqual(["a", "b"]);
    expect(tokensInRect(tokens, normalizeRect({ x: 0, y: 0 }, { x: 1000, y: 1000 }), 50, (t) => !t.hidden)).toEqual(["a", "b", "c"]);
    expect(tokensInRect(tokens, { x: 140, y: 140, width: 10, height: 10 }, 50)).toEqual([]);
  });
  it("i nascosti si vedono solo da GM", () => {
    expect(isTokenShown(tok("x", 0, 0, 1, { hidden: true }), "gm")).toBe(true);
    expect(isTokenShown(tok("x", 0, 0, 1, { hidden: true }), "player")).toBe(false);
  });
});

describe("culling", () => {
  it("scarta i token fuori dall'area e tiene quelli che sporgono", () => {
    const tokens = [tok("in", 100, 100), tok("edge", -20, 100), tok("out", -200, 100), tok("far", 5000, 5000)];
    const area = { x: 0, y: 0, width: 800, height: 600 };
    expect(cullTokens(tokens, area, 50).map((t) => t.id)).toEqual(["in", "edge"]);
    expect(cullTokens(tokens, area, 50, 200).map((t) => t.id)).toEqual(["in", "edge", "out"]);
  });
});

describe("rotazione e ridimensionamento", () => {
  it("angolo: 0 in alto, senso orario", () => {
    const c = { x: 0, y: 0 };
    expect(angleFrom(c, { x: 0, y: -10 })).toBeCloseTo(0);
    expect(angleFrom(c, { x: 10, y: 0 })).toBeCloseTo(90);
    expect(angleFrom(c, { x: 0, y: 10 })).toBeCloseTo(180);
    expect(angleFrom(c, { x: -10, y: 0 })).toBeCloseTo(270);
  });
  it("aggancia l'angolo a passi di 15 gradi", () => {
    expect(snapAngle(7)).toBe(0);
    expect(snapAngle(8)).toBe(15);
    expect(snapAngle(359)).toBe(0);
  });
  it("il lato segue la maniglia a mezze celle, con limiti", () => {
    const c = { x: 0, y: 0 };
    expect(sizeFromHandle(c, { x: 50, y: 50 }, 50)).toBe(2);
    expect(sizeFromHandle(c, { x: 30, y: 20 }, 50)).toBe(1);
    expect(sizeFromHandle(c, { x: 1, y: 1 }, 50)).toBe(0.5);
    expect(sizeFromHandle(c, { x: 9999, y: 0 }, 50)).toBe(12);
  });
});

describe("misura", () => {
  const scale = { unitsPerCell: 5, unitLabel: "piedi" };
  it("converte i pixel in unita' di gioco", () => {
    expect(distanceInUnits({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, scale)).toBe(10);
    expect(distanceInUnits({ x: 0, y: 0 }, { x: 30, y: 40 }, 50, scale)).toBeCloseTo(5);
  });
  it("in modalita' griglia la diagonale vale una cella", () => {
    expect(distanceInUnits({ x: 0, y: 0 }, { x: 100, y: 100 }, 50, scale, "grid")).toBe(10);
    expect(distanceInUnits({ x: 0, y: 0 }, { x: 100, y: 100 }, 50, scale, "euclidean")).toBeCloseTo(14.142, 2);
  });
  it("cella non valida non produce NaN", () => {
    expect(distanceInUnits({ x: 0, y: 0 }, { x: 5, y: 5 }, 0, scale)).toBe(0);
  });
  it("formatta con virgola e al massimo una cifra", () => {
    expect(formatDistance(12.5, "piedi")).toBe("12,5 piedi");
    expect(formatDistance(10, "m")).toBe("10 m");
    expect(formatDistance(14.1421, "piedi")).toBe("14,1 piedi");
  });
});
