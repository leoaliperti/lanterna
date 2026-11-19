/**
 * Composizione vantaggio/svantaggio e formula di tiro.
 * Non dipende dal motore dadi: restituisce solo la stringa e i flag.
 */

export type RollMode = "normal" | "advantage" | "disadvantage";

/**
 * Regola 2024: se c'e almeno una fonte di vantaggio e almeno una di svantaggio
 * si annullano (qualunque sia il numero), altrimenti vale quella presente.
 */
export function combineRollModes(sources: readonly RollMode[]): RollMode {
  const adv = sources.includes("advantage");
  const dis = sources.includes("disadvantage");
  if (adv && dis) return "normal";
  if (adv) return "advantage";
  if (dis) return "disadvantage";
  return "normal";
}

export interface RollSpec {
  /** Stringa tipo `1d20+5`. Con adv/dis resta un solo `1d20`: il motore dadi applica i flag. */
  formula: string;
  advantage: boolean;
  disadvantage: boolean;
  modifier: number;
  /** Vero se l'esito e un fallimento automatico (nessun tiro). */
  autoFail?: boolean;
}

export function formatModifier(modifier: number): string {
  if (modifier === 0) return "";
  return modifier > 0 ? `+${modifier}` : `${modifier}`;
}

export function d20Formula(modifier: number): string {
  return `1d20${formatModifier(modifier)}`;
}

export function makeRollSpec(modifier: number, mode: RollMode = "normal", autoFail = false): RollSpec {
  const spec: RollSpec = {
    formula: d20Formula(modifier),
    advantage: mode === "advantage",
    disadvantage: mode === "disadvantage",
    modifier,
  };
  if (autoFail) spec.autoFail = true;
  return spec;
}
