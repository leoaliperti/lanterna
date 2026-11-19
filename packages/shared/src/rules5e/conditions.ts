/** Condizioni 2024: solo identificatori ed effetti numerici/booleani. */
import type { Ability } from "./abilities.js";
import { combineRollModes, type RollMode } from "./rolls.js";

export const CONDITIONS = [
  "blinded",
  "charmed",
  "deafened",
  "exhaustion",
  "frightened",
  "grappled",
  "incapacitated",
  "invisible",
  "paralyzed",
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "unconscious",
] as const;
export type Condition = (typeof CONDITIONS)[number];
/** Condizioni senza Esaurimento (che e un livello numerico a parte). */
export type ActiveCondition = Exclude<Condition, "exhaustion">;

export const MAX_EXHAUSTION = 6;

export function clampExhaustion(level: number): number {
  return Math.max(0, Math.min(MAX_EXHAUSTION, Math.trunc(level)));
}

/** Esaurimento 2024: ogni livello riduce i d20 test di 2 (e la CD degli incantesimi). */
export function exhaustionD20Penalty(level: number): number {
  return 2 * clampExhaustion(level);
}

/** Esaurimento 2024: ogni livello riduce la velocita di 5 piedi. */
export function exhaustionSpeedPenalty(level: number): number {
  return 5 * clampExhaustion(level);
}

/** Al livello 6 la creatura muore. */
export function exhaustionIsLethal(level: number): boolean {
  return level >= MAX_EXHAUSTION;
}

const INCAPACITATING = new Set<ActiveCondition>([
  "incapacitated",
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious",
]);
const SPEED_ZERO = new Set<ActiveCondition>([
  "grappled",
  "paralyzed",
  "petrified",
  "restrained",
  "unconscious",
]);
const AUTO_FAIL_STR_DEX = new Set<ActiveCondition>([
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious",
]);
/** Danno vantaggio a chi attacca la creatura. */
const GRANTS_ADVANTAGE = new Set<ActiveCondition>([
  "blinded",
  "paralyzed",
  "petrified",
  "restrained",
  "stunned",
  "unconscious",
]);
/** Svantaggio ai propri attacchi. */
const ATTACK_DISADVANTAGE = new Set<ActiveCondition>([
  "blinded",
  "frightened",
  "poisoned",
  "prone",
  "restrained",
]);
/** Svantaggio alle prove di caratteristica. */
const CHECK_DISADVANTAGE = new Set<ActiveCondition>(["frightened", "poisoned"]);

export interface ConditionEffects {
  incapacitated: boolean;
  speedZero: boolean;
  /** Caratteristiche i cui tiri salvezza falliscono in automatico. */
  autoFailSaves: Ability[];
  ownAttackMode: RollMode;
  ownAbilityCheckMode: RollMode;
  /** Tiri salvezza su Destrezza (svantaggio se Trattenuto). */
  dexSaveMode: RollMode;
  attacksAgainstAdvantage: boolean;
  attacksAgainstDisadvantage: boolean;
  /** Prono/Privo di sensi: vantaggio entro 5 ft, svantaggio da piu lontano. */
  attacksAgainstProneRule: boolean;
  /** Colpi in mischia entro 5 ft sono critici. */
  meleeWithin5ftAutoCrit: boolean;
  resistAllDamage: boolean;
  /** Svantaggio ad attaccare chi non e l'afferrante. */
  grappledAttackDisadvantage: boolean;
}

export function conditionEffects(conditions: readonly ActiveCondition[]): ConditionEffects {
  const has = (c: ActiveCondition) => conditions.includes(c);
  const any = (set: ReadonlySet<ActiveCondition>) => conditions.some((c) => set.has(c));
  const ownAttack: RollMode[] = [];
  if (any(ATTACK_DISADVANTAGE)) ownAttack.push("disadvantage");
  if (has("invisible")) ownAttack.push("advantage");
  const check: RollMode[] = any(CHECK_DISADVANTAGE) ? ["disadvantage"] : [];
  return {
    incapacitated: any(INCAPACITATING),
    speedZero: any(SPEED_ZERO),
    autoFailSaves: any(AUTO_FAIL_STR_DEX) ? ["str", "dex"] : [],
    ownAttackMode: combineRollModes(ownAttack),
    ownAbilityCheckMode: combineRollModes(check),
    dexSaveMode: has("restrained") ? "disadvantage" : "normal",
    attacksAgainstAdvantage: any(GRANTS_ADVANTAGE),
    attacksAgainstDisadvantage: has("invisible"),
    attacksAgainstProneRule: has("prone") || has("unconscious"),
    meleeWithin5ftAutoCrit: has("paralyzed") || has("unconscious"),
    resistAllDamage: has("petrified"),
    grappledAttackDisadvantage: has("grappled"),
  };
}

/** Modo di un attacco contro la creatura, data la distanza. */
export function attackAgainstMode(
  effects: ConditionEffects,
  opts: { within5ft: boolean },
): RollMode {
  const modes: RollMode[] = [];
  if (effects.attacksAgainstAdvantage) modes.push("advantage");
  if (effects.attacksAgainstDisadvantage) modes.push("disadvantage");
  if (effects.attacksAgainstProneRule) modes.push(opts.within5ft ? "advantage" : "disadvantage");
  return combineRollModes(modes);
}
