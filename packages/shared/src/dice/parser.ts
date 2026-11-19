import type {
  Advantage,
  DiceErrorCode,
  ParsedFormula,
  ParsedTerm,
  ParseResult,
} from "./types.js";

export const MAX_FORMULA_LENGTH = 200;
export const MAX_DICE_TOTAL = 100;
export const MAX_DICE_PER_TERM = 100;
export const MIN_SIDES = 2;
export const MAX_SIDES = 1000;
export const MAX_TERMS = 20;
export const MAX_CONSTANT = 1_000_000;

type Token =
  | { kind: "number"; text: string; value: number }
  | { kind: "d" }
  | { kind: "percent" }
  | { kind: "op"; sign: 1 | -1 }
  | { kind: "keyword"; word: "kh" | "kl" | "adv" | "dis" };

interface Cursor {
  tokens: Token[];
  pos: number;
}

/** Usato solo dentro il parser: viene sempre convertito in `ParseResult`. */
class FormulaFailure {
  constructor(
    readonly code: DiceErrorCode,
    readonly message: string,
  ) {}
}

function fail(code: DiceErrorCode, message: string): never {
  throw new FormulaFailure(code, message);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isLetter(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input.charAt(i);
    if (/\s/.test(ch)) {
      i++;
    } else if (isDigit(ch)) {
      let j = i;
      while (j < input.length && isDigit(input.charAt(j))) j++;
      const text = input.slice(i, j);
      tokens.push({ kind: "number", text, value: Number(text) });
      i = j;
    } else if (isLetter(ch)) {
      let j = i;
      while (j < input.length && isLetter(input.charAt(j))) j++;
      const raw = input.slice(i, j);
      const word = raw.toLowerCase();
      if (word === "d") {
        tokens.push({ kind: "d" });
      } else if (word === "kh" || word === "kl" || word === "adv" || word === "dis") {
        tokens.push({ kind: "keyword", word });
      } else {
        fail("SINTASSI_NON_VALIDA", `Parola non riconosciuta: "${raw}".`);
      }
      i = j;
    } else if (ch === "%") {
      tokens.push({ kind: "percent" });
      i++;
    } else if (ch === "+" || ch === "-") {
      tokens.push({ kind: "op", sign: ch === "+" ? 1 : -1 });
      i++;
    } else {
      fail("CARATTERE_NON_VALIDO", `Carattere non valido: "${ch}".`);
    }
  }
  return tokens;
}

function describe(token: Token): string {
  switch (token.kind) {
    case "number":
      return token.text;
    case "d":
      return "d";
    case "percent":
      return "%";
    case "op":
      return token.sign === 1 ? "+" : "-";
    case "keyword":
      return token.word;
  }
}

function peek(cursor: Cursor): Token | undefined {
  return cursor.tokens[cursor.pos];
}

function readTerm(cursor: Cursor, sign: 1 | -1): ParsedTerm {
  const first = peek(cursor);
  let count: number | undefined;
  if (first?.kind === "number") {
    count = first.value;
    cursor.pos++;
  }

  if (peek(cursor)?.kind !== "d") {
    if (count === undefined) {
      fail(
        "SINTASSI_NON_VALIDA",
        first ? `Token inatteso: "${describe(first)}".` : "La formula è incompleta.",
      );
    }
    if (count > MAX_CONSTANT) {
      fail(
        "COSTANTE_FUORI_LIMITE",
        `Le costanti devono essere tra -${MAX_CONSTANT} e ${MAX_CONSTANT}.`,
      );
    }
    const after = peek(cursor);
    if (after?.kind === "keyword" && (after.word === "kh" || after.word === "kl")) {
      fail("KEEP_NON_VALIDO", "kh/kl si applica solo a gruppi di dadi (es. 4d6kh3).");
    }
    return { kind: "constant", sign, value: count };
  }

  cursor.pos++; // consuma la "d"
  const diceCount = count ?? 1;
  const faces = peek(cursor);
  let sides: number;
  if (faces?.kind === "percent") {
    sides = 100;
    cursor.pos++;
  } else if (faces?.kind === "number") {
    sides = faces.value;
    cursor.pos++;
  } else {
    fail("SINTASSI_NON_VALIDA", "Manca la faccia del dado (es. d6 o d%).");
  }

  if (
    !(diceCount >= 1 && diceCount <= MAX_DICE_PER_TERM) ||
    !(sides >= MIN_SIDES && sides <= MAX_SIDES)
  ) {
    fail(
      "DADI_FUORI_LIMITE",
      `Un gruppo di dadi può avere da 1 a ${MAX_DICE_PER_TERM} dadi con da ${MIN_SIDES} a ${MAX_SIDES} facce.`,
    );
  }

  const keepToken = peek(cursor);
  if (keepToken?.kind === "keyword" && (keepToken.word === "kh" || keepToken.word === "kl")) {
    cursor.pos++;
    let keepCount = 1;
    const countToken = peek(cursor);
    if (countToken?.kind === "number") {
      keepCount = countToken.value;
      cursor.pos++;
    }
    if (!(keepCount >= 1 && keepCount <= diceCount)) {
      fail("KEEP_NON_VALIDO", `kh/kl deve indicare tra 1 e ${diceCount} dadi.`);
    }
    return {
      kind: "dice",
      sign,
      count: diceCount,
      sides,
      keep: { mode: keepToken.word === "kh" ? "highest" : "lowest", count: keepCount },
    };
  }

  return { kind: "dice", sign, count: diceCount, sides };
}

