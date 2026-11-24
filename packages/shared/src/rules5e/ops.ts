/** Operazioni sulla scheda: PF, riposi, slot, condizioni, ispirazione eroica. Restituiscono una nuova scheda. */
import { abilityModifier } from "./abilities.js";
import { clampExhaustion, exhaustionIsLethal, type ActiveCondition } from "./conditions.js";
import {
  applyDamage,
  deathSave,
  grantTempHp,
  decideInstantDeath,
  heal,
  resetDeath,
  stabilize,
  type DamageOptions,
  type HpState,
} from "./hp.js";
import {
  derive,
  resolveClasses,
  type CharacterSheet,
  type RulesContent,
} from "./sheet.js";

/** Stato PF completo (con massimo derivato) dalla scheda. */
export function hpStateOf(sheet: CharacterSheet, content?: RulesContent): HpState {
  const max = derive(sheet, content).hpMax;
  return {
    current: Math.min(max, sheet.hp.current ?? max),
    max,
    temp: sheet.hp.temp,
    deathSaves: { ...sheet.hp.deathSaves },
    stable: sheet.hp.stable,
    dead: sheet.hp.dead || exhaustionIsLethal(sheet.exhaustion),
    instantDeathPending: sheet.hp.instantDeathPending,
  };
}

function withHp(sheet: CharacterSheet, hp: HpState): CharacterSheet {
  return {
    ...sheet,
    hp: {
      current: hp.current,
      temp: hp.temp,
      deathSaves: { ...hp.deathSaves },
      stable: hp.stable,
      dead: hp.dead,
      instantDeathPending: hp.instantDeathPending === true,
    },
  };
}

export function damageSheet(
  sheet: CharacterSheet,
  content: RulesContent | undefined,
  amount: number,
  opts?: DamageOptions,
): CharacterSheet {
  return withHp(sheet, applyDamage(hpStateOf(sheet, content), amount, opts));
}

export function healSheet(sheet: CharacterSheet, content: RulesContent | undefined, amount: number) {
  return withHp(sheet, heal(hpStateOf(sheet, content), amount));
}

export function grantTempHpSheet(
  sheet: CharacterSheet,
  content: RulesContent | undefined,
  amount: number,
) {
  return withHp(sheet, grantTempHp(hpStateOf(sheet, content), amount));
}

/** Decisione del GM sulla morte istantanea (vedi `decideInstantDeath`). */
export function decideInstantDeathSheet(sheet: CharacterSheet, content: RulesContent | undefined, dead: boolean) {
  return withHp(sheet, decideInstantDeath(hpStateOf(sheet, content), dead));
}

/** Azzera lo stato di morte (vedi `resetDeath`). */
export function resetDeathSheet(sheet: CharacterSheet, content?: RulesContent) {
  return withHp(sheet, resetDeath(hpStateOf(sheet, content)));
}

export function stabilizeSheet(sheet: CharacterSheet, content?: RulesContent) {
  return withHp(sheet, stabilize(hpStateOf(sheet, content)));
}

/** Registra un tiro salvezza contro la morte (risultato naturale del d20, totale opzionale). */
export function deathSaveSheet(
  sheet: CharacterSheet,
  content: RulesContent | undefined,
  naturalRoll: number,
  total?: number,
) {
  return withHp(sheet, deathSave(hpStateOf(sheet, content), naturalRoll, total));
}

/** Spende uno slot di un dato livello (1-9). Errore se non ce ne sono. */
export function spendSpellSlot(
  sheet: CharacterSheet,
  content: RulesContent | undefined,
  slotLevel: number,
): CharacterSheet {
  const d = derive(sheet, content);
  if (!Number.isInteger(slotLevel) || slotLevel < 1 || slotLevel > 9) {
    throw new RangeError(`Livello di slot non valido: ${slotLevel}`);
  }
  if ((d.spellSlotsRemaining[slotLevel - 1] ?? 0) <= 0) {
    throw new Error(`Nessuno slot di livello ${slotLevel} disponibile`);
  }
  const slotsSpent = [...sheet.slotsSpent];
  slotsSpent[slotLevel - 1] = (slotsSpent[slotLevel - 1] ?? 0) + 1;
  return { ...sheet, slotsSpent };
}

export function spendPactSlot(sheet: CharacterSheet, content?: RulesContent): CharacterSheet {
  const d = derive(sheet, content);
  if (!d.pact || d.pact.remaining <= 0) throw new Error("Nessuno slot del patto disponibile");
  return { ...sheet, pactSlotsSpent: sheet.pactSlotsSpent + 1 };
}

