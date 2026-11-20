import { describe, expect, it } from "vitest";
import { makeDemoTokens, seededRandom } from "./demoData";

describe("dati di prova", () => {
  it("il PRNG e' deterministico", () => {
    const a = seededRandom(1);
    const b = seededRandom(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("genera il numero richiesto di token dentro la mappa e senza celle ripetute", () => {
    const tokens = makeDemoTokens({ count: 300, mapWidth: 4000, mapHeight: 3000, cellSize: 70 });
    expect(tokens).toHaveLength(300);
    expect(new Set(tokens.map((t) => t.id)).size).toBe(300);
    for (const t of tokens) {
      expect(t.x).toBeGreaterThan(0);
      expect(t.x).toBeLessThan(4000);
      expect(t.y).toBeLessThan(3000);
    }
    expect(tokens.some((t) => t.hidden)).toBe(true);
  });
});
