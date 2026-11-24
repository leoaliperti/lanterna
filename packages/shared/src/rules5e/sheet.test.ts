import { describe, expect, it } from "vitest";
import {
  addCondition,
  characterSheetSchema,
  damageSheet,
  deathSaveSheet,
  derive,
  grantHeroicInspiration,
  healSheet,
  hpStateOf,
  longRest,
  parseCharacterSheet,
  rollFor,
  setExhaustion,
  shortRest,
  spendHeroicInspiration,
  spendHitDie,
  spendPactSlot,
  spendSpellSlot,
  stabilizeSheet,
  type CharacterSheetInput,
  type RulesContent,
} from "./index.js";

// Contenuti di prova generici (identificatori inventati, nessun contenuto protetto).
const content: RulesContent = {
  armors: {
    "test-heavy": { category: "heavy", baseAc: 16, strengthRequirement: 13, stealthDisadvantage: true },
    "test-medium": { category: "medium", baseAc: 14 },
  },
  classes: {
    "test-martial": { hitDie: 10 },
    "test-arcane": { hitDie: 6, casterKind: "full", spellcastingAbility: "int" },
    "test-pact": { hitDie: 8, casterKind: "pact", spellcastingAbility: "cha" },
  },
};

const martial: CharacterSheetInput = {
  name: "Prova",
  abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
  classes: [{ id: "test-martial", level: 5 }],
  saveProficiencies: ["str", "con"],
  skills: { athletics: "proficient", perception: "expertise" },
  equipment: { armorId: "test-heavy", shield: true },
};

const wizard: CharacterSheetInput = {
  abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 10 },
  classes: [{ id: "test-arcane", level: 3 }],
};

