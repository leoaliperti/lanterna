import { describe, expect, it } from "vitest";
import { parseFormula } from "./parser.js";
import type { DiceErrorCode, ParsedFormula } from "./types.js";

function parseOk(input: string): ParsedFormula {
  const result = parseFormula(input);
  if (!result.ok) {
    throw new Error(`attesa formula valida per "${input}", ricevuto ${result.error.code}`);
  }
  return result.formula;
}

function expectError(input: string, code: DiceErrorCode): void {
  const result = parseFormula(input);
  expect(result.ok, `"${input}" doveva fallire`).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.message.length).toBeGreaterThan(0);
}

describe("parseFormula: formule valide", () => {
  it("riconosce un singolo dado NdM", () => {
    expect(parseOk("2d6")).toEqual({
      terms: [{ kind: "dice", sign: 1, count: 2, sides: 6 }],
      advantage: "normal",
    });
  });

  it("accetta N implicito a 1 quando scrivi solo dM", () => {
    expect(parseOk("d8").terms).toEqual([{ kind: "dice", sign: 1, count: 1, sides: 8 }]);
  });

  it("tratta d% come d100", () => {
    expect(parseOk("d%").terms).toEqual([{ kind: "dice", sign: 1, count: 1, sides: 100 }]);
    expect(parseOk("2d%").terms).toEqual([{ kind: "dice", sign: 1, count: 2, sides: 100 }]);
  });

  it("accetta maiuscole e minuscole", () => {
    expect(parseOk("2D6+3").terms).toEqual(parseOk("2d6+3").terms);
    expect(parseOk("4D6KH3").terms).toEqual(parseOk("4d6kh3").terms);
    expect(parseOk("D20 ADV").advantage).toBe("advantage");
  });

  it("tollera spazi tra i token", () => {
    expect(parseOk("  2 d 6 +  3 ").terms).toEqual(parseOk("2d6+3").terms);
    expect(parseOk("1d20 + 5 - 2").terms).toEqual(parseOk("1d20+5-2").terms);
  });

  it("gestisce costanti e somme di più termini", () => {
    expect(parseOk("2d6+3").terms).toEqual([
      { kind: "dice", sign: 1, count: 2, sides: 6 },
      { kind: "constant", sign: 1, value: 3 },
    ]);
    expect(parseOk("1d20+5-2").terms).toEqual([
      { kind: "dice", sign: 1, count: 1, sides: 20 },
      { kind: "constant", sign: 1, value: 5 },
      { kind: "constant", sign: -1, value: 2 },
    ]);
    expect(parseOk("2d8+1d4+3").terms).toEqual([
      { kind: "dice", sign: 1, count: 2, sides: 8 },
      { kind: "dice", sign: 1, count: 1, sides: 4 },
      { kind: "constant", sign: 1, value: 3 },
    ]);
  });

  it("accetta un segno iniziale sul primo termine", () => {
    expect(parseOk("-1d4+10").terms).toEqual([
      { kind: "dice", sign: -1, count: 1, sides: 4 },
      { kind: "constant", sign: 1, value: 10 },
    ]);
    expect(parseOk("+5").terms).toEqual([{ kind: "constant", sign: 1, value: 5 }]);
  });

  it("riconosce keep highest e keep lowest", () => {
    expect(parseOk("4d6kh3").terms).toEqual([
      { kind: "dice", sign: 1, count: 4, sides: 6, keep: { mode: "highest", count: 3 } },
    ]);
    expect(parseOk("4d6kl1").terms).toEqual([
      { kind: "dice", sign: 1, count: 4, sides: 6, keep: { mode: "lowest", count: 1 } },
    ]);
  });

  it("usa 1 come numero di dadi tenuti se kh/kl non ha cifre", () => {
    expect(parseOk("2d20kh").terms).toEqual([
      { kind: "dice", sign: 1, count: 2, sides: 20, keep: { mode: "highest", count: 1 } },
    ]);
  });

  it("applica keep solo al proprio gruppo di dadi", () => {
    expect(parseOk("4d6kh3+2d4kl1").terms).toEqual([
      { kind: "dice", sign: 1, count: 4, sides: 6, keep: { mode: "highest", count: 3 } },
      { kind: "dice", sign: 1, count: 2, sides: 4, keep: { mode: "lowest", count: 1 } },
    ]);
  });

  it("riconosce vantaggio e svantaggio prima o dopo la formula", () => {
    expect(parseOk("d20 adv")).toEqual({
      terms: [{ kind: "dice", sign: 1, count: 1, sides: 20 }],
      advantage: "advantage",
    });
    expect(parseOk("adv d20").advantage).toBe("advantage");
    expect(parseOk("d20 dis").advantage).toBe("disadvantage");
    expect(parseOk("dis d20").advantage).toBe("disadvantage");
    expect(parseOk("d20+5 adv").advantage).toBe("advantage");
    expect(parseOk("adv 1d20+5-2").terms).toHaveLength(3);
  });

  it("non aggiunge vantaggio quando non c'è", () => {
    expect(parseOk("d20+5").advantage).toBe("normal");
  });
});

