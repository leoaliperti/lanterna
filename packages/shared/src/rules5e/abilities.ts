/** Caratteristiche, modificatori, bonus di competenza e abilita (solo meccaniche). */

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export type Ability = (typeof ABILITIES)[number];
export type AbilityScores = Record<Ability, number>;

export const SKILLS = [
  "acrobatics",
  "animalHandling",
  "arcana",
  "athletics",
  "deception",
  "history",
  "insight",
  "intimidation",
  "investigation",
  "medicine",
  "nature",
  "perception",
  "performance",
  "persuasion",
  "religion",
  "sleightOfHand",
  "stealth",
  "survival",
] as const;
export type Skill = (typeof SKILLS)[number];

export const SKILL_ABILITY: Record<Skill, Ability> = {
  acrobatics: "dex",
  animalHandling: "wis",
  arcana: "int",
  athletics: "str",
  deception: "cha",
  history: "int",
  insight: "wis",
  intimidation: "cha",
  investigation: "int",
  medicine: "wis",
  nature: "int",
  perception: "wis",
  performance: "cha",
  persuasion: "cha",
  religion: "int",
  sleightOfHand: "dex",
  stealth: "dex",
  survival: "wis",
};

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 20;

/** Modificatore: floor((punteggio - 10) / 2). */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Bonus di competenza: 2 + floor((livello - 1) / 4), livelli 1-20. */
export function proficiencyBonus(level: number): number {
  if (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    throw new RangeError(`Livello fuori intervallo: ${level}`);
  }
  return 2 + Math.floor((level - 1) / 4);
}

export type Proficiency = "none" | "half" | "proficient" | "expertise";

/** Parte del bonus di competenza applicata: nessuna, meta (per difetto), piena, doppia (maestria). */
export function proficiencyContribution(level: Proficiency, bonus: number): number {
  switch (level) {
    case "none":
      return 0;
    case "half":
      return Math.floor(bonus / 2);
    case "proficient":
      return bonus;
    case "expertise":
      return bonus * 2;
  }
}

export function skillBonus(
  mod: number,
  proficiency: Proficiency,
  profBonus: number,
  extra = 0,
): number {
  return mod + proficiencyContribution(proficiency, profBonus) + extra;
}

export function saveBonus(mod: number, proficient: boolean, profBonus: number, extra = 0): number {
  return mod + (proficient ? profBonus : 0) + extra;
}

/** Punteggio passivo: 10 + bonus; +5 con vantaggio, -5 con svantaggio. */
export function passiveScore(
  bonus: number,
  mode: "normal" | "advantage" | "disadvantage" = "normal",
): number {
  return 10 + bonus + (mode === "advantage" ? 5 : mode === "disadvantage" ? -5 : 0);
}

export function initiativeBonus(dexMod: number, extra = 0): number {
  return dexMod + extra;
}

/** CD incantesimi: 8 + competenza + modificatore. */
export function spellSaveDC(profBonus: number, mod: number, extra = 0): number {
  return 8 + profBonus + mod + extra;
}

/** Bonus di attacco: competenza (se presente) + modificatore. */
export function attackBonus(profBonus: number, mod: number, proficient = true, extra = 0): number {
  return mod + (proficient ? profBonus : 0) + extra;
}
