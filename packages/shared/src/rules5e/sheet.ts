/**
 * Modello CharacterSheet serializzabile (Zod) e calcolo dei valori derivati.
 * I contenuti (classi, armature) sono iniettati tramite `RulesContent`, mai cablati.
 */
import { z } from "zod";
import {
  ABILITIES,
  SKILLS,
  SKILL_ABILITY,
  abilityModifier,
  attackBonus,
  passiveScore,
  proficiencyBonus,
  proficiencyContribution,
  spellSaveDC,
  type Ability,
  type Proficiency,
  type Skill,
} from "./abilities.js";
import { armorClass, armorSpeedPenalty, type ArmorDef } from "./armor.js";
import { carryingCapacity, type CarryingCapacity } from "./carrying.js";
import {
  CONDITIONS,
  conditionEffects,
  exhaustionD20Penalty,
  exhaustionSpeedPenalty,
  type ActiveCondition,
  type ConditionEffects,
} from "./conditions.js";
import { maxHitPoints } from "./hp.js";
import { combineRollModes, makeRollSpec, type RollMode, type RollSpec } from "./rolls.js";
import {
  combinedSpellSlots,
  pactSlotsFor,
  type CasterKind,
  type PactSlots,
} from "./spellSlots.js";

const abilityEnum = z.enum(ABILITIES);
const abilityScore = z.number().int().min(1).max(30);

export const classEntrySchema = z.object({
  /** Identificatore libero della classe (risolto, se presente, nei contenuti iniettati). */
  id: z.string().min(1),
  level: z.number().int().min(1).max(20),
  /** Se omessi, vengono dai contenuti iniettati per `id`. */
  hitDie: z.number().int().min(4).max(20).optional(),
  casterKind: z.enum(["full", "half", "third", "pact"]).optional(),
  spellcastingAbility: abilityEnum.optional(),
  hitDiceSpent: z.number().int().min(0).default(0),
});
export type ClassEntry = z.infer<typeof classEntrySchema>;

export const characterSheetSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().default(""),
    size: z.enum(["tiny", "small", "medium", "large", "huge", "gargantuan"]).default("medium"),
    abilities: z.object({
      str: abilityScore,
      dex: abilityScore,
      con: abilityScore,
      int: abilityScore,
      wis: abilityScore,
      cha: abilityScore,
    }),
    /** Classi in ordine di acquisizione. Il livello totale e la somma (dato inserito dal GM). */
    classes: z.array(classEntrySchema).min(1),
    baseSpeed: z.number().int().min(0).default(30),
    skills: z.partialRecord(z.enum(SKILLS), z.enum(["none", "half", "proficient", "expertise"])).default({}),
    saveProficiencies: z.array(abilityEnum).default([]),
    equipment: z
      .object({ armorId: z.string().optional(), shield: z.boolean().default(false) })
      .default({ shield: false }),
    acBonus: z.number().int().default(0),
    initiativeBonus: z.number().int().default(0),
    /** Tiri effettivi dei PF per livello (indice 0 = livello 1); mancanti = media fissa. */
    hpRolls: z.array(z.number().int().min(1).nullable()).default([]),
    hpBonusPerLevel: z.number().int().default(0),
    hp: z
      .object({
        /** Assente = PF al massimo. */
        current: z.number().int().min(0).optional(),
        temp: z.number().int().min(0).default(0),
        deathSaves: z
          .object({
            successes: z.number().int().min(0).max(3).default(0),
            failures: z.number().int().min(0).max(3).default(0),
          })
          .default({ successes: 0, failures: 0 }),
        stable: z.boolean().default(false),
        dead: z.boolean().default(false),
      })
      .default({ temp: 0, deathSaves: { successes: 0, failures: 0 }, stable: false, dead: false }),
    /** Slot spesi per livello di slot (indice 0 = 1 livello). */
    slotsSpent: z.array(z.number().int().min(0)).length(9).default([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    pactSlotsSpent: z.number().int().min(0).default(0),
    conditions: z.array(z.enum(CONDITIONS.filter((c) => c !== "exhaustion") as [ActiveCondition, ...ActiveCondition[]])).default([]),
    exhaustion: z.number().int().min(0).max(6).default(0),
    heroicInspiration: z.boolean().default(false),
    /** Peso trasportato in libbre (opzionale, per il confronto con la capacita). */
    carriedWeight: z.number().min(0).optional(),
  })
  .refine((s) => s.classes.reduce((n, c) => n + c.level, 0) <= 20, {
    message: "Il livello totale non puo superare 20",
    path: ["classes"],
  });

export type CharacterSheet = z.infer<typeof characterSheetSchema>;
export type CharacterSheetInput = z.input<typeof characterSheetSchema>;

export function parseCharacterSheet(data: unknown): CharacterSheet {
  return characterSheetSchema.parse(data);
}

/** Dati di classe iniettati (importati dall'utente): solo i campi meccanici usati dal motore. */
export interface ClassContent {
  hitDie: number;
  casterKind?: CasterKind;
  spellcastingAbility?: Ability;
}