describe("parseFormula: errori di sintassi", () => {
  it("rifiuta formule vuote o di soli spazi", () => {
    expectError("", "FORMULA_VUOTA");
    expectError("   \t ", "FORMULA_VUOTA");
  });

  it("rifiuta caratteri non ammessi", () => {
    expectError("2d6;", "CARATTERE_NON_VALIDO");
    expectError("2d6*2", "CARATTERE_NON_VALIDO");
    expectError("(1d6)", "CARATTERE_NON_VALIDO");
    expectError("2d6€", "CARATTERE_NON_VALIDO");
  });

  it("rifiuta parole sconosciute", () => {
    expectError("dd6", "SINTASSI_NON_VALIDA");
    expectError("2dx", "SINTASSI_NON_VALIDA");
    expectError("d6 foo", "SINTASSI_NON_VALIDA");
  });

  it("rifiuta formule incomplete o malformate", () => {
    expectError("d", "SINTASSI_NON_VALIDA");
    expectError("2d", "SINTASSI_NON_VALIDA");
    expectError("2+", "SINTASSI_NON_VALIDA");
    expectError("+", "SINTASSI_NON_VALIDA");
    expectError("2d6 3", "SINTASSI_NON_VALIDA");
    expectError("2 6", "SINTASSI_NON_VALIDA");
    expectError("2d6++3", "SINTASSI_NON_VALIDA");
    expectError("kh3", "SINTASSI_NON_VALIDA");
  });

  it("rifiuta input che non è una stringa, senza eccezioni", () => {
    expect(parseFormula(123 as unknown as string)).toMatchObject({
      ok: false,
      error: { code: "SINTASSI_NON_VALIDA" },
    });
    expect(parseFormula(null as unknown as string)).toMatchObject({ ok: false });
  });

  it("restituisce messaggi in italiano", () => {
    const result = parseFormula("2d6;");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/Carattere non valido/);
  });
});

describe("parseFormula: limiti", () => {
  it("accetta i limiti estremi di dadi e facce", () => {
    parseOk("1d2");
    parseOk("100d6");
    parseOk("1d1000");
    parseOk("d%");
  });

  it("rifiuta da 0 dadi, più di 100 dadi in un termine, facce fuori da 2..1000", () => {
    expectError("0d6", "DADI_FUORI_LIMITE");
    expectError("101d6", "DADI_FUORI_LIMITE");
    expectError("1d1", "DADI_FUORI_LIMITE");
    expectError("1d0", "DADI_FUORI_LIMITE");
    expectError("1d1001", "DADI_FUORI_LIMITE");
    expectError("d1001", "DADI_FUORI_LIMITE");
  });

  it("accetta fino a 100 dadi in totale e rifiuta oltre", () => {
    // 100 dadi in più termini: il limite è sul totale della formula.
    expect(() => parseOk("50d6+50d6")).not.toThrow();
    expectError("100d6+1d6", "TROPPI_DADI");
    expectError("60d6+50d6", "TROPPI_DADI");
  });

  it("accetta fino a 20 termini e rifiuta il ventunesimo", () => {
    const twenty = Array.from({ length: 20 }, () => "1").join("+");
    expect(parseOk(twenty).terms).toHaveLength(20);
    const twentyOne = `${twenty}+1`;
    expectError(twentyOne, "TROPPI_TERMINI");
  });

  it("accetta una formula di 200 caratteri e rifiuta 201", () => {
    // Formula valida lunga: un termine seguito da spazi.
    const padded = `1${" ".repeat(199)}`;
    expect(padded.length).toBe(200);
    expect(() => parseOk(padded)).not.toThrow();
    expectError(`${padded} `, "FORMULA_TROPPO_LUNGA");
  });

  it("limita le costanti a un milione in valore assoluto", () => {
    expect(() => parseOk("1000000")).not.toThrow();
    expectError("1000001", "COSTANTE_FUORI_LIMITE");
    expectError(`${"9".repeat(60)}`, "COSTANTE_FUORI_LIMITE");
  });

  it("non esplode su numeri lunghissimi dentro il limite di caratteri", () => {
    const result = parseFormula(`${"0".repeat(190)}1d6`);
    expect(result.ok).toBe(true);
  });
});

