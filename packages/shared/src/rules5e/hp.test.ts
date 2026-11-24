import { describe, expect, it } from "vitest";
import {
  applyDamage,
  decideInstantDeath,
  resetDeath,
  deathSave,
  grantTempHp,
  heal,
  maxHitPoints,
  newHpState,
  stabilize,
} from "./index.js";

describe("PF massimi", () => {
  it("primo livello: dado al massimo + Cos", () => {
    expect(maxHitPoints([10], 2)).toBe(12);
    expect(maxHitPoints([6], -1)).toBe(5);
  });
  it("livelli successivi: media fissa (d10 = 6, d8 = 5, d6 = 4, d12 = 7)", () => {
    expect(maxHitPoints([10, 10, 10, 10, 10], 2)).toBe(12 + 4 * 8);
    expect(maxHitPoints([8, 8, 8], 1)).toBe(9 + 2 * 6);
    expect(maxHitPoints([6, 6], 0)).toBe(6 + 4);
    expect(maxHitPoints([12, 12], 3)).toBe(15 + 10);
  });
  it("tiri effettivi e multiclasse", () => {
    expect(maxHitPoints([10, 10, 8], 2, { rolls: [undefined, 9, undefined] })).toBe(12 + 11 + 7);
  });
  it("minimo 1 PF per livello", () => {
    expect(maxHitPoints([6, 6, 6], -5)).toBe(3);
  });
});

describe("danno e cura", () => {
  it("i PF temporanei assorbono per primi", () => {
    const hp = { ...newHpState(20), temp: 5 };
    const r = applyDamage(hp, 8);
    expect(r.temp).toBe(0);
    expect(r.current).toBe(17);
  });
  it("a 0 PF: cade a terra, tiri azzerati", () => {
    const r = applyDamage(newHpState(10), 10);
    expect(r.current).toBe(0);
    expect(r.dead).toBe(false);
  });
  it("danno residuo >= PF massimi: morte istantanea in sospeso, decide il GM (non morto da solo)", () => {
    const hit = applyDamage(newHpState(10), 20);
    expect(hit.dead).toBe(false);
    expect(hit.instantDeathPending).toBe(true);
    expect(applyDamage(newHpState(10), 19).instantDeathPending).toBeFalsy();
    const wounded = { ...newHpState(10), current: 4 };
    expect(applyDamage(wounded, 14).instantDeathPending).toBe(true);
  });
  it("il GM decide: morto, oppure resta a terra; il reset sblocca la vita", () => {
    const pending = applyDamage(newHpState(10), 20);
    expect(decideInstantDeath(pending, true).dead).toBe(true);
    const alive = decideInstantDeath(pending, false);
    expect(alive.dead).toBe(false);
    expect(alive.current).toBe(0);
    expect(alive.instantDeathPending).toBe(false);
    const stuck = { ...newHpState(10), current: 0, dead: true };
    const reset = resetDeath(stuck);
    expect(reset.dead).toBe(false);
    expect(heal(reset, 4).current).toBe(4);
  });
  it("danno a 0 PF: un fallimento, due se critico, morte a 3", () => {
    const down = applyDamage(newHpState(30), 30);
    const a = applyDamage(down, 3);
    expect(a.deathSaves.failures).toBe(1);
    const b = applyDamage(a, 3, { critical: true });
    expect(b.deathSaves.failures).toBe(3);
    expect(b.dead).toBe(true);
  });
  it("danno a 0 PF >= massimo: morte istantanea in sospeso, decide il GM", () => {
    const down = applyDamage(newHpState(10), 10);
    const hit = applyDamage(down, 10);
    expect(hit.dead).toBe(false);
    expect(hit.instantDeathPending).toBe(true);
  });
  it("cura: non oltre il massimo, azzera i tiri contro la morte", () => {
    const hp = { ...newHpState(20), current: 15 };
    expect(heal(hp, 100).current).toBe(20);
    let down = applyDamage(newHpState(20), 20);
    down = applyDamage(down, 1);
    const up = heal(down, 5);
    expect(up.current).toBe(5);
    expect(up.deathSaves).toEqual({ successes: 0, failures: 0 });
  });
  it("i morti non guariscono", () => {
    expect(heal({ ...newHpState(10), current: 0, dead: true }, 5).current).toBe(0);
  });
  it("PF temporanei non si sommano", () => {
    const hp = grantTempHp(grantTempHp(newHpState(10), 5), 3);
    expect(hp.temp).toBe(5);
    expect(grantTempHp(hp, 8).temp).toBe(8);
  });
});

describe("tiri salvezza contro la morte", () => {
  const down = applyDamage(newHpState(20), 20);
  it("10+ successo, 2-9 fallimento", () => {
    expect(deathSave(down, 10).deathSaves).toEqual({ successes: 1, failures: 0 });
    expect(deathSave(down, 9).deathSaves).toEqual({ successes: 0, failures: 1 });
  });
  it("1 naturale: due fallimenti", () => {
    expect(deathSave(down, 1).deathSaves.failures).toBe(2);
  });
  it("20 naturale: torna a 1 PF", () => {
    const r = deathSave(down, 20);
    expect(r.current).toBe(1);
    expect(r.deathSaves).toEqual({ successes: 0, failures: 0 });
  });
  it("tre successi: stabile; tre fallimenti: morto", () => {
    let s = down;
    for (let i = 0; i < 3; i++) s = deathSave(s, 12);
    expect(s.stable).toBe(true);
    expect(s.dead).toBe(false);
    let f = down;
    f = deathSave(f, 5);
    f = deathSave(f, 1);
    expect(f.dead).toBe(true);
  });
  it("il totale (es. Esaurimento) decide successo/fallimento, non il naturale", () => {
    expect(deathSave(down, 11, 9).deathSaves.failures).toBe(1);
  });
  it("stabilizzazione", () => {
    const hurt = applyDamage(down, 2);
    const st = stabilize(hurt);
    expect(st.stable).toBe(true);
    expect(st.deathSaves).toEqual({ successes: 0, failures: 0 });
    expect(stabilize(newHpState(10)).stable).toBe(false);
  });
  it("il danno a un stabile lo rende di nuovo instabile con un fallimento", () => {
    const r = applyDamage(stabilize(down), 1);
    expect(r.stable).toBe(false);
    expect(r.deathSaves.failures).toBe(1);
  });
  it("non si tira se non a 0 PF", () => {
    expect(deathSave(newHpState(10), 1)).toEqual(newHpState(10));
  });
});