export interface RulesContent {
  armors?: Record<string, ArmorDef>;
  classes?: Record<string, ClassContent>;
}

export interface DerivedSpellcasting {
  classId: string;
  kind: CasterKind;
  ability: Ability;
  /** CD (gia ridotta dall'Esaurimento). */
  saveDc: number;
  attack: RollSpec;
}

export interface DerivedSheet {
  level: number;
  proficiencyBonus: number;
  abilities: Record<Ability, { score: number; modifier: number; check: RollSpec; save: RollSpec & { proficient: boolean } }>;
  skills: Record<Skill, { ability: Ability; proficiency: Proficiency; bonus: number; roll: RollSpec }>;
  passivePerception: number;
  initiative: RollSpec;
  deathSave: RollSpec;
  armorClass: number;
  speed: number;
  hpMax: number;
  hitDice: Record<number, { total: number; spent: number; remaining: number }>;
  spellcasting: DerivedSpellcasting[];
  /** Slot totali condivisi (indice 0 = 1 livello). */
  spellSlots: number[];
  spellSlotsRemaining: number[];
  pact: (PactSlots & { remaining: number }) | null;
  carrying: CarryingCapacity & { overCapacity: boolean };
  exhaustion: number;
  conditionEffects: ConditionEffects;
  /** Svantaggio alla Furtivita per l'armatura indossata. */
  stealthDisadvantage: boolean;
}

export interface ResolvedClass {
  id: string;
  level: number;
  hitDie: number;
  casterKind?: CasterKind;
  spellcastingAbility?: Ability;
  hitDiceSpent: number;
}

export function resolveClasses(sheet: CharacterSheet, content?: RulesContent): ResolvedClass[] {
  return sheet.classes.map((c) => {
    const def = content?.classes?.[c.id];
    const hitDie = c.hitDie ?? def?.hitDie;
    if (hitDie === undefined) {
      throw new Error(`Dado vita sconosciuto per la classe "${c.id}": fornire hitDie o contenuti`);
    }
    const r: ResolvedClass = { id: c.id, level: c.level, hitDie, hitDiceSpent: c.hitDiceSpent };
    const kind = c.casterKind ?? def?.casterKind;
    const ability = c.spellcastingAbility ?? def?.spellcastingAbility;
    if (kind) r.casterKind = kind;
    if (ability) r.spellcastingAbility = ability;
    return r;
  });
}

export function characterLevel(sheet: CharacterSheet): number {
  return sheet.classes.reduce((n, c) => n + c.level, 0);
}

/** Un dado vita per ogni livello, in ordine di acquisizione. */
export function hitDiceByLevel(classes: readonly ResolvedClass[]): number[] {
  return classes.flatMap((c) => Array<number>(c.level).fill(c.hitDie));
}