describe("schema", () => {
  it("applica i default e fa roundtrip JSON", () => {
    const s = parseCharacterSheet(martial);
    expect(s.baseSpeed).toBe(30);
    expect(s.conditions).toEqual([]);
    expect(s.slotsSpent).toHaveLength(9);
    expect(parseCharacterSheet(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
  it("rifiuta dati non validi", () => {
    expect(characterSheetSchema.safeParse({ ...martial, abilities: { ...(martial.abilities as object), str: 31 } }).success).toBe(false);
    expect(characterSheetSchema.safeParse({ ...martial, classes: [] }).success).toBe(false);
    expect(
      characterSheetSchema.safeParse({
        ...martial,
        classes: [{ id: "a", level: 15 }, { id: "b", level: 6 }],
      }).success,
    ).toBe(false);
    expect(characterSheetSchema.safeParse({ ...martial, exhaustion: 7 }).success).toBe(false);
  });
});

describe("derive: combattente di livello 5", () => {
  const d = derive(parseCharacterSheet(martial), content);
  it("valori di base", () => {
    expect(d.level).toBe(5);
    expect(d.proficiencyBonus).toBe(3);
    expect(d.abilities.str.modifier).toBe(3);
    expect(d.hpMax).toBe(12 + 4 * 8);
    expect(d.armorClass).toBe(18);
    expect(d.speed).toBe(30);
    expect(d.initiative.formula).toBe("1d20+2");
  });
  it("abilita e salvezze", () => {
    expect(d.skills.athletics.bonus).toBe(6);
    // Competenza in Percezione: solo il bonus di competenza (niente maestria nelle regole del tavolo).
    expect(d.skills.perception.bonus).toBe(4);
    expect(d.passivePerception).toBe(14);
    expect(d.skills.acrobatics.bonus).toBe(2);
    expect(d.abilities.str.save.formula).toBe("1d20+6");
    expect(d.abilities.dex.save.formula).toBe("1d20+2");
  });
  it("svantaggio alla Furtivita dall'armatura", () => {
    expect(d.skills.stealth.roll.disadvantage).toBe(true);
    expect(d.skills.athletics.roll.disadvantage).toBe(false);
  });
  it("dadi vita e carico", () => {
    expect(d.hitDice[10]).toEqual({ total: 5, spent: 0, remaining: 5 });
    expect(d.carrying.carry).toBe(240);
    expect(d.spellcasting).toEqual([]);
    expect(d.pact).toBeNull();
  });
  it("armatura pesante senza Forza sufficiente: -10 ft", () => {
    const weak = parseCharacterSheet({ ...martial, abilities: { ...(martial.abilities as object), str: 12 } });
    expect(derive(weak, content).speed).toBe(20);
  });
  it("armatura sconosciuta o classe senza dado vita: errore", () => {
    expect(() => derive(parseCharacterSheet({ ...martial, equipment: { armorId: "x" } }), content)).toThrow();
    expect(() => derive(parseCharacterSheet(martial), undefined)).toThrow();
  });
});

describe("derive: incantatore", () => {
  const s = parseCharacterSheet(wizard);
  const d = derive(s, content);
  it("CD, attacco e slot", () => {
    expect(d.spellcasting[0]?.saveDc).toBe(13);
    expect(d.spellcasting[0]?.attack.formula).toBe("1d20+5");
    expect(d.spellSlots).toEqual([4, 2, 0, 0, 0, 0, 0, 0, 0]);
    expect(d.hpMax).toBe(6 + 1 + 2 * (4 + 1));
  });
  it("spesa degli slot", () => {
    const s2 = spendSpellSlot(spendSpellSlot(s, content, 2), content, 1);
    expect(derive(s2, content).spellSlotsRemaining).toEqual([3, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => spendSpellSlot(spendSpellSlot(s2, content, 2), content, 2)).toThrow();
    expect(() => spendSpellSlot(s, content, 3)).toThrow();
  });
  it("patto e slot del patto, ripristinati dal riposo breve", () => {
    const p = parseCharacterSheet({
      abilities: { str: 8, dex: 10, con: 10, int: 10, wis: 10, cha: 16 },
      classes: [{ id: "test-pact", level: 5 }],
    });
    expect(derive(p, content).pact).toEqual({ count: 2, slotLevel: 3, remaining: 2 });
    const used = spendPactSlot(p, content);
    expect(derive(used, content).pact?.remaining).toBe(1);
    expect(derive(shortRest(used), content).pact?.remaining).toBe(2);
  });
  it("multiclasse: slot condivisi", () => {
    const m = parseCharacterSheet({
      ...wizard,
      classes: [
        { id: "test-arcane", level: 5 },
        { id: "h", level: 4, hitDie: 10, casterKind: "half", spellcastingAbility: "cha" },
      ],
    });
    expect(derive(m, content).spellSlots).toEqual([4, 3, 3, 1, 0, 0, 0, 0, 0]);
    expect(derive(m, content).hitDice[6]?.total).toBe(5);
  });
});

describe("rollFor", () => {
  const s = parseCharacterSheet(martial);
  it("abilita, salvezza, iniziativa, attacco", () => {
    expect(rollFor(s, content, { kind: "skill", skill: "athletics" })).toMatchObject({
      formula: "1d20+6", advantage: false, disadvantage: false,
    });
    expect(rollFor(s, content, { kind: "save", ability: "con" }).formula).toBe("1d20+5");
    expect(rollFor(s, content, { kind: "initiative" }).formula).toBe("1d20+2");
    expect(rollFor(s, content, { kind: "attack", ability: "str" }).formula).toBe("1d20+6");
    expect(rollFor(s, content, { kind: "attack", ability: "dex", proficient: false, bonus: 1 }).formula).toBe("1d20+3");
    expect(rollFor(s, content, { kind: "deathSave" }).formula).toBe("1d20");
  });
  it("vantaggio esterno composto con lo svantaggio di una condizione", () => {
    const poisoned = addCondition(s, "poisoned");
    const r = rollFor(poisoned, content, { kind: "skill", skill: "athletics" });
    expect(r.disadvantage).toBe(true);
    const cancelled = rollFor(poisoned, content, { kind: "skill", skill: "athletics" }, "advantage");
    expect(cancelled.advantage || cancelled.disadvantage).toBe(false);
    expect(rollFor(poisoned, content, { kind: "attack", ability: "str" }).disadvantage).toBe(true);
  });
  it("Esaurimento riduce i d20 test di 2 per livello, velocita di 5", () => {
    const e = setExhaustion(s, 2);
    expect(rollFor(e, content, { kind: "skill", skill: "athletics" }).formula).toBe("1d20+2");
    expect(rollFor(e, content, { kind: "save", ability: "str" }).formula).toBe("1d20+2");
    expect(rollFor(e, content, { kind: "attack", ability: "str" }).formula).toBe("1d20+2");
    expect(rollFor(e, content, { kind: "deathSave" }).formula).toBe("1d20-4");
    expect(derive(e, content).speed).toBe(20);
    expect(derive(e, content).passivePerception).toBe(14);
    const w = setExhaustion(parseCharacterSheet(wizard), 1);
    expect(derive(w, content).spellcasting[0]?.saveDc).toBe(11);
  });
  it("salvezza For/Des automaticamente fallita se Paralizzato", () => {
    const p = addCondition(s, "paralyzed");
    expect(rollFor(p, content, { kind: "save", ability: "str" }).autoFail).toBe(true);
    expect(rollFor(p, content, { kind: "save", ability: "wis" }).autoFail).toBeUndefined();
    expect(derive(p, content).speed).toBe(0);
  });
  it("attacco con incantesimo", () => {
    const w = parseCharacterSheet(wizard);
    expect(rollFor(w, content, { kind: "spellAttack", classId: "test-arcane" }).formula).toBe("1d20+5");
    expect(() => rollFor(s, content, { kind: "spellAttack", classId: "test-martial" })).toThrow();
  });
});

describe("PF, riposi e ispirazione sulla scheda", () => {
  const s = parseCharacterSheet(martial); // 44 PF
  it("danno, cura, morte e stabilizzazione", () => {
    const hit = damageSheet(s, content, 20);
    expect(hit.hp.current).toBe(24);
    expect(healSheet(hit, content, 100).hp.current).toBe(44);
    const down = damageSheet(s, content, 44);
    expect(down.hp.current).toBe(0);
    expect(stabilizeSheet(down, content).hp.stable).toBe(true);
    const dying = deathSaveSheet(deathSaveSheet(down, content, 3), content, 1);
    expect(dying.hp.dead).toBe(true);
  });
  it("spesa dadi vita e riposo breve", () => {
    const hit = damageSheet(s, content, 30);
    const rested = spendHitDie(hit, content, 10, 7);
    expect(rested.hp.current).toBe(14 + 9);
    expect(rested.classes[0]?.hitDiceSpent).toBe(1);
    expect(() => spendHitDie(rested, content, 8, 4)).toThrow();
  });
  it("riposo lungo: PF, slot, meta dadi vita, -1 Esaurimento", () => {
    let t = damageSheet(setExhaustion(s, 2), content, 30);
    for (let i = 0; i < 5; i++) t = spendHitDie(t, content, 10, 1);
    expect(t.classes[0]?.hitDiceSpent).toBe(5);
    const r = longRest(t, content);
    expect(r.hp.current).toBe(44);
    expect(r.classes[0]?.hitDiceSpent).toBe(3);
    expect(r.exhaustion).toBe(1);
    const w = parseCharacterSheet(wizard);
    const used = spendSpellSlot(w, content, 1);
    expect(longRest(used, content).slotsSpent).toEqual(Array(9).fill(0));
  });
  it("riposo lungo: minimo 1 dado vita e nulla a 0 PF", () => {
    const one = parseCharacterSheet({ ...martial, classes: [{ id: "test-martial", level: 1, hitDiceSpent: 1 }] });
    expect(longRest(one, content).classes[0]?.hitDiceSpent).toBe(0);
    const down = damageSheet(s, content, 44);
    expect(longRest(down, content)).toBe(down);
  });
  it("Esaurimento 6 equivale a morte", () => {
    const dead = setExhaustion(s, 6);
    expect(hpStateOf(dead, content).dead).toBe(true);
    expect(healSheet(damageSheet(dead, content, 5), content, 10).hp.dead).toBe(true);
  });
  it("ispirazione eroica", () => {
    const g = grantHeroicInspiration(s);
    expect(g.heroicInspiration).toBe(true);
    expect(grantHeroicInspiration(g).heroicInspiration).toBe(true);
    const r = spendHeroicInspiration(g);
    expect(r.spent).toBe(true);
    expect(r.sheet.heroicInspiration).toBe(false);
    expect(spendHeroicInspiration(r.sheet).spent).toBe(false);
  });
});
