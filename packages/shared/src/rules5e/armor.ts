/** Classe Armatura. I dati delle armature arrivano da contenuti iniettati. */

export type ArmorCategory = "light" | "medium" | "heavy";

export interface ArmorDef {
  category: ArmorCategory;
  /** CA base dell'armatura. */
  baseAc: number;
  /** Forza minima; se non soddisfatta, velocita -10 ft. */
  strengthRequirement?: number;
  stealthDisadvantage?: boolean;
}

export const SHIELD_BONUS = 2;
export const MEDIUM_ARMOR_MAX_DEX = 2;
export const UNARMORED_BASE_AC = 10;

export interface ArmorClassInput {
  dexMod: number;
  armor?: ArmorDef | undefined;
  shield?: boolean;
  /** Bonus generici (oggetti magici, privilegi): somma gia calcolata. */
  bonus?: number;
}

/** Leggera/senza armatura: tutta la Destrezza. Media: max +2. Pesante: nessuna. */
export function dexContributionToAc(category: ArmorCategory | undefined, dexMod: number): number {
  switch (category) {
    case undefined:
    case "light":
      return dexMod;
    case "medium":
      return Math.min(dexMod, MEDIUM_ARMOR_MAX_DEX);
    case "heavy":
      return 0;
  }
}

export function armorClass(input: ArmorClassInput): number {
  const { armor } = input;
  const base = armor ? armor.baseAc : UNARMORED_BASE_AC;
  return (
    base +
    dexContributionToAc(armor?.category, input.dexMod) +
    (input.shield ? SHIELD_BONUS : 0) +
    (input.bonus ?? 0)
  );
}

/** Penalita di velocita (ft) se la Forza non soddisfa il requisito. */
export function armorSpeedPenalty(armor: ArmorDef | undefined, strScore: number): number {
  if (armor?.strengthRequirement !== undefined && strScore < armor.strengthRequirement) return 10;
  return 0;
}