export function derive(sheet: CharacterSheet, content?: RulesContent): DerivedSheet {
  const level = characterLevel(sheet);
  const prof = proficiencyBonus(level);
  const classes = resolveClasses(sheet, content);
  const armor = sheet.equipment.armorId ? content?.armors?.[sheet.equipment.armorId] : undefined;
  if (sheet.equipment.armorId && !armor) {
    throw new Error(`Armatura sconosciuta: "${sheet.equipment.armorId}"`);
  }
  const effects = conditionEffects(sheet.conditions);
  const penalty = exhaustionD20Penalty(sheet.exhaustion);
  const mods = Object.fromEntries(
    ABILITIES.map((a) => [a, abilityModifier(sheet.abilities[a])]),
  ) as Record<Ability, number>;

  const checkMode = (extra: RollMode = "normal") =>
    combineRollModes([effects.ownAbilityCheckMode, extra]);

  const abilities = {} as DerivedSheet["abilities"];
  for (const a of ABILITIES) {
    const proficient = sheet.saveProficiencies.includes(a);
    const saveBonus = mods[a] + (proficient ? prof : 0);
    const autoFail = effects.autoFailSaves.includes(a);
    const saveMode: RollMode = a === "dex" ? effects.dexSaveMode : "normal";
    abilities[a] = {
      score: sheet.abilities[a],
      modifier: mods[a],
      check: makeRollSpec(mods[a] - penalty, checkMode()),
      save: { ...makeRollSpec(saveBonus - penalty, saveMode, autoFail), proficient },
    };
  }

  const stealthDisadvantage = armor?.stealthDisadvantage ?? false;
  const skills = {} as DerivedSheet["skills"];
  for (const s of SKILLS) {
    const ability = SKILL_ABILITY[s];
    const proficiency: Proficiency = sheet.skills[s] ?? "none";
    const bonus = mods[ability] + proficiencyContribution(proficiency, prof);
    const extra: RollMode = s === "stealth" && stealthDisadvantage ? "disadvantage" : "normal";
    skills[s] = { ability, proficiency, bonus, roll: makeRollSpec(bonus - penalty, checkMode(extra)) };
  }

  const spellcasting: DerivedSpellcasting[] = [];
  for (const c of classes) {
    if (!c.casterKind || !c.spellcastingAbility) continue;
    const m = mods[c.spellcastingAbility];
    spellcasting.push({
      classId: c.id,
      kind: c.casterKind,
      ability: c.spellcastingAbility,
      saveDc: spellSaveDC(prof, m) - penalty,
      attack: makeRollSpec(attackBonus(prof, m) - penalty, effects.ownAttackMode),
    });
  }

  const casterClasses = classes.flatMap((c) =>
    c.casterKind ? [{ kind: c.casterKind, level: c.level }] : [],
  );
  const spellSlots = combinedSpellSlots(casterClasses);
  const pactLevel = classes
    .filter((c) => c.casterKind === "pact")
    .reduce((n, c) => n + c.level, 0);
  const pactBase = pactLevel > 0 ? pactSlotsFor(pactLevel) : null;

  const hitDice: DerivedSheet["hitDice"] = {};
  for (const c of classes) {
    const e = (hitDice[c.hitDie] ??= { total: 0, spent: 0, remaining: 0 });
    e.total += c.level;
    e.spent += Math.min(c.level, c.hitDiceSpent);
    e.remaining = e.total - e.spent;
  }

  const baseSpeed = Math.max(
    0,
    sheet.baseSpeed - armorSpeedPenalty(armor, sheet.abilities.str) - exhaustionSpeedPenalty(sheet.exhaustion),
  );
  const capacity = carryingCapacity(sheet.abilities.str, sheet.size);

  return {
    level,
    proficiencyBonus: prof,
    abilities,
    skills,
    passivePerception: passiveScore(skills.perception.bonus),
    initiative: makeRollSpec(mods.dex + sheet.initiativeBonus - penalty, checkMode()),
    deathSave: makeRollSpec(-penalty),
    armorClass: armorClass({ dexMod: mods.dex, armor, shield: sheet.equipment.shield, bonus: sheet.acBonus }),
    speed: effects.speedZero ? 0 : baseSpeed,
    hpMax: maxHitPoints(hitDiceByLevel(classes), mods.con, {
      rolls: sheet.hpRolls.map((r) => r ?? undefined),
      bonusPerLevel: sheet.hpBonusPerLevel,
    }),
    hitDice,
    spellcasting,
    spellSlots,
    spellSlotsRemaining: spellSlots.map((n, i) => Math.max(0, n - (sheet.slotsSpent[i] ?? 0))),
    pact: pactBase
      ? { ...pactBase, remaining: Math.max(0, pactBase.count - sheet.pactSlotsSpent) }
      : null,
    carrying: {
      ...capacity,
      overCapacity: sheet.carriedWeight !== undefined && sheet.carriedWeight > capacity.carry,
    },
    exhaustion: sheet.exhaustion,
    conditionEffects: effects,
    stealthDisadvantage,
  };
}

export type RollTarget =
  | { kind: "check"; ability: Ability }
  | { kind: "skill"; skill: Skill }
  | { kind: "save"; ability: Ability }
  | { kind: "initiative" }
  | { kind: "deathSave" }
  /** Attacco con arma o simili: modificatore della caratteristica scelta + competenza opzionale + bonus. */
  | { kind: "attack"; ability: Ability; proficient?: boolean; bonus?: number }
  | { kind: "spellAttack"; classId: string };

/**
 * Formula da tirare (`1d20+5`) e flag adv/dis per un tiro del personaggio.
 * `extraMode` permette al GM/chiamante di aggiungere un vantaggio o svantaggio esterno,
 * composto secondo la regola 2024.
 */
export function rollFor(
  sheet: CharacterSheet,
  content: RulesContent | undefined,
  target: RollTarget,
  extraMode: RollMode = "normal",
): RollSpec {
  const d = derive(sheet, content);
  const penalty = exhaustionD20Penalty(sheet.exhaustion);
  let base: RollSpec;
  switch (target.kind) {
    case "check":
      base = d.abilities[target.ability].check;
      break;
    case "skill":
      base = d.skills[target.skill].roll;
      break;
    case "save": {
      const { proficient: _p, ...spec } = d.abilities[target.ability].save;
      void _p;
      base = spec;
      break;
    }
    case "initiative":
      base = d.initiative;
      break;
    case "deathSave":
      base = d.deathSave;
      break;
    case "attack": {
      const bonus = attackBonus(
        d.proficiencyBonus,
        d.abilities[target.ability].modifier,
        target.proficient ?? true,
        target.bonus ?? 0,
      );
      base = makeRollSpec(bonus - penalty, d.conditionEffects.ownAttackMode);
      break;
    }
    case "spellAttack": {
      const sc = d.spellcasting.find((s) => s.classId === target.classId);
      if (!sc) throw new Error(`La classe "${target.classId}" non lancia incantesimi`);
      base = sc.attack;
      break;
    }
  }
  const mode = combineRollModes([
    base.advantage ? "advantage" : base.disadvantage ? "disadvantage" : "normal",
    extraMode,
  ]);
  return makeRollSpec(base.modifier, mode, base.autoFail ?? false);
}
