import { describe, expect, it } from "vitest";
import { parseFormula } from "./parser.js";
import { roll } from "./roller.js";
import type { RandomInt, RollResult } from "./types.js";

/**
 * RNG fittizio: restituisce i valori in sequenza. Ogni chiamata è registrata
 * così i test controllano anche il numero di facce richieste.
 */
function scriptedRng(values: number[]): { rng: RandomInt; calls: number[] } {
  const calls: number[] = [];
  let index = 0;
  const rng: RandomInt = (maxExclusive) => {
    calls.push(maxExclusive);
    const value = values[index++];
    if (value === undefined) throw new Error("RNG fittizio esaurito");
    return value;
  };
  return { rng, calls };
}

function rollWith(input: string, values: number[]): { result: RollResult; calls: number[] } {
  const parsed = parseFormula(input);
  if (!parsed.ok) throw new Error(`formula non valida in test: ${input} (${parsed.error.code})`);
  const { rng, calls } = scriptedRng(values);
  return { result: roll(parsed.formula, rng), calls };
}

describe("roll: esiti deterministici", () => {
  it("2d6+3 produce dettaglio e totale attesi", () => {
    // randomInt restituisce 0..5: 3 e 4 diventano le facce 4 e 5.
    const { result, calls } = rollWith("2d6+3", [3, 4]);
    expect(calls).toEqual([6, 6]);
    expect(result.total).toBe(12);
    expect(result.detail).toBe("2d6+3 → [4, 5] + 3 = 12");
    expect(result.formula).toBe("2d6+3");
    expect(result.advantage).toBe("normal");
    expect(result.terms).toEqual([
      {
        kind: "dice",
        sign: 1,
        count: 2,
        sides: 6,
        dice: [
          { face: 6, value: 4, kept: true },
          { face: 6, value: 5, kept: true },
        ],
        signedValue: 9,
      },
      { kind: "constant", sign: 1, value: 3, signedValue: 3 },
    ]);
  });

  it("gestisce sottrazione e segno iniziale negativo", () => {
    expect(rollWith("1d20+5-2", [9]).result.detail).toBe("1d20+5-2 → [10] + 5 - 2 = 13");
    const negative = rollWith("-1d4+10", [2]).result;
    expect(negative.total).toBe(7);
    expect(negative.detail).toBe("-1d4+10 → -[3] + 10 = 7");
  });

  it("tira più gruppi di dadi con un solo termine costante", () => {
    const { result } = rollWith("2d8+1d4+3", [4, 6, 1]);
    expect(result.total).toBe(5 + 7 + 2 + 3);
    expect(result.detail).toBe("2d8+1d4+3 → [5, 7] + [2] + 3 = 17");
  });

  it("una formula di sole costanti non chiama l'RNG", () => {
    const { result, calls } = rollWith("5", []);
    expect(calls).toEqual([]);
    expect(result.total).toBe(5);
    expect(result.detail).toBe("5 → 5 = 5");
    expect(result.critical).toBe(false);
    expect(result.criticalFailure).toBe(false);
  });

  it("d% tira su 100 facce", () => {
    const { result, calls } = rollWith("d%", [41]);
    expect(calls).toEqual([100]);
    expect(result.total).toBe(42);
    expect(result.formula).toBe("1d100");
  });

  it("keep highest scarta il dado più basso", () => {
    // Facce: 1, 6, 4, 3. Tengo i 3 più alti: 6, 4, 3.
    const { result } = rollWith("4d6kh3", [0, 5, 3, 2]);
    expect(result.total).toBe(13);
    expect(result.detail).toBe("4d6kh3 → [(1), 6, 4, 3] = 13");
    expect(result.formula).toBe("4d6kh3");
  });

  it("keep lowest tiene il dado più basso", () => {
    const { result } = rollWith("4d6kl1", [0, 5, 3, 2]);
    expect(result.total).toBe(1);
    expect(result.detail).toBe("4d6kl1 → [1, (6), (4), (3)] = 1");
  });

  it("in caso di parità tiene il dado che compare prima", () => {
    const high = rollWith("3d6kh1", [3, 3, 1]).result;
    expect(high.terms[0]).toMatchObject({
      dice: [
        { value: 4, kept: true },
        { value: 4, kept: false },
        { value: 2, kept: false },
      ],
    });
    const low = rollWith("3d6kl1", [1, 3, 1]).result;
    expect(low.terms[0]).toMatchObject({
      dice: [
        { value: 2, kept: true },
        { value: 4, kept: false },
        { value: 2, kept: false },
      ],
    });
  });

  it("chiama l'RNG una volta per dado con le facce corrette", () => {
    const { calls } = rollWith("2d8+1d4kh1", [0, 0, 0]);
    expect(calls).toEqual([8, 8, 4]);
  });
});