describe("parseFormula: keep e vantaggio non validi", () => {
  it("rifiuta keep fuori dall'intervallo 1..N", () => {
    expectError("4d6kh0", "KEEP_NON_VALIDO");
    expectError("4d6kh5", "KEEP_NON_VALIDO");
    expectError("4d6kl9", "KEEP_NON_VALIDO");
    expect(() => parseOk("4d6kh4")).not.toThrow();
  });

  it("rifiuta keep su costanti", () => {
    expectError("3kh2", "KEEP_NON_VALIDO");
    expectError("2d6+3kh1", "KEEP_NON_VALIDO");
  });

  it("rifiuta vantaggio su formule che non sono un singolo d20", () => {
    expectError("2d20 adv", "VANTAGGIO_NON_APPLICABILE");
    expectError("d12 adv", "VANTAGGIO_NON_APPLICABILE");
    expectError("d20+1d4 adv", "VANTAGGIO_NON_APPLICABILE");
    expectError("2d6 dis", "VANTAGGIO_NON_APPLICABILE");
    expectError("d20kh1 adv", "VANTAGGIO_NON_APPLICABILE");
    expectError("-d20 adv", "VANTAGGIO_NON_APPLICABILE");
    expectError("5 adv", "VANTAGGIO_NON_APPLICABILE");
  });

  it("rifiuta vantaggio e svantaggio insieme", () => {
    expectError("d20 adv dis", "VANTAGGIO_CONFLITTO");
    expectError("adv d20 dis", "VANTAGGIO_CONFLITTO");
  });

  it("rifiuta vantaggio ripetuto o in posizione errata", () => {
    expectError("adv d20 adv", "SINTASSI_NON_VALIDA");
    expectError("d20 adv+5", "SINTASSI_NON_VALIDA");
    expectError("adv", "SINTASSI_NON_VALIDA");
  });
});

/** PRNG deterministico (mulberry32): il fuzzing è riproducibile senza dipendenze. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("parseFormula: fuzzing", () => {
  const ALPHABET = [
    "0123456789",
    "dDkKhHlLaAdDvViIsS",
    "+-%",
    " \t\n",
    "*/()[];:,.!?\\\"'",
    "àèéòùßÿ€😀\u0000​",
  ].join("");

  const KNOWN_CODES = new Set<DiceErrorCode>([
    "FORMULA_VUOTA",
    "FORMULA_TROPPO_LUNGA",
    "CARATTERE_NON_VALIDO",
    "SINTASSI_NON_VALIDA",
    "DADI_FUORI_LIMITE",
    "TROPPI_DADI",
    "TROPPI_TERMINI",
    "COSTANTE_FUORI_LIMITE",
    "KEEP_NON_VALIDO",
    "VANTAGGIO_NON_APPLICABILE",
    "VANTAGGIO_CONFLITTO",
  ]);

  it("non lancia mai eccezioni e restituisce sempre un risultato coerente", () => {
    const random = seededRandom(0xdeadbeef);
    let valid = 0;
    // Metà caratteri casuali, metà sequenze di token quasi validi (per colpire anche le formule valide).
    const TOKENS = ["1", "2", "6", "20", "100", "0", "1000", "d", "D", "d%", "kh", "kl", "+", "-", " ", "adv", "dis", "%", "x"];
    for (let iteration = 0; iteration < 20000; iteration++) {
      let input = "";
      if (iteration % 2 === 0) {
        const length = Math.floor(random() * 260);
        for (let k = 0; k < length; k++) {
          input += ALPHABET.charAt(Math.floor(random() * ALPHABET.length));
        }
      } else {
        const count = Math.floor(random() * 12);
        for (let k = 0; k < count; k++) {
          input += TOKENS[Math.floor(random() * TOKENS.length)] ?? "";
        }
      }

      let result: ReturnType<typeof parseFormula> | undefined;
      expect(() => {
        result = parseFormula(input);
      }, `input: ${JSON.stringify(input)}`).not.toThrow();
      if (!result) throw new Error("risultato mancante");

      if (result.ok) {
        valid++;
        const { terms, advantage } = result.formula;
        expect(terms.length).toBeGreaterThanOrEqual(1);
        expect(terms.length).toBeLessThanOrEqual(20);
        const dice = terms.reduce((sum, t) => sum + (t.kind === "dice" ? t.count : 0), 0);
        expect(dice).toBeLessThanOrEqual(100);
        if (advantage !== "normal") expect(dice).toBe(1);
      } else {
        expect(KNOWN_CODES.has(result.error.code), JSON.stringify(input)).toBe(true);
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    }
    // Il fuzzing deve colpire anche qualche formula valida, altrimenti non prova nulla.
    expect(valid).toBeGreaterThan(0);
  });
});