/**
 * Spende un dado vita di taglia `die` e cura `max(0, tiro + mod. Costituzione)`.
 * Il tiro del dado e fornito dal chiamante (il server tira con l'entropia di sistema).
 */
export function spendHitDie(
  sheet: CharacterSheet,
  content: RulesContent | undefined,
  die: number,
  rolled: number,
): CharacterSheet {
  if (rolled < 1 || rolled > die) throw new RangeError(`Tiro ${rolled} non valido per d${die}`);
  const classes = resolveClasses(sheet, content);
  const idx = classes.findIndex((c) => c.hitDie === die && c.hitDiceSpent < c.level);
  if (idx < 0) throw new Error(`Nessun dado vita d${die} disponibile`);
  const spent: CharacterSheet = {
    ...sheet,
    classes: sheet.classes.map((c, i) => (i === idx ? { ...c, hitDiceSpent: c.hitDiceSpent + 1 } : c)),
  };
  const conMod = abilityModifier(sheet.abilities.con);
  return healSheet(spent, content, Math.max(0, rolled + conMod));
}

/** Riposo breve: gli slot del patto tornano disponibili (i dadi vita si spendono con `spendHitDie`). */
export function shortRest(sheet: CharacterSheet): CharacterSheet {
  if (sheet.hp.dead) return sheet;
  return { ...sheet, pactSlotsSpent: 0 };
}

/**
 * Riposo lungo: PF al massimo, recupero di meta dei dadi vita totali (minimo 1, partendo dai
 * dadi piu grandi), tutti gli slot, -1 Esaurimento, azzeramento dei tiri contro la morte.
 * Serve almeno 1 PF: a 0 PF o da morti la scheda resta invariata.
 */
export function longRest(sheet: CharacterSheet, content?: RulesContent): CharacterSheet {
  const hp = hpStateOf(sheet, content);
  if (hp.dead || hp.current === 0) return sheet;
  const classes = resolveClasses(sheet, content);
  const total = classes.reduce((n, c) => n + c.level, 0);
  let toRecover = Math.max(1, Math.floor(total / 2));
  const recovered = new Map<number, number>();
  const order = classes.map((c, i) => ({ c, i })).sort((a, b) => b.c.hitDie - a.c.hitDie);
  for (const { c, i } of order) {
    const back = Math.min(toRecover, Math.min(c.level, c.hitDiceSpent));
    recovered.set(i, back);
    toRecover -= back;
  }
  return {
    ...sheet,
    classes: sheet.classes.map((c, i) => ({ ...c, hitDiceSpent: c.hitDiceSpent - (recovered.get(i) ?? 0) })),
    hp: {
      current: hp.max,
      temp: sheet.hp.temp,
      deathSaves: { successes: 0, failures: 0 },
      stable: false,
      dead: false,
      instantDeathPending: false,
    },
    slotsSpent: Array<number>(9).fill(0),
    pactSlotsSpent: 0,
    exhaustion: clampExhaustion(sheet.exhaustion - 1),
  };
}

export function addCondition(sheet: CharacterSheet, condition: ActiveCondition): CharacterSheet {
  return sheet.conditions.includes(condition)
    ? sheet
    : { ...sheet, conditions: [...sheet.conditions, condition] };
}

export function removeCondition(sheet: CharacterSheet, condition: ActiveCondition): CharacterSheet {
  return { ...sheet, conditions: sheet.conditions.filter((c) => c !== condition) };
}

export function setExhaustion(sheet: CharacterSheet, level: number): CharacterSheet {
  return { ...sheet, exhaustion: clampExhaustion(level) };
}

/** Ispirazione eroica: se ne ha al massimo una; concederla a chi l'ha gia non cambia nulla. */
export function grantHeroicInspiration(sheet: CharacterSheet): CharacterSheet {
  return { ...sheet, heroicInspiration: true };
}

/** Spende l'ispirazione eroica (per ritirare un dado). `spent` e falso se non c'era. */
export function spendHeroicInspiration(sheet: CharacterSheet): {
  sheet: CharacterSheet;
  spent: boolean;
} {
  if (!sheet.heroicInspiration) return { sheet, spent: false };
  return { sheet: { ...sheet, heroicInspiration: false }, spent: true };
}
