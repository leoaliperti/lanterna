import { describe, expect, it } from "vitest";
import { decideInstantDeathSheet, damageSheet, parseCharacterSheet, resetDeathSheet, skillProficiency } from "./index.js";

const base = {
  name: "Prova",
  classes: [{ id: "guerriero", level: 3, hitDie: 10 }],
  abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 8 },
};

describe("competenze nelle abilità: solo sì o no", () => {
  it("mezza competenza e maestria contano come competenza piena", () => {
    expect(skillProficiency("none")).toBe("none");
    expect(skillProficiency(undefined)).toBe("none");
    expect(skillProficiency("proficient")).toBe("proficient");
    expect(skillProficiency("half")).toBe("proficient");
    expect(skillProficiency("expertise")).toBe("proficient");
  });
});

describe("armi e strumenti", () => {
  it("le liste sono vuote di default e accettano testo libero", () => {
    const sheet = parseCharacterSheet(base);
    expect(sheet.proficiencies).toEqual({ weapons: [], tools: [] });
    const withTools = parseCharacterSheet({ ...base, proficiencies: { weapons: ["Spada corta"], tools: ["Set da cuoco"] } });
    expect(withTools.proficiencies.weapons).toEqual(["Spada corta"]);
  });
});

describe("morte istantanea decisa dal GM", () => {
  it("il danno oltre i PF massimi non uccide il PG da solo, ma lo segnala", () => {
    // 500 supera di sicuro i PF massimi di questo personaggio.
    const hit = damageSheet(parseCharacterSheet(base), undefined, 500);
    expect(hit.hp.dead).toBe(false);
    expect(hit.hp.instantDeathPending).toBe(true);
    expect(hit.hp.current).toBe(0);
  });

  it("il GM sceglie: morto oppure a terra; il reset azzera lo stato", () => {
    const hit = damageSheet(parseCharacterSheet(base), undefined, 500);
    const dead = decideInstantDeathSheet(hit, undefined, true);
    expect(dead.hp.dead).toBe(true);
    expect(dead.hp.instantDeathPending).toBe(false);
    const alive = decideInstantDeathSheet(hit, undefined, false);
    expect(alive.hp.dead).toBe(false);
    expect(alive.hp.instantDeathPending).toBe(false);
    const reset = resetDeathSheet(dead, undefined);
    expect(reset.hp.dead).toBe(false);
    expect(reset.hp.stable).toBe(false);
    expect(reset.hp.deathSaves).toEqual({ successes: 0, failures: 0 });
  });
});