describe("roll: vantaggio e svantaggio", () => {
  it("d20 adv tira due d20 e tiene il più alto", () => {
    // Facce 6 e 15: tengo 15.
    const { result, calls } = rollWith("d20 adv", [5, 14]);
    expect(calls).toEqual([20, 20]);
    expect(result.advantage).toBe("advantage");
    expect(result.total).toBe(15);
    expect(result.detail).toBe("1d20 adv → [(6), 15] = 15");
    expect(result.terms[0]).toMatchObject({
      kind: "dice",
      dice: [
        { face: 20, value: 6, kept: false },
        { face: 20, value: 15, kept: true },
      ],
    });
  });

  it("d20 dis tiene il più basso", () => {
    const { result } = rollWith("d20 dis", [5, 14]);
    expect(result.advantage).toBe("disadvantage");
    expect(result.total).toBe(6);
    expect(result.detail).toBe("1d20 dis → [6, (15)] = 6");
  });

  it("adv prima della formula con modificatore", () => {
    const { result } = rollWith("adv d20+5", [19, 2]);
    expect(result.total).toBe(20 + 5);
    expect(result.formula).toBe("1d20+5 adv");
    expect(result.detail).toBe("1d20+5 adv → [20, (3)] + 5 = 25");
    expect(result.critical).toBe(true);
  });

  it("in caso di parità tiene il primo dado", () => {
    const { result } = rollWith("d20 adv", [9, 9]);
    expect(result.total).toBe(10);
    expect(result.terms[0]).toMatchObject({
      dice: [
        { value: 10, kept: true },
        { value: 10, kept: false },
      ],
    });
  });

  it("il vantaggio con un 1 e un 20 segnala il critico corrispondente", () => {
    expect(rollWith("d20 adv", [0, 19]).result.critical).toBe(true);
    expect(rollWith("d20 dis", [0, 19]).result.criticalFailure).toBe(true);
  });
});

describe("roll: flag critici", () => {
  it("nat 20 su d20 singolo", () => {
    const result = rollWith("d20", [19]).result;
    expect(result.total).toBe(20);
    expect(result.critical).toBe(true);
    expect(result.criticalFailure).toBe(false);
    expect(result.detail).toBe("1d20 → [20] = 20");
  });

  it("nat 1 su d20 singolo", () => {
    const result = rollWith("1d20", [0]).result;
    expect(result.total).toBe(1);
    expect(result.critical).toBe(false);
    expect(result.criticalFailure).toBe(true);
  });

  it("i modificatori non cambiano il flag del d20", () => {
    expect(rollWith("d20+5-2", [19]).result.critical).toBe(true);
    expect(rollWith("d20+5-2", [0]).result.criticalFailure).toBe(true);
  });

  it("i flag valgono solo per un singolo d20", () => {
    expect(rollWith("2d20", [19, 19]).result.critical).toBe(false);
    expect(rollWith("d20+1d4", [19, 0]).result.critical).toBe(false);
    expect(rollWith("d12", [11]).result.critical).toBe(false);
    expect(rollWith("d6", [0]).result.criticalFailure).toBe(false);
  });
});

describe("roll: formato e serializzazione", () => {
  it("la formula canonica normalizza maiuscole e spazi", () => {
    expect(rollWith("  2D6 +  3 ", [0, 0]).result.formula).toBe("2d6+3");
    expect(rollWith("4D6KH3", [0, 0, 0, 0]).result.formula).toBe("4d6kh3");
  });

  it("il risultato è serializzabile come JSON senza perdite", () => {
    const { result } = rollWith("4d6kh3+2", [0, 5, 3, 2]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("stesso RNG e stessa formula danno lo stesso risultato", () => {
    const parsed = parseFormula("1d6");
    if (!parsed.ok) throw new Error("formula non valida");
    const { rng } = scriptedRng([0]);
    const first = roll(parsed.formula, rng);
    expect(first.total).toBe(1);
    // Una seconda chiamata con lo stesso input e lo stesso RNG dà lo stesso esito.
    const second = roll(parsed.formula, scriptedRng([0]).rng);
    expect(second).toEqual(first);
  });
});

describe("roll: limiti e RNG non valido", () => {
  it("100d1000 al massimo resta un intero sicuro", () => {
    const max = Array.from({ length: 100 }, () => 999);
    const { result } = rollWith("100d1000", max);
    expect(result.total).toBe(100 * 1000);
    expect(Number.isSafeInteger(result.total)).toBe(true);
  });

  it("20 termini con dadi e costanti restano nei limiti", () => {
    const { result } = rollWith("1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1", []);
    expect(result.total).toBe(20);
    expect(result.terms).toHaveLength(20);
  });

  it("un RNG che restituisce fuori intervallo lancia un RangeError", () => {
    const parsed = parseFormula("1d6");
    if (!parsed.ok) throw new Error("formula non valida");
    expect(() => roll(parsed.formula, () => 6)).toThrow(RangeError);
    expect(() => roll(parsed.formula, () => -1)).toThrow(RangeError);
    expect(() => roll(parsed.formula, () => 1.5)).toThrow(RangeError);
    expect(() => roll(parsed.formula, () => Number.NaN)).toThrow(RangeError);
  });
});
