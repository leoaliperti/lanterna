import { describe, expect, it } from "vitest";
import {
  SKILLS,
  SKILL_ABILITY,
  abilityModifier,
  armorClass,
  attackBonus,
  carryingCapacity,
  combinedSpellSlots,
  combineRollModes,
  d20Formula,
  multiclassCasterLevel,
  pactSlotsFor,
  passiveScore,
  proficiencyBonus,
  proficiencyContribution,
  spellSaveDC,
  spellSlotsFor,
} from "./index.js";

describe("modificatori", () => {
  it.each([
    [1, -5], [2, -4], [3, -4], [8, -1], [9, -1], [10, 0], [11, 0], [12, 1],
    [15, 2], [16, 3], [18, 4], [20, 5], [30, 10],
  ])("punteggio %i -> %i", (score, mod) => {
    expect(abilityModifier(score)).toBe(mod);
  });
});

describe("bonus di competenza", () => {
  it("livelli 1-20", () => {
    const expected = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6];
    expected.forEach((b, i) => expect(proficiencyBonus(i + 1)).toBe(b));
  });
  it("rifiuta livelli fuori intervallo", () => {
    expect(() => proficiencyBonus(0)).toThrow(RangeError);
    expect(() => proficiencyBonus(21)).toThrow(RangeError);
    expect(() => proficiencyBonus(2.5)).toThrow(RangeError);
  });
  it("competenza, mezza competenza e maestria", () => {
    expect(proficiencyContribution("none", 3)).toBe(0);
    expect(proficiencyContribution("half", 3)).toBe(1);
    expect(proficiencyContribution("proficient", 3)).toBe(3);
    expect(proficiencyContribution("expertise", 3)).toBe(6);
  });
});

describe("abilita", () => {
  it("sono 18 con caratteristica associata", () => {
    expect(SKILLS).toHaveLength(18);
    expect(SKILL_ABILITY.athletics).toBe("str");
    expect(SKILL_ABILITY.stealth).toBe("dex");
    expect(SKILL_ABILITY.perception).toBe("wis");
    expect(SKILL_ABILITY.arcana).toBe("int");
    expect(SKILL_ABILITY.persuasion).toBe("cha");
    const counts: Record<string, number> = {};
    for (const s of SKILLS) counts[SKILL_ABILITY[s]] = (counts[SKILL_ABILITY[s]] ?? 0) + 1;
    expect(counts).toEqual({ str: 1, dex: 3, int: 5, wis: 5, cha: 4 });
  });
});

describe("percezione passiva, CD e attacco", () => {
  it("passiva", () => {
    expect(passiveScore(3)).toBe(13);
    expect(passiveScore(3, "advantage")).toBe(18);
    expect(passiveScore(3, "disadvantage")).toBe(8);
  });
  it("CD 8 + comp + mod; attacco comp + mod", () => {
    expect(spellSaveDC(proficiencyBonus(1), 3)).toBe(13);
    expect(spellSaveDC(proficiencyBonus(5), 4)).toBe(15);
    expect(spellSaveDC(proficiencyBonus(17), 5)).toBe(19);
    expect(attackBonus(proficiencyBonus(5), 4)).toBe(7);
    expect(attackBonus(2, 3, false)).toBe(3);
  });
});

describe("CA", () => {
  it("senza armatura 10 + Des", () => {
    expect(armorClass({ dexMod: 2 })).toBe(12);
    expect(armorClass({ dexMod: -1, shield: true })).toBe(11);
  });
  it("leggera: base + Des intera", () => {
    expect(armorClass({ dexMod: 4, armor: { category: "light", baseAc: 11 } })).toBe(15);
  });
  it("media: Des massimo +2", () => {
    expect(armorClass({ dexMod: 4, armor: { category: "medium", baseAc: 14 } })).toBe(16);
    expect(armorClass({ dexMod: 1, armor: { category: "medium", baseAc: 14 } })).toBe(15);
    expect(armorClass({ dexMod: -1, armor: { category: "medium", baseAc: 14 } })).toBe(13);
  });
  it("pesante: nessuna Des, anche negativa; scudo +2", () => {
    expect(armorClass({ dexMod: 3, armor: { category: "heavy", baseAc: 18 } })).toBe(18);
    expect(armorClass({ dexMod: -2, armor: { category: "heavy", baseAc: 16 }, shield: true })).toBe(18);
  });
});

