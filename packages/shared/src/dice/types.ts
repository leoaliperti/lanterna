/** Chi vede l'esito di un tiro. Tipo condiviso con il resto del progetto. */
export type RollVisibility = "public" | "gm" | "whisper";

/** Codici degli errori di formula: il client li può usare per messaggi mirati. */
export type DiceErrorCode =
  | "FORMULA_VUOTA"
  | "FORMULA_TROPPO_LUNGA"
  | "CARATTERE_NON_VALIDO"
  | "SINTASSI_NON_VALIDA"
  | "DADI_FUORI_LIMITE"
  | "TROPPI_DADI"
  | "TROPPI_TERMINI"
  | "COSTANTE_FUORI_LIMITE"
  | "KEEP_NON_VALIDO"
  | "VANTAGGIO_NON_APPLICABILE"
  | "VANTAGGIO_CONFLITTO";

/** Errore tipizzato e serializzabile. I messaggi sono in italiano. */
export interface DiceError {
  code: DiceErrorCode;
  message: string;
}

/** Vantaggio/svantaggio: tira due d20 e tiene il più alto/basso. */
export type Advantage = "normal" | "advantage" | "disadvantage";

/** Funzione iniettata: restituisce un intero uniforme in [0, maxExclusive). */
export type RandomInt = (maxExclusive: number) => number;

export interface ParsedDiceTerm {
  kind: "dice";
  sign: 1 | -1;
  count: number;
  sides: number;
  keep?: { mode: "highest" | "lowest"; count: number };
}

export interface ParsedConstantTerm {
  kind: "constant";
  sign: 1 | -1;
  value: number;
}

export type ParsedTerm = ParsedDiceTerm | ParsedConstantTerm;

/** Formula validata. Si ottiene solo da `parseFormula`. */
export interface ParsedFormula {
  terms: ParsedTerm[];
  advantage: Advantage;
}

export type ParseResult =
  | { ok: true; formula: ParsedFormula }
  | { ok: false; error: DiceError };

export interface DieResult {
  /** Numero di facce del dado (6 per un d6, 100 per d%). */
  face: number;
  /** Valore uscito, da 1 a `face`. */
  value: number;
  /** Se il dado contribuisce al totale (keep, vantaggio/svantaggio). */
  kept: boolean;
}

export type RollTermResult =
  | {
      kind: "dice";
      sign: 1 | -1;
      count: number;
      sides: number;
      keep?: { mode: "highest" | "lowest"; count: number };
      dice: DieResult[];
      /** Somma dei dadi tenuti, con segno del termine. */
      signedValue: number;
    }
  | {
      kind: "constant";
      sign: 1 | -1;
      value: number;
      /** Valore del termine con segno. */
      signedValue: number;
    };

/** Risultato serializzabile di un tiro. */
export interface RollResult {
  /** Formula in forma canonica, es. `2d6+3` o `1d20 adv`. */
  formula: string;
  advantage: Advantage;
  terms: RollTermResult[];
  total: number;
  /** Testo leggibile, es. `2d6+3 → [4, 5] + 3 = 12`. */
  detail: string;
  /** Vero se la formula è un singolo d20 e il dado deciso vale 20. */
  critical: boolean;
  /** Vero se la formula è un singolo d20 e il dado deciso vale 1. */
  criticalFailure: boolean;
}
