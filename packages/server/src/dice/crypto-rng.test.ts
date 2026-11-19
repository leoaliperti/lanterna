import { describe, expect, it } from "vitest";
import { parseFormula, roll } from "@lanterna/shared";
import { randomInt } from "./crypto-rng.js";

const ROLLS = 100_000;

/**
 * Statistica chi quadrato sulle facce tirate con il motore completo
 * (parser + roller + crypto RNG). Le soglie sono larghe di proposito:
 * con p circa 1e-4 o meno il test non dà falsi positivi, ma individua
 * un bias evidente come il modulo non uniforme.
 */
function chiSquareForDie(sides: number, rolls: number): { chi2: number; df: number } {
  const parsed = parseFormula(`1d${sides}`);
  if (!parsed.ok) throw new Error(`formula non valida: ${parsed.error.message}`);

  const counts = new Array<number>(sides).fill(0);
  for (let i = 0; i < rolls; i++) {
    const result = roll(parsed.formula, randomInt);
    const value = result.terms[0];
    if (value?.kind !== "dice") throw new Error("termine inatteso");
    const face = value.dice[0]?.value;
    if (face === undefined) throw new Error("dado mancante");
    counts[face - 1]! += 1;
  }

  const expected = rolls / sides;
  const chi2 = counts.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
  return { chi2, df: sides - 1 };
}

describe("randomInt (crypto)", () => {
  it("restituisce sempre un intero in [0, maxExclusive)", () => {
    for (const max of [1, 2, 4, 6, 20, 100, 1000]) {
      for (let i = 0; i < 500; i++) {
        const value = randomInt(max);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(max);
      }
    }
  });

  it("con maxExclusive 1 restituisce sempre 0", () => {
    for (let i = 0; i < 100; i++) expect(randomInt(1)).toBe(0);
  });

  it("rifiuta valori non validi invece di restituire numeri sbagliati", () => {
    expect(() => randomInt(0)).toThrow(RangeError);
    expect(() => randomInt(-3)).toThrow(RangeError);
    // Node usa TypeError per i non interi: basta che lanci.
    expect(() => randomInt(1.5)).toThrow();
  });

  it("d4 è uniforme (chi quadrato, 100000 tiri)", () => {
    const { chi2, df } = chiSquareForDie(4, ROLLS);
    // Chi quadrato con 3 gradi di libertà: 30 è molto oltre il 99.99%.
    expect(df).toBe(3);
    expect(chi2).toBeLessThan(30);
  });

  it("d6 è uniforme (chi quadrato, 100000 tiri)", () => {
    const { chi2, df } = chiSquareForDie(6, ROLLS);
    // 5 gradi di libertà: soglia 35.
    expect(df).toBe(5);
    expect(chi2).toBeLessThan(35);
  });

  it("d20 è uniforme (chi quadrato, 100000 tiri)", () => {
    const { chi2, df } = chiSquareForDie(20, ROLLS);
    // 19 gradi di libertà: soglia 65.
    expect(df).toBe(19);
    expect(chi2).toBeLessThan(65);
  });
});
