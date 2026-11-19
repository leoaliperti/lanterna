import { describe, expect, it } from "vitest";
import { CELL, MIN_SCALE, layoutTable } from "./layout";

describe("layoutTable", () => {
  it("nessun dado: nessuna posizione", () => {
    expect(layoutTable(0, 10, 6).positions).toEqual([]);
  });

  it("un dado e' al centro a scala piena", () => {
    const l = layoutTable(1, 20, 10);
    expect(l.positions).toEqual([{ x: 0, z: 0 }]);
    expect(l.scale).toBe(1);
  });

  it("i dadi stanno dentro il tavolo e non si sovrappongono", () => {
    for (const n of [1, 2, 3, 5, 8, 13, 30]) {
      const w = 12;
      const d = 7;
      const { positions, scale } = layoutTable(n, w, d);
      expect(positions).toHaveLength(n);
      expect(scale).toBeGreaterThanOrEqual(MIN_SCALE);
      expect(scale).toBeLessThanOrEqual(1);
      for (const p of positions) {
        if (scale > MIN_SCALE) {
          expect(Math.abs(p.x) + (CELL * scale) / 2).toBeLessThanOrEqual(w / 2 + 1e-9);
          expect(Math.abs(p.z) + (CELL * scale) / 2).toBeLessThanOrEqual(d / 2 + 1e-9);
        }
      }
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = positions[i]!;
          const b = positions[j]!;
          const sep = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
          expect(sep).toBeGreaterThanOrEqual(CELL * scale - 1e-9);
        }
      }
    }
  });
});
