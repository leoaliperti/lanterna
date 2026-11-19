import { describe, expect, it } from "vitest";
import {
  CONDITIONS,
  attackAgainstMode,
  clampExhaustion,
  conditionEffects,
  exhaustionD20Penalty,
  exhaustionIsLethal,
  exhaustionSpeedPenalty,
} from "./index.js";

describe("condizioni 2024", () => {
  it("sono 15, incluso Esaurimento", () => {
    expect(CONDITIONS).toHaveLength(15);
    expect(CONDITIONS).toContain("exhaustion");
  });
});

describe("Esaurimento 2024", () => {
  it.each([
    [0, 0, 0], [1, 2, 5], [2, 4, 10], [3, 6, 15], [4, 8, 20], [5, 10, 25], [6, 12, 30],
  ])("livello %i: d20 -%i, velocita -%i ft", (lvl, d20, speed) => {
    expect(exhaustionD20Penalty(lvl)).toBe(d20);
    expect(exhaustionSpeedPenalty(lvl)).toBe(speed);
  });
  it("letale al 6, valori limitati a 0-6", () => {
    expect(exhaustionIsLethal(5)).toBe(false);
    expect(exhaustionIsLethal(6)).toBe(true);
    expect(clampExhaustion(9)).toBe(6);
    expect(clampExhaustion(-1)).toBe(0);
  });
});

describe("effetti numerici delle condizioni", () => {
  it("Trattenuto: velocita 0, svantaggio ai propri attacchi e salvezza Des, vantaggio contro", () => {
    const e = conditionEffects(["restrained"]);
    expect(e.speedZero).toBe(true);
    expect(e.ownAttackMode).toBe("disadvantage");
    expect(e.dexSaveMode).toBe("disadvantage");
    expect(e.attacksAgainstAdvantage).toBe(true);
  });
  it("Paralizzato: incapacitato, fallisce For/Des, critico in mischia", () => {
    const e = conditionEffects(["paralyzed"]);
    expect(e.incapacitated).toBe(true);
    expect(e.autoFailSaves).toEqual(["str", "dex"]);
    expect(e.meleeWithin5ftAutoCrit).toBe(true);
    expect(e.speedZero).toBe(true);
  });
  it("Avvelenato e Spaventato: svantaggio ad attacchi e prove", () => {
    for (const c of ["poisoned", "frightened"] as const) {
      const e = conditionEffects([c]);
      expect(e.ownAttackMode).toBe("disadvantage");
      expect(e.ownAbilityCheckMode).toBe("disadvantage");
    }
  });
  it("Invisibile annulla lo svantaggio di Avvelenato sugli attacchi", () => {
    expect(conditionEffects(["invisible", "poisoned"]).ownAttackMode).toBe("normal");
    expect(conditionEffects(["invisible"]).ownAttackMode).toBe("advantage");
  });
  it("Prono: vantaggio entro 5 ft, svantaggio da lontano", () => {
    const e = conditionEffects(["prone"]);
    expect(attackAgainstMode(e, { within5ft: true })).toBe("advantage");
    expect(attackAgainstMode(e, { within5ft: false })).toBe("disadvantage");
    expect(e.ownAttackMode).toBe("disadvantage");
  });
  it("Pietrificato: resistenza a tutto, Afferrato: velocita 0", () => {
    expect(conditionEffects(["petrified"]).resistAllDamage).toBe(true);
    expect(conditionEffects(["grappled"]).speedZero).toBe(true);
  });
  it("Privo di sensi: incapacitato, vantaggio contro entro 5 ft", () => {
    const e = conditionEffects(["unconscious"]);
    expect(e.incapacitated).toBe(true);
    expect(attackAgainstMode(e, { within5ft: true })).toBe("advantage");
  });
  it("nessuna condizione: tutto neutro", () => {
    const e = conditionEffects([]);
    expect(e.ownAttackMode).toBe("normal");
    expect(attackAgainstMode(e, { within5ft: true })).toBe("normal");
  });
});