function validateAdvantage(terms: ParsedTerm[]): void {
  const dice = terms.filter((t) => t.kind === "dice");
  const single = dice.length === 1 ? dice[0] : undefined;
  if (
    !single ||
    single.kind !== "dice" ||
    single.count !== 1 ||
    single.sides !== 20 ||
    single.keep !== undefined ||
    single.sign !== 1
  ) {
    fail(
      "VANTAGGIO_NON_APPLICABILE",
      "Vantaggio e svantaggio si applicano solo a una formula con un solo d20 (es. d20+5 adv).",
    );
  }
}

function parseUnchecked(input: unknown): ParsedFormula {
  if (typeof input !== "string") {
    fail("SINTASSI_NON_VALIDA", "La formula deve essere un testo.");
  }
  if (input.length > MAX_FORMULA_LENGTH) {
    fail("FORMULA_TROPPO_LUNGA", `La formula supera ${MAX_FORMULA_LENGTH} caratteri.`);
  }

  const cursor: Cursor = { tokens: tokenize(input), pos: 0 };
  if (cursor.tokens.length === 0) {
    fail("FORMULA_VUOTA", "La formula è vuota.");
  }

  let advantage: Advantage = "normal";
  // Legge una o più parole vantaggio/svantaggio alla posizione corrente.
  const readAdvantageKeywords = (): void => {
    for (;;) {
      const token = peek(cursor);
      if (token?.kind !== "keyword" || (token.word !== "adv" && token.word !== "dis")) return;
      const next: Advantage = token.word === "adv" ? "advantage" : "disadvantage";
      if (advantage !== "normal") {
        if (advantage === next) {
          fail("SINTASSI_NON_VALIDA", "Vantaggio o svantaggio indicato più di una volta.");
        }
        fail("VANTAGGIO_CONFLITTO", "Non puoi usare vantaggio e svantaggio insieme.");
      }
      advantage = next;
      cursor.pos++;
    }
  };

  const terms: ParsedTerm[] = [];
  let totalDice = 0;

  readAdvantageKeywords();
  let sign: 1 | -1 = 1;
  const lead = peek(cursor);
  if (lead?.kind === "op") {
    sign = lead.sign;
    cursor.pos++;
  }

  for (;;) {
    const term = readTerm(cursor, sign);
    if (term.kind === "dice") {
      totalDice += term.count;
      if (totalDice > MAX_DICE_TOTAL) {
        fail("TROPPI_DADI", `La formula supera ${MAX_DICE_TOTAL} dadi in totale.`);
      }
    }
    terms.push(term);
    if (terms.length > MAX_TERMS) {
      fail("TROPPI_TERMINI", `La formula supera ${MAX_TERMS} termini.`);
    }

    const token = peek(cursor);
    if (token === undefined) break;
    if (token.kind === "op") {
      sign = token.sign;
      cursor.pos++;
      continue;
    }
    if (token.kind === "keyword" && (token.word === "adv" || token.word === "dis")) {
      readAdvantageKeywords();
      if (peek(cursor) !== undefined) {
        fail("SINTASSI_NON_VALIDA", "Vantaggio e svantaggio vanno all'inizio o alla fine della formula.");
      }
      break;
    }
    fail("SINTASSI_NON_VALIDA", `Token inatteso: "${describe(token)}".`);
  }

  if (advantage !== "normal") {
    validateAdvantage(terms);
  }

  return { terms, advantage };
}

/**
 * Valida e analizza una formula di dadi. Non lancia mai eccezioni:
 * ogni problema torna come `{ ok: false, error }` con un codice e un messaggio in italiano.
 */
export function parseFormula(input: string): ParseResult {
  try {
    return { ok: true, formula: parseUnchecked(input) };
  } catch (err) {
    if (err instanceof FormulaFailure) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    return {
      ok: false,
      error: { code: "SINTASSI_NON_VALIDA", message: "Formula non valida." },
    };
  }
}
