import type {
  Advantage,
  DieResult,
  ParsedFormula,
  ParsedTerm,
  RandomInt,
  RollResult,
  RollTermResult,
} from "./types.js";

/**
 * Tira una formula già validata da `parseFormula`.
 *
 * `randomInt(maxExclusive)` deve restituire un intero uniforme in [0, maxExclusive).
 * Un valore fuori da questo intervallo è un errore di chi inietta l'RNG e lancia RangeError.
 * Il roller non lancia altro: la formula è già valida per costruzione.
 */
export function roll(formula: ParsedFormula, randomInt: RandomInt): RollResult {
  const diceTerms = formula.terms.filter((term) => term.kind === "dice");
  const soleD20 = diceTerms.length === 1 && isSingleD20(diceTerms[0]);

  const terms = formula.terms.map((term): RollTermResult => {
    // Il vantaggio è ammesso solo con un unico d20 (lo garantisce il parser).
    const withAdvantage = formula.advantage !== "normal" && term.kind === "dice";
    return rollTerm(term, randomInt, withAdvantage ? formula.advantage : "normal");
  });

  const total = terms.reduce((sum, term) => sum + term.signedValue, 0);
  if (!Number.isSafeInteger(total)) {
    throw new RangeError("Totale del tiro fuori dall'intervallo intero sicuro");
  }

  const formulaText = formatFormula(formula);
  const decisive = soleD20 ? decisiveD20Value(terms) : undefined;
  const critical = decisive === 20;
  const criticalFailure = decisive === 1;

  return {
    formula: formulaText,
    advantage: formula.advantage,
    terms,
    total,
    detail: `${formulaText} → ${formatParts(terms)} = ${total}`,
    critical,
    criticalFailure,
  };
}

function isSingleD20(term: ParsedTerm | undefined): boolean {
  return (
    term !== undefined &&
    term.kind === "dice" &&
    term.count === 1 &&
    term.sides === 20
  );
}

function rollFace(randomInt: RandomInt, sides: number): number {
  const raw = randomInt(sides);
  if (!Number.isSafeInteger(raw) || raw < 0 || raw >= sides) {
    throw new RangeError(`randomInt(${sides}) ha restituito ${String(raw)}`);
  }
  return raw + 1;
}

function rollTerm(
  term: ParsedTerm,
  randomInt: RandomInt,
  advantage: Advantage,
): RollTermResult {
  if (term.kind === "constant") {
    return {
      kind: "constant",
      sign: term.sign,
      value: term.value,
      signedValue: term.sign * term.value,
    };
  }

  const rolledCount = advantage === "normal" ? term.count : 2;
  const dice: DieResult[] = [];
  for (let i = 0; i < rolledCount; i++) {
    dice.push({ face: term.sides, value: rollFace(randomInt, term.sides), kept: true });
  }

  if (advantage !== "normal") {
    applyKeep(dice, advantage === "advantage" ? "highest" : "lowest", 1);
  } else if (term.keep) {
    applyKeep(dice, term.keep.mode, term.keep.count);
  }

  const subtotal = dice.reduce((sum, die) => (die.kept ? sum + die.value : sum), 0);
  return {
    kind: "dice",
    sign: term.sign,
    count: term.count,
    sides: term.sides,
    ...(term.keep ? { keep: term.keep } : {}),
    dice,
    signedValue: term.sign * subtotal,
  };
}

/** Segna come tenuti i `count` dadi più alti o più bassi. A parità vince il primo. */
function applyKeep(dice: DieResult[], mode: "highest" | "lowest", count: number): void {
  const ranked = dice
    .map((die, index) => ({ die, index }))
    .sort((a, b) => {
      if (a.die.value !== b.die.value) {
        return mode === "highest" ? b.die.value - a.die.value : a.die.value - b.die.value;
      }
      return a.index - b.index;
    });
  ranked.forEach((entry, rank) => {
    entry.die.kept = rank < count;
  });
}

function decisiveD20Value(terms: RollTermResult[]): number | undefined {
  for (const term of terms) {
    if (term.kind === "dice") {
      const kept = term.dice.find((die) => die.kept);
      return kept?.value;
    }
  }
  return undefined;
}

/** Forma canonica della formula: `2d6+3`, `4d6kh3`, `1d20 adv`. */
export function formatFormula(formula: ParsedFormula): string {
  const body = formula.terms
    .map((term, index) => {
      const sign = term.sign === 1 ? (index === 0 ? "" : "+") : "-";
      if (term.kind === "constant") return `${sign}${term.value}`;
      const keep = term.keep
        ? `k${term.keep.mode === "highest" ? "h" : "l"}${term.keep.count}`
        : "";
      return `${sign}${term.count}d${term.sides}${keep}`;
    })
    .join("");
  if (formula.advantage === "advantage") return `${body} adv`;
  if (formula.advantage === "disadvantage") return `${body} dis`;
  return body;
}

function formatParts(terms: RollTermResult[]): string {
  return terms
    .map((term, index) => {
      const isFirst = index === 0;
      const sign = isFirst ? (term.sign === -1 ? "-" : "") : term.sign === -1 ? " - " : " + ";
      if (term.kind === "constant") return `${sign}${term.value}`;
      const faces = term.dice
        .map((die) => (die.kept ? String(die.value) : `(${die.value})`))
        .join(", ");
      return `${sign}[${faces}]`;
    })
    .join("");
}
