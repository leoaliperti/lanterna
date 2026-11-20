import { describe, expect, it } from "vitest";
import { spawnPoint } from "./tokenDraft";

const scene = { width: 1400, height: 1000, grid: { cellSize: 70, offsetX: 0, offsetY: 0 } };

describe("spawnPoint", () => {
  it("senza token intorno sceglie il centro della scena, sul centro cella", () => {
    expect(spawnPoint(scene, 1)).toEqual({ x: 735, y: 525 });
  });

  it("se il centro è occupato sceglie una cella vicina libera", () => {
    const first = spawnPoint(scene, 1);
    const second = spawnPoint(scene, 1, [first]);
    expect(second).not.toEqual(first);
    expect(Math.max(Math.abs(second.x - first.x), Math.abs(second.y - first.y))).toBe(70);
  });

  it("più token nuovi di fila non si sovrappongono mai", () => {
    const taken: { x: number; y: number }[] = [];
    for (let i = 0; i < 20; i++) taken.push(spawnPoint(scene, 1, taken));
    const keys = new Set(taken.map((t) => `${t.x},${t.y}`));
    expect(keys.size).toBe(20);
  });
});