describe("slot incantesimo", () => {
  it("completi: livelli notevoli", () => {
    expect(spellSlotsFor("full", 1)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("full", 2)).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("full", 3)).toEqual([4, 2, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("full", 5)).toEqual([4, 3, 2, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("full", 9)).toEqual([4, 3, 3, 3, 1, 0, 0, 0, 0]);
    expect(spellSlotsFor("full", 11)).toEqual([4, 3, 3, 3, 2, 1, 0, 0, 0]);
    expect(spellSlotsFor("full", 17)).toEqual([4, 3, 3, 3, 2, 1, 1, 1, 1]);
    expect(spellSlotsFor("full", 18)).toEqual([4, 3, 3, 3, 3, 1, 1, 1, 1]);
    expect(spellSlotsFor("full", 20)).toEqual([4, 3, 3, 3, 3, 2, 2, 1, 1]);
  });
  it("completi: totale slot cresce o resta uguale e ogni riga ha 9 voci", () => {
    let prev = 0;
    for (let l = 1; l <= 20; l++) {
      const row = spellSlotsFor("full", l);
      expect(row).toHaveLength(9);
      const sum = row.reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThanOrEqual(prev);
      prev = sum;
    }
  });
  it("mezzi", () => {
    expect(spellSlotsFor("half", 1)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("half", 2)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("half", 5)).toEqual([4, 2, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("half", 9)).toEqual([4, 3, 2, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("half", 13)).toEqual([4, 3, 3, 1, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("half", 17)).toEqual([4, 3, 3, 3, 1, 0, 0, 0, 0]);
    expect(spellSlotsFor("half", 20)).toEqual([4, 3, 3, 3, 2, 0, 0, 0, 0]);
  });
  it("terzi", () => {
    expect(spellSlotsFor("third", 2)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("third", 3)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("third", 4)).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("third", 7)).toEqual([4, 2, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("third", 13)).toEqual([4, 3, 2, 0, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("third", 19)).toEqual([4, 3, 3, 1, 0, 0, 0, 0, 0]);
    expect(spellSlotsFor("third", 20)).toEqual([4, 3, 3, 1, 0, 0, 0, 0, 0]);
  });
  it("patto", () => {
    expect(pactSlotsFor(1)).toEqual({ count: 1, slotLevel: 1 });
    expect(pactSlotsFor(2)).toEqual({ count: 2, slotLevel: 1 });
    expect(pactSlotsFor(3)).toEqual({ count: 2, slotLevel: 2 });
    expect(pactSlotsFor(5)).toEqual({ count: 2, slotLevel: 3 });
    expect(pactSlotsFor(9)).toEqual({ count: 2, slotLevel: 5 });
    expect(pactSlotsFor(11)).toEqual({ count: 3, slotLevel: 5 });
    expect(pactSlotsFor(17)).toEqual({ count: 4, slotLevel: 5 });
    expect(pactSlotsFor(20)).toEqual({ count: 4, slotLevel: 5 });
  });
  it("multiclasse", () => {
    expect(multiclassCasterLevel([{ kind: "full", level: 5 }, { kind: "half", level: 4 }])).toBe(7);
    expect(multiclassCasterLevel([{ kind: "half", level: 3 }])).toBe(2);
    expect(multiclassCasterLevel([{ kind: "third", level: 5 }, { kind: "pact", level: 5 }])).toBe(1);
    expect(
      combinedSpellSlots([{ kind: "full", level: 5 }, { kind: "half", level: 4 }]),
    ).toEqual([4, 3, 3, 1, 0, 0, 0, 0, 0]);
    expect(combinedSpellSlots([{ kind: "pact", level: 5 }])).toEqual(Array(9).fill(0));
  });
});

describe("capacita di carico", () => {
  it("Forza x 15 e x 30, per taglia", () => {
    expect(carryingCapacity(10)).toEqual({ carry: 150, pushDragLift: 300 });
    expect(carryingCapacity(18)).toEqual({ carry: 270, pushDragLift: 540 });
    expect(carryingCapacity(10, "tiny").carry).toBe(75);
    expect(carryingCapacity(10, "large").carry).toBe(300);
    expect(carryingCapacity(10, "gargantuan").carry).toBe(1200);
  });
});

describe("vantaggio/svantaggio e formule", () => {
  it("composizione", () => {
    expect(combineRollModes([])).toBe("normal");
    expect(combineRollModes(["advantage", "advantage"])).toBe("advantage");
    expect(combineRollModes(["disadvantage"])).toBe("disadvantage");
    expect(combineRollModes(["advantage", "disadvantage"])).toBe("normal");
    expect(combineRollModes(["advantage", "advantage", "disadvantage"])).toBe("normal");
  });
  it("formule", () => {
    expect(d20Formula(5)).toBe("1d20+5");
    expect(d20Formula(-1)).toBe("1d20-1");
    expect(d20Formula(0)).toBe("1d20");
  });
});
