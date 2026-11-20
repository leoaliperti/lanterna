import { describe, expect, it } from "vitest";
import type { Command } from "./commands.js";
import { rollInitiative, sortByInitiative, type Participant } from "./combat.js";
import { GM, MAIN, PREP, baseState, deepFreeze, token } from "./fixtures.test-utils.js";
import { createHistory, execute, redo, undo } from "./history.js";
import { checkInvariants } from "./invariants.js";
import { applyCommand } from "./reducer.js";
import { combatOf, type Actor, type CampaignState } from "./schema.js";
import type { StateChange } from "./changes.js";

/** Stato di base con qualche token in più (tutti nella scena MAIN, celle da 70 px). */
function world(): CampaignState {
  const s = baseState();
  return deepFreeze({
    ...s,
    tokens: [
      ...s.tokens,
      token("tok-a", { name: "Goblin A", x: 455 }),
      token("tok-b", { name: "Goblin B", x: 525, faction: "nemici" }),
      token("tok-c", { name: "Capo", x: 595, faction: "nemici" }),
    ],
  });
}

function run(s: CampaignState, cmd: Command | Record<string, unknown>, actor: Actor = GM) {
  const r = applyCommand(s, cmd, actor);
  if (!r.ok) throw new Error(`${(cmd as { type: string }).type}: ${r.error.code} ${r.error.message}`);
  return r;
}

const part = (id: string, tokenId: string | null, initiative: number | null, over: Partial<Participant> = {}): Participant => ({
  id,
  tokenId,
  name: tokenId ? null : `Libero ${id}`,
  initiative,
  hidden: false,
  hideInitiative: false,
  ...over,
});

const add = (s: CampaignState, p: Participant, sceneId = MAIN) => run(s, { type: "combat.add", sceneId, participant: p }).state;

/** Tre partecipanti (PG 15, Goblin A 12, Goblin B 8) e il combattimento avviato. */
function started(): CampaignState {
  let s = world();
  s = add(s, part("pa", "tok-p1", 15));
  s = add(s, part("pb", "tok-a", 12));
  s = add(s, part("pc", "tok-b", 8));
  return run(s, { type: "combat.start", sceneId: MAIN }).state;
}

const eff = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Effetto ${id}`,
  condition: null,
  remaining: 2,
  timing: "end",
  turnOf: null,
  secret: false,
  ...over,
});

const noticesOf = (changes: StateChange[]) => changes.flatMap((c) => (c.type === "notice" ? [c.notice] : []));

describe("iniziativa: partecipanti e ordine", () => {
  it("aggiunge in ordine di iniziativa decrescente, i senza valore in fondo", () => {
    let s = world();
    s = add(s, part("x1", "tok-a", 10));
    s = add(s, part("x2", "tok-b", 18));
    s = add(s, part("x3", null, null));
    s = add(s, part("x4", "tok-c", 10));
    expect(combatOf(s, MAIN)!.participants.map((p) => p.id)).toEqual(["x2", "x1", "x4", "x3"]);
    expect(checkInvariants(s)).toEqual([]);
  });

  it("rifiuta duplicati, token di un'altra scena, token inesistenti e voci libere senza nome", () => {
    let s = world();
    s = add(s, part("x1", "tok-a", 10));
    expect(applyCommand(s, { type: "combat.add", sceneId: MAIN, participant: part("x1", "tok-b", 1) }, GM)).toMatchObject({ error: { code: "CONFLICT" } });
    expect(applyCommand(s, { type: "combat.add", sceneId: MAIN, participant: part("x9", "tok-a", 1) }, GM)).toMatchObject({ error: { code: "CONFLICT" } });
    expect(applyCommand(s, { type: "combat.add", sceneId: MAIN, participant: part("x9", "tok-ghost", 1) }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(applyCommand(s, { type: "combat.add", sceneId: MAIN, participant: part("x9", "tok-drago-x", 1) }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(applyCommand(s, { type: "combat.add", sceneId: MAIN, participant: { ...part("x9", null, 1), name: null } }, GM)).toMatchObject({ error: { code: "INVALID" } });
    const drago = baseState().tokens.find((t) => t.sceneId === PREP)!;
    expect(applyCommand(world(), { type: "combat.add", sceneId: MAIN, participant: part("x9", drago.id, 1) }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("limite di partecipanti", () => {
    let s = world();
    for (let i = 0; i < 200; i++) s = add(s, part(`f${i}`, null, i));
    expect(applyCommand(s, { type: "combat.add", sceneId: MAIN, participant: part("fx", null, 1) }, GM)).toMatchObject({ error: { code: "INVALID" } });
  });

  it("update: nome solo per le voci libere; iniziativa e flag per tutti", () => {
    let s = add(world(), part("x1", "tok-a", 10));
    s = add(s, part("x2", null, 5));
    expect(applyCommand(s, { type: "combat.update", sceneId: MAIN, participantId: "x1", patch: { name: "Altro" } }, GM)).toMatchObject({ error: { code: "INVALID" } });
    s = run(s, { type: "combat.update", sceneId: MAIN, participantId: "x2", patch: { name: "Nuovo", hidden: true } }).state;
    s = run(s, { type: "combat.update", sceneId: MAIN, participantId: "x1", patch: { initiative: 3, hideInitiative: true } }).state;
    const c = combatOf(s, MAIN)!;
    expect(c.participants.find((p) => p.id === "x2")).toMatchObject({ name: "Nuovo", hidden: true });
    expect(c.participants.find((p) => p.id === "x1")).toMatchObject({ initiative: 3, hideInitiative: true });
    // Nessun cambiamento = nessuna versione.
    const same = run(s, { type: "combat.update", sceneId: MAIN, participantId: "x1", patch: { initiative: 3 } });
    expect(same.changes).toEqual([]);
    expect(same.state.version).toBe(s.version);
  });

  it("riordino manuale, ordinamento e valori d'iniziativa impostati in blocco", () => {
    let s = world();
    s = add(s, part("x1", "tok-a", null));
    s = add(s, part("x2", "tok-b", null));
    s = add(s, part("x3", "tok-c", null));
    s = run(s, { type: "combat.reorder", sceneId: MAIN, participantId: "x3", toIndex: 0 }).state;
    expect(combatOf(s, MAIN)!.participants.map((p) => p.id)).toEqual(["x3", "x1", "x2"]);
    s = run(s, { type: "combat.reorder", sceneId: MAIN, participantId: "x3", toIndex: 99 }).state;
    expect(combatOf(s, MAIN)!.participants.map((p) => p.id)).toEqual(["x1", "x2", "x3"]);
    s = run(s, { type: "combat.setInitiative", sceneId: MAIN, values: [{ participantId: "x1", initiative: 5 }, { participantId: "x2", initiative: 20 }, { participantId: "x3", initiative: 5 }], sort: true }).state;
    expect(combatOf(s, MAIN)!.participants.map((p) => [p.id, p.initiative])).toEqual([["x2", 20], ["x1", 5], ["x3", 5]]);
    expect(applyCommand(s, { type: "combat.setInitiative", sceneId: MAIN, values: [{ participantId: "zz", initiative: 5 }] }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(applyCommand(s, { type: "combat.setInitiative", sceneId: MAIN, values: [{ participantId: "x1", initiative: 5000 }] }, GM)).toMatchObject({ error: { code: "INVALID" } });
  });

  it("sortByInitiative è stabile e mette i nulli in fondo", () => {
    const ps = [part("a", null, 5), part("b", null, null), part("c", null, 5), part("d", null, 9)];
    expect(sortByInitiative(ps).map((p) => p.id)).toEqual(["d", "a", "c", "b"]);
  });

  it("il tiro dell'iniziativa usa l'RNG iniettato: d20 + bonus, vantaggio e svantaggio", () => {
    const seq = (...v: number[]) => {
      let i = 0;
      return (max: number) => {
        expect(max).toBe(20);
        return v[i++]!;
      };
    };
    expect(rollInitiative(seq(14), 3)).toEqual({ dice: [15], natural: 15, total: 18 });
    expect(rollInitiative(seq(4, 17), 0, "advantage")).toMatchObject({ dice: [5, 18], natural: 18, total: 18 });
    expect(rollInitiative(seq(4, 17), -2, "disadvantage")).toMatchObject({ natural: 5, total: 3 });
    expect(rollInitiative(() => 0, -5000).total).toBe(-1000);
  });
});

describe("turni e round", () => {
  it("start: round 1, primo di turno; non si riavvia, serve almeno un partecipante", () => {
    const s = started();
    expect(combatOf(s, MAIN)).toMatchObject({ started: true, round: 1, turnId: "pa" });
    expect(applyCommand(s, { type: "combat.start", sceneId: MAIN }, GM)).toMatchObject({ error: { code: "CONFLICT" } });
    expect(applyCommand(world(), { type: "combat.start", sceneId: MAIN }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(checkInvariants(s)).toEqual([]);
  });

  it("start con sort ordina per iniziativa", () => {
    let s = world();
    s = add(s, part("x1", "tok-a", null));
    s = add(s, part("x2", "tok-b", null));
    s = run(s, { type: "combat.setInitiative", sceneId: MAIN, values: [{ participantId: "x2", initiative: 7 }] }).state;
    s = run(s, { type: "combat.start", sceneId: MAIN, sort: true }).state;
    expect(combatOf(s, MAIN)!.turnId).toBe("x2");
  });

  it("next scorre i turni e al giro aumenta il round; previous torna indietro", () => {
    let s = started();
    const turns: [string, number][] = [];
    for (let i = 0; i < 7; i++) {
      s = run(s, { type: "combat.next", sceneId: MAIN }).state;
      const c = combatOf(s, MAIN)!;
      turns.push([c.turnId!, c.round]);
    }
    expect(turns).toEqual([["pb", 1], ["pc", 1], ["pa", 2], ["pb", 2], ["pc", 2], ["pa", 3], ["pb", 3]]);
    for (const expected of [["pa", 3], ["pc", 2], ["pb", 2]] as const) {
      s = run(s, { type: "combat.previous", sceneId: MAIN }).state;
      const c = combatOf(s, MAIN)!;
      expect([c.turnId, c.round]).toEqual(expected);
    }
    expect(checkInvariants(s)).toEqual([]);
  });

  it("previous non va prima del primo turno del round 1", () => {
    const s = started();
    expect(applyCommand(s, { type: "combat.previous", sceneId: MAIN }, GM)).toMatchObject({ error: { code: "CONFLICT" } });
    const s2 = run(s, { type: "combat.next", sceneId: MAIN }).state;
    const back = run(s2, { type: "combat.previous", sceneId: MAIN }).state;
    expect(combatOf(back, MAIN)).toMatchObject({ turnId: "pa", round: 1 });
    expect(applyCommand(back, { type: "combat.previous", sceneId: MAIN }, GM)).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("next e previous richiedono un combattimento avviato", () => {
    const s = add(world(), part("x1", "tok-a", 1));
    expect(applyCommand(s, { type: "combat.next", sceneId: MAIN }, GM)).toMatchObject({ error: { code: "CONFLICT" } });
    expect(applyCommand(s, { type: "combat.previous", sceneId: MAIN }, GM)).toMatchObject({ error: { code: "CONFLICT" } });
    expect(applyCommand(world(), { type: "combat.next", sceneId: MAIN }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("end toglie il combattimento", () => {
    const s = run(started(), { type: "combat.end", sceneId: MAIN }).state;
    expect(combatOf(s, MAIN)).toBeNull();
    expect(applyCommand(s, { type: "combat.end", sceneId: MAIN }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("segnala il turno corrente: avviso combat al partecipante di turno", () => {
    const s = started();
    const r = run(s, { type: "combat.next", sceneId: MAIN });
    const notices = noticesOf(r.changes);
    expect(notices).toContainEqual(expect.objectContaining({ kind: "turn", participantId: "pb", tokenId: "tok-a", round: 1 }));
  });

  it("togliere chi è di turno passa il turno al successivo (e al giro cambia round)", () => {
    let s = started();
    s = run(s, { type: "combat.remove", sceneId: MAIN, participantId: "pa" }).state;
    expect(combatOf(s, MAIN)).toMatchObject({ turnId: "pb", round: 1 });
    s = run(s, { type: "combat.next", sceneId: MAIN }).state; // pc
    s = run(s, { type: "combat.remove", sceneId: MAIN, participantId: "pc" }).state;
    expect(combatOf(s, MAIN)).toMatchObject({ turnId: "pb", round: 2 });
    // Togliere chi non è di turno non cambia il turno.
    s = add(s, part("pd", "tok-c", 1));
    s = run(s, { type: "combat.remove", sceneId: MAIN, participantId: "pd" }).state;
    expect(combatOf(s, MAIN)!.turnId).toBe("pb");
    // L'ultimo partecipante: il combattimento finisce.
    s = run(s, { type: "combat.remove", sceneId: MAIN, participantId: "pb" }).state;
    expect(combatOf(s, MAIN)).toBeNull();
    expect(checkInvariants(s)).toEqual([]);
  });

  it("cancellare un token lo toglie dal combattimento, dai gruppi e dalle ancore degli effetti", () => {
    let s = started();
    s = run(s, { type: "group.create", group: { id: "g1", name: "Goblin", tokenIds: ["tok-a", "tok-b"] } }).state;
    s = run(s, { type: "effect.add", tokenId: "tok-b", effect: eff("e1", { turnOf: "tok-a" }) }).state;
    const r = run(s, { type: "token.delete", tokenId: "tok-a" });
    const after = r.state;
    expect(combatOf(after, MAIN)!.participants.map((p) => p.id)).toEqual(["pa", "pc"]);
    expect(after.groups![0]!.tokenIds).toEqual(["tok-b"]);
    expect(after.tokens.find((t) => t.id === "tok-b")!.effects![0]!.turnOf).toBeNull();
    expect(checkInvariants(after)).toEqual([]);
    // Annullare riporta tutto com'era.
    const h = execute(s, createHistory(), { type: "token.delete", tokenId: "tok-a" }, GM);
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    const u = undo(h.state, h.history, GM);
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(combatOf(u.state, MAIN)).toEqual(combatOf(s, MAIN));
    expect(u.state.groups).toEqual(s.groups);
    expect(u.state.tokens.find((t) => t.id === "tok-b")!.effects).toEqual(s.tokens.find((t) => t.id === "tok-b")!.effects);
    expect(u.state.tokens.some((t) => t.id === "tok-a")).toBe(true);
    expect(checkInvariants(u.state)).toEqual([]);
  });

  it("cancellare una scena toglie il suo combattimento e i token dai gruppi; annullare ripristina", () => {
    const s0 = started();
    const s = run(s0, { type: "group.create", group: { id: "g1", name: "G", tokenIds: ["tok-a", "tok-orc"] } }).state;
    const h = execute(s, createHistory(), { type: "scene.delete", sceneId: MAIN }, GM);
    if (!h.ok) throw new Error("scene.delete");
    expect(combatOf(h.state, MAIN)).toBeNull();
    expect(h.state.groups![0]!.tokenIds).toEqual([]);
    expect(checkInvariants(h.state)).toEqual([]);
    const u = undo(h.state, h.history, GM);
    if (!u.ok) throw new Error(`undo ${u.error.message}`);
    expect(combatOf(u.state, MAIN)).toEqual(combatOf(s, MAIN));
    expect(u.state.groups).toEqual(s.groups);
    expect(checkInvariants(u.state)).toEqual([]);
  });

  it("annulla/ripeti di next e start", () => {
    const s = world();
    let h = createHistory();
    let cur = add(s, part("pa", "tok-p1", 15));
    cur = add(cur, part("pb", "tok-a", 12));
    for (const cmd of [{ type: "combat.start", sceneId: MAIN }, { type: "combat.next", sceneId: MAIN }]) {
      const r = execute(cur, h, cmd, GM);
      if (!r.ok) throw new Error("exec");
      cur = r.state;
      h = r.history;
    }
    expect(combatOf(cur, MAIN)!.turnId).toBe("pb");
    let u = undo(cur, h, GM);
    if (!u.ok) throw new Error(u.error.message);
    expect(combatOf(u.state, MAIN)!.turnId).toBe("pa");
    u = undo(u.state, u.history, GM);
    if (!u.ok) throw new Error(u.error.message);
    expect(combatOf(u.state, MAIN)!.started).toBe(false);
    const r = redo(u.state, u.history, GM);
    if (!r.ok) throw new Error(r.error.message);
    expect(combatOf(r.state, MAIN)!.started).toBe(true);
  });

  it("combat.restore valida scena, token e coerenza", () => {
    const s = started();
    const c = combatOf(s, MAIN)!;
    expect(applyCommand(s, { type: "combat.restore", sceneId: PREP, combat: c }, GM)).toMatchObject({ error: { code: "INVALID" } });
    expect(applyCommand(s, { type: "combat.restore", sceneId: "ghost", combat: null }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(applyCommand(s, { type: "combat.restore", sceneId: MAIN, combat: { ...c, turnId: "zz" } }, GM)).toMatchObject({ error: { code: "INVALID" } });
    expect(applyCommand(s, { type: "combat.restore", sceneId: MAIN, combat: { ...c, participants: [...c.participants, part("q", "tok-ghost", 1)] } }, GM)).toMatchObject({ error: { code: "INVALID" } });
    expect(run(s, { type: "combat.restore", sceneId: MAIN, combat: null }).state.combats).toEqual([]);
  });
});

describe("effetti con durata", () => {
  it("effect.add/update/remove sul token", () => {
    let s = world();
    s = run(s, { type: "effect.add", tokenId: "tok-a", effect: eff("e1") }).state;
    expect(s.tokens.find((t) => t.id === "tok-a")!.effects).toEqual([{ ...eff("e1"), addedCondition: false }]);
    expect(applyCommand(s, { type: "effect.add", tokenId: "tok-a", effect: eff("e1") }, GM)).toMatchObject({ error: { code: "CONFLICT" } });
    s = run(s, { type: "effect.update", tokenId: "tok-a", effectId: "e1", patch: { remaining: 5, name: "Benedizione" } }).state;
    expect(s.tokens.find((t) => t.id === "tok-a")!.effects![0]).toMatchObject({ remaining: 5, name: "Benedizione" });
    expect(applyCommand(s, { type: "effect.update", tokenId: "tok-a", effectId: "zz", patch: { remaining: 5 } }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
    s = run(s, { type: "effect.remove", tokenId: "tok-a", effectId: "e1" }).state;
    expect("effects" in s.tokens.find((t) => t.id === "tok-a")!).toBe(false);
    expect(applyCommand(s, { type: "effect.remove", tokenId: "tok-a", effectId: "e1" }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(applyCommand(s, { type: "effect.add", tokenId: "tok-ghost", effect: eff("e1") }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(applyCommand(s, { type: "effect.add", tokenId: "tok-a", effect: eff("e1", { turnOf: "tok-ghost" }) }, GM)).toMatchObject({ error: { code: "INVALID" } });
    expect(applyCommand(s, { type: "effect.add", tokenId: "tok-a", effect: eff("e1", { remaining: 0 }) }, GM)).toMatchObject({ error: { code: "INVALID" } });
  });

  it("limite di effetti per token", () => {
    let s = world();
    for (let i = 0; i < 16; i++) s = run(s, { type: "effect.add", tokenId: "tok-a", effect: eff(`e${i}`) }).state;
    expect(applyCommand(s, { type: "effect.add", tokenId: "tok-a", effect: eff("e99") }, GM)).toMatchObject({ error: { code: "INVALID" } });
  });

  it("scade alla fine del turno del proprietario dopo N round, con avviso 'in arrivo' un round prima", () => {
    let s = started();
    s = run(s, { type: "effect.add", tokenId: "tok-p1", effect: eff("e1", { remaining: 2, timing: "end" }) }).state;
    const effects = () => s.tokens.find((t) => t.id === "tok-p1")!.effects;
    const seen: { kind: string; effectId?: string }[] = [];
    const step = () => {
      const r = run(s, { type: "combat.next", sceneId: MAIN });
      s = r.state;
      seen.push(...noticesOf(r.changes).filter((n) => n.kind !== "turn"));
    };
    // round 1: pa -> pb (fine turno di pa: remaining 2 -> 1, avviso in arrivo)
    step();
    expect(effects()![0]!.remaining).toBe(1);
    expect(seen).toEqual([expect.objectContaining({ kind: "expiring", effectId: "e1", remaining: 1 })]);
    step(); // pc
    step(); // pa, round 2 (inizio turno: l'effetto scade alla fine di questo turno -> avviso)
    expect(effects()![0]!.remaining).toBe(1);
    expect(seen.filter((n) => n.kind === "expiring")).toHaveLength(2);
    expect(seen.some((n) => n.kind === "expired")).toBe(false);
    step(); // fine turno di pa: scade
    expect(effects()).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ kind: "expired", effectId: "e1", reason: "elapsed" });
    expect(checkInvariants(s)).toEqual([]);
  });

  it("scade all'inizio del turno dell'ancora (turnOf diverso dal bersaglio)", () => {
    let s = started();
    // Incantesimo del Goblin A (ancora) sul PG: dura fino all'inizio del suo prossimo turno.
    s = run(s, { type: "effect.add", tokenId: "tok-p1", effect: eff("e1", { remaining: 1, timing: "start", turnOf: "tok-a" }) }).state;
    let r = run(s, { type: "combat.next", sceneId: MAIN }); // inizia il turno di pb (tok-a): scade subito
    s = r.state;
    expect(s.tokens.find((t) => t.id === "tok-p1")!.effects).toBeUndefined();
    expect(noticesOf(r.changes)).toContainEqual(expect.objectContaining({ kind: "expired", effectId: "e1", tokenId: "tok-p1" }));
    r = run(s, { type: "combat.next", sceneId: MAIN });
    expect(noticesOf(r.changes).some((n) => n.kind === "expired")).toBe(false);
  });

  it("gli effetti senza scadenza non scalano mai; quelli senza combattimento avviato non scalano", () => {
    let s = world();
    s = run(s, { type: "effect.add", tokenId: "tok-a", effect: eff("e1", { remaining: null }) }).state;
    s = run(s, { type: "effect.add", tokenId: "tok-b", effect: eff("e2", { remaining: 1 }) }).state;
    s = add(s, part("pa", "tok-a", 5));
    s = add(s, part("pb", "tok-b", 1));
    s = run(s, { type: "combat.start", sceneId: MAIN }).state;
    for (let i = 0; i < 6; i++) s = run(s, { type: "combat.next", sceneId: MAIN }).state;
    expect(s.tokens.find((t) => t.id === "tok-a")!.effects![0]!.remaining).toBeNull();
    expect(s.tokens.find((t) => t.id === "tok-b")!.effects).toBeUndefined();
  });

  it("previous e di nuovo next non fanno scalare due volte", () => {
    let s = started();
    s = run(s, { type: "effect.add", tokenId: "tok-p1", effect: eff("e1", { remaining: 3, timing: "end" }) }).state;
    s = run(s, { type: "combat.next", sceneId: MAIN }).state;
    expect(s.tokens.find((t) => t.id === "tok-p1")!.effects![0]!.remaining).toBe(2);
    s = run(s, { type: "combat.previous", sceneId: MAIN }).state;
    s = run(s, { type: "combat.next", sceneId: MAIN }).state;
    expect(s.tokens.find((t) => t.id === "tok-p1")!.effects![0]!.remaining).toBe(2);
    s = run(s, { type: "combat.next", sceneId: MAIN }).state;
    s = run(s, { type: "combat.next", sceneId: MAIN }).state; // di nuovo pa (round 2)
    s = run(s, { type: "combat.next", sceneId: MAIN }).state; // fine turno di pa
    expect(s.tokens.find((t) => t.id === "tok-p1")!.effects![0]!.remaining).toBe(1);
  });

  it("alla fine del combattimento gli effetti con durata terminano con avviso, gli altri restano", () => {
    let s = started();
    s = run(s, { type: "effect.add", tokenId: "tok-p1", effect: eff("e1", { remaining: 5, condition: { id: "poisoned", name: "Avvelenato" } }) }).state;
    s = run(s, { type: "effect.add", tokenId: "tok-p1", effect: eff("e2", { remaining: null }) }).state;
    const r = run(s, { type: "combat.end", sceneId: MAIN });
    expect(noticesOf(r.changes)).toEqual([expect.objectContaining({ kind: "expired", effectId: "e1", reason: "combatEnded" })]);
    const t = r.state.tokens.find((x) => x.id === "tok-p1")!;
    expect(t.effects!.map((e) => e.id)).toEqual(["e2"]);
    expect(t.conditions.some((c) => c.id === "poisoned")).toBe(true); // era già avvelenata nella fixture: non l'ha aggiunta l'effetto
  });

  it("interazione con le condizioni: l'effetto aggiunge la condizione e la toglie alla scadenza", () => {
    let s = started();
    s = run(s, { type: "effect.add", tokenId: "tok-a", effect: eff("e1", { remaining: 1, timing: "start", condition: { id: "stunned", name: "Stordito" } }) }).state;
    const tok = () => s.tokens.find((t) => t.id === "tok-a")!;
    expect(tok().conditions.map((c) => c.id)).toEqual(["stunned"]);
    expect(tok().effects![0]!.addedCondition).toBe(true);
    s = run(s, { type: "combat.next", sceneId: MAIN }).state; // inizio turno di tok-a: scade
    expect(tok().conditions).toEqual([]);
    expect(tok().effects).toBeUndefined();
  });

  it("una condizione già presente non viene tolta dall'effetto", () => {
    let s = world();
    s = run(s, { type: "token.update", tokenId: "tok-a", patch: { conditions: [{ id: "prone", name: "Prono" }] } }).state;
    s = run(s, { type: "effect.add", tokenId: "tok-a", effect: eff("e1", { condition: { id: "prone", name: "Prono" } }) }).state;
    expect(s.tokens.find((t) => t.id === "tok-a")!.effects![0]!.addedCondition).toBe(false);
    s = run(s, { type: "effect.remove", tokenId: "tok-a", effectId: "e1" }).state;
    expect(s.tokens.find((t) => t.id === "tok-a")!.conditions.map((c) => c.id)).toEqual(["prone"]);
  });

  it("due effetti con la stessa condizione: la condizione resta finché ne resta uno", () => {
    let s = world();
    const c = { id: "frightened", name: "Spaventato" };
    s = run(s, { type: "effect.add", tokenId: "tok-a", effect: eff("e1", { condition: c }) }).state;
    s = run(s, { type: "effect.add", tokenId: "tok-a", effect: eff("e2", { condition: c }) }).state;
    s = run(s, { type: "effect.remove", tokenId: "tok-a", effectId: "e1" }).state;
    expect(s.tokens.find((t) => t.id === "tok-a")!.conditions.map((x) => x.id)).toEqual(["frightened"]);
    s = run(s, { type: "effect.remove", tokenId: "tok-a", effectId: "e2" }).state;
    expect(s.tokens.find((t) => t.id === "tok-a")!.conditions).toEqual([]);
  });

  it("annulla di effect.add e di effect.remove ripristina effetti e condizioni", () => {
    const s = world();
    const c = { id: "frightened", name: "Spaventato" };
    const a = execute(s, createHistory(), { type: "effect.add", tokenId: "tok-a", effect: eff("e1", { condition: c }) }, GM);
    if (!a.ok) throw new Error("add");
    const ua = undo(a.state, a.history, GM);
    if (!ua.ok) throw new Error("undo add");
    expect(ua.state.tokens.find((t) => t.id === "tok-a")).toEqual(s.tokens.find((t) => t.id === "tok-a"));
    const r = execute(a.state, a.history, { type: "effect.remove", tokenId: "tok-a", effectId: "e1" }, GM);
    if (!r.ok) throw new Error("rm");
    const ur = undo(r.state, r.history, GM);
    if (!ur.ok) throw new Error("undo rm");
    expect(ur.state.tokens.find((t) => t.id === "tok-a")).toEqual(a.state.tokens.find((t) => t.id === "tok-a"));
  });

  it("annulla di next ripristina effetti, condizioni e turno", () => {
    let s = started();
    s = run(s, { type: "effect.add", tokenId: "tok-p1", effect: eff("e1", { remaining: 1, timing: "end", condition: { id: "stunned", name: "Stordito" } }) }).state;
    const before = s;
    const r = execute(s, createHistory(), { type: "combat.next", sceneId: MAIN }, GM);
    if (!r.ok) throw new Error("next");
    expect(r.state.tokens.find((t) => t.id === "tok-p1")!.effects).toBeUndefined();
    const u = undo(r.state, r.history, GM);
    if (!u.ok) throw new Error(u.error.message);
    expect(u.state.tokens.find((t) => t.id === "tok-p1")).toEqual(before.tokens.find((t) => t.id === "tok-p1"));
    expect(combatOf(u.state, MAIN)).toEqual(combatOf(before, MAIN));
  });
});

describe("gruppi, selezione e azioni di gruppo", () => {
  it("CRUD dei gruppi con annulla", () => {
    let s = world();
    s = run(s, { type: "group.create", group: { id: "g1", name: "Nemici", tokenIds: ["tok-a", "tok-b"] } }).state;
    expect(applyCommand(s, { type: "group.create", group: { id: "g1", name: "X", tokenIds: [] } }, GM)).toMatchObject({ error: { code: "CONFLICT" } });
    expect(applyCommand(s, { type: "group.create", group: { id: "g2", name: "X", tokenIds: ["ghost"] } }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(applyCommand(s, { type: "group.create", group: { id: "g2", name: "X", tokenIds: ["tok-a", "tok-a"] } }, GM)).toMatchObject({ error: { code: "INVALID" } });
    s = run(s, { type: "group.update", groupId: "g1", patch: { name: "Goblin", tokenIds: ["tok-a"] } }).state;
    expect(s.groups).toEqual([{ id: "g1", name: "Goblin", tokenIds: ["tok-a"] }]);
    expect(applyCommand(s, { type: "group.update", groupId: "zz", patch: { name: "A" } }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
    const del = execute(s, createHistory(), { type: "group.delete", groupId: "g1" }, GM);
    if (!del.ok) throw new Error("del");
    expect(del.state.groups).toEqual([]);
    const u = undo(del.state, del.history, GM);
    if (!u.ok) throw new Error("undo");
    expect(u.state.groups).toEqual(s.groups);
  });

  it("limite di gruppi", () => {
    let s = world();
    for (let i = 0; i < 100; i++) s = run(s, { type: "group.create", group: { id: `x${i}`, name: "n", tokenIds: [] } }).state;
    expect(applyCommand(s, { type: "group.create", group: { id: "x100", name: "n", tokenIds: [] } }, GM)).toMatchObject({ error: { code: "INVALID" } });
  });

  it("selezione per categoria: solo PG, solo mostri, fazione, senza nascosti", () => {
    const s = world();
    const sel = (target: Record<string, unknown>) => {
      const r = applyCommand(s, { type: "group.apply", target, action: { kind: "addCondition", condition: { id: "marked", name: "Segnato" } } }, GM);
      if (!r.ok) throw new Error(r.error.message);
      return r.state.tokens.filter((t) => t.conditions.some((c) => c.id === "marked")).map((t) => t.id).sort();
    };
    expect(sel({ kind: "category", sceneId: MAIN, tokenKind: "pc" })).toEqual(["tok-hidden-p1", "tok-p1", "tok-p2"]);
    expect(sel({ kind: "category", sceneId: MAIN, tokenKind: "monster" })).toEqual(["tok-a", "tok-b", "tok-c", "tok-hidden-ogre", "tok-orc"]);
    expect(sel({ kind: "category", sceneId: MAIN, tokenKind: "monster", includeHidden: false })).toEqual(["tok-a", "tok-b", "tok-c", "tok-orc"]);
    expect(sel({ kind: "category", sceneId: MAIN, faction: "nemici" })).toEqual(["tok-b", "tok-c"]);
    expect(sel({ kind: "category", sceneId: MAIN, faction: "nessuno" })).toEqual([]);
    expect(applyCommand(s, { type: "group.apply", target: { kind: "category", sceneId: "zz" }, action: { kind: "heal", amount: 1 } }, GM)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("danno di gruppo con PF temporanei, 0 PF e morte; è atomico e un solo annulla lo ripristina", () => {
    let s = world();
    s = run(s, { type: "token.update", tokenId: "tok-a", patch: { health: { current: 10, max: 10, temp: 4 } } }).state;
    s = run(s, { type: "token.update", tokenId: "tok-b", patch: { health: { current: 6, max: 10, temp: 0 } } }).state;
    s = run(s, { type: "token.update", tokenId: "tok-c", patch: { health: { current: 30, max: 30, temp: 0 } } }).state;
    s = run(s, { type: "group.create", group: { id: "g1", name: "Goblin", tokenIds: ["tok-a", "tok-b", "tok-c", "tok-p1"] } }).state;
    const h = execute(s, createHistory(), { type: "group.apply", target: { kind: "group", groupId: "g1" }, action: { kind: "damage", amount: 8 } }, GM);
    if (!h.ok) throw new Error(h.error.message);
    const hp = (id: string) => h.state.tokens.find((t) => t.id === id)!;
    expect(hp("tok-a").health).toEqual({ current: 6, max: 10, temp: 0 }); // 4 temp + 4 PF
    expect(hp("tok-b").health).toEqual({ current: 0, max: 10, temp: 0 });
    expect(hp("tok-b").conditions.map((c) => c.id)).toContain("dead"); // mostro a 0 PF
    expect(hp("tok-c").health).toEqual({ current: 22, max: 30, temp: 0 });
    expect(hp("tok-p1").health).toEqual({ current: 1352, max: 9999, temp: 0 }); // 3 temporanei + 5 PF
    expect(h.state.version).toBe(s.version + 1); // una sola versione
    expect(h.history.entries).toHaveLength(1);
    const u = undo(h.state, h.history, GM);
    if (!u.ok) throw new Error(u.error.message);
    expect(u.state.tokens).toEqual(s.tokens);
    const rr = redo(u.state, u.history, GM);
    if (!rr.ok) throw new Error(rr.error.message);
    expect(rr.state.tokens).toEqual(h.state.tokens);
  });

  it("un PG a 0 PF diventa privo di sensi; massacro = morto; la cura lo rialza", () => {
    let s = world();
    s = run(s, { type: "token.update", tokenId: "tok-p2", patch: { health: { current: 5, max: 20, temp: 0 } } }).state;
    const dmg = (st: CampaignState, amount: number) => run(st, { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-p2"] }, action: { kind: "damage", amount } }).state;
    const p2 = (st: CampaignState) => st.tokens.find((t) => t.id === "tok-p2")!;
    const down = dmg(s, 7);
    expect(p2(down).health!.current).toBe(0);
    expect(p2(down).conditions.map((c) => c.id)).toEqual(["unconscious"]);
    const dead = dmg(s, 25); // resto 20 >= PF massimi
    expect(p2(dead).conditions.map((c) => c.id)).toEqual(["dead"]);
    const up = run(down, { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-p2"] }, action: { kind: "heal", amount: 4 } }).state;
    expect(p2(up).health!.current).toBe(4);
    expect(p2(up).conditions).toEqual([]);
    // Un morto non si cura né subisce altro danno.
    const nothing = run(dead, { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-p2"] }, action: { kind: "heal", amount: 4 } });
    expect(nothing.changes).toEqual([]);
    // Cura oltre il massimo si ferma al massimo.
    const full = run(s, { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-p2"] }, action: { kind: "heal", amount: 500 } }).state;
    expect(p2(full).health!.current).toBe(20);
  });

  it("PF temporanei: vale il più alto, non si sommano", () => {
    let s = world();
    s = run(s, { type: "token.update", tokenId: "tok-a", patch: { health: { current: 5, max: 20, temp: 6 } } }).state;
    const tgt = { kind: "tokens", tokenIds: ["tok-a"] };
    const lower = run(s, { type: "group.apply", target: tgt, action: { kind: "tempHp", amount: 3 } });
    expect(lower.changes).toEqual([]);
    const higher = run(s, { type: "group.apply", target: tgt, action: { kind: "tempHp", amount: 9 } }).state;
    expect(higher.tokens.find((t) => t.id === "tok-a")!.health!.temp).toBe(9);
  });

  it("aggiungere e togliere una condizione a un gruppo", () => {
    let s = world();
    const tgt = { kind: "category", sceneId: MAIN, faction: "nemici" };
    s = run(s, { type: "group.apply", target: tgt, action: { kind: "addCondition", condition: { id: "prone", name: "Prono" } } }).state;
    expect(s.tokens.filter((t) => t.faction === "nemici").every((t) => t.conditions.some((c) => c.id === "prone"))).toBe(true);
    // idempotente
    expect(run(s, { type: "group.apply", target: tgt, action: { kind: "addCondition", condition: { id: "prone", name: "Prono" } } }).changes).toEqual([]);
    s = run(s, { type: "group.apply", target: tgt, action: { kind: "removeCondition", conditionId: "prone" } }).state;
    expect(s.tokens.filter((t) => t.faction === "nemici").every((t) => t.conditions.length === 0)).toBe(true);
  });

  it("effetto di gruppo: un effetto per token con id derivato, idempotente", () => {
    let s = world();
    const action = { kind: "addEffect", effect: eff("bless", { remaining: 3, condition: { id: "blessed", name: "Benedetto" } }) };
    const r = run(s, { type: "group.apply", target: { kind: "category", sceneId: MAIN, faction: "nemici" }, action });
    s = r.state;
    const ids = s.tokens.filter((t) => t.effects).map((t) => t.effects![0]!.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith("bless-"))).toBe(true);
    expect(run(s, { type: "group.apply", target: { kind: "category", sceneId: MAIN, faction: "nemici" }, action }).changes).toEqual([]);
    expect(checkInvariants(s)).toEqual([]);
  });

  it("spostamento di gruppo: offset, atomico (un token fuori mappa fa fallire tutto)", () => {
    const s = world();
    const a = s.tokens.find((t) => t.id === "tok-a")!;
    const r = run(s, { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-a", "tok-b"] }, action: { kind: "move", dx: 70, dy: 140 } }).state;
    expect(r.tokens.find((t) => t.id === "tok-a")).toMatchObject({ x: a.x + 70, y: a.y + 140 });
    expect(r.tokens.find((t) => t.id === "tok-b")).toMatchObject({ x: 525 + 70, y: 105 + 140 });
    // tok-c (x=595) esce dalla mappa (1400) con dx=900: tutto o niente.
    const bad = applyCommand(s, { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-a", "tok-c"] }, action: { kind: "move", dx: 900, dy: 0 } }, GM);
    expect(bad).toMatchObject({ ok: false, error: { code: "INVALID" } });
    // annulla in un colpo
    const h = execute(s, createHistory(), { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-a", "tok-b"] }, action: { kind: "move", dx: 70, dy: 70 } }, GM);
    if (!h.ok) throw new Error("move");
    const u = undo(h.state, h.history, GM);
    if (!u.ok) throw new Error("undo");
    expect(u.state.tokens).toEqual(s.tokens);
  });

  it("bersaglio vuoto o senza effetto: nessun cambiamento, nessuna versione", () => {
    const s = world();
    const r = run(s, { type: "group.apply", target: { kind: "tokens", tokenIds: [] }, action: { kind: "heal", amount: 5 } });
    expect(r.changes).toEqual([]);
    expect(r.state).toBe(s);
  });

  it("un token inesistente nel bersaglio fa fallire tutta l'azione (atomica)", () => {
    const s = world();
    const r = applyCommand(s, { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-a", "ghost"] }, action: { kind: "addCondition", condition: { id: "x", name: "x" } } }, GM);
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

});

describe("fazione e campi del token", () => {
  it("faction si imposta con token.update (GM) e null la toglie dalla forma canonica", () => {
    let s = world();
    s = run(s, { type: "token.update", tokenId: "tok-a", patch: { faction: "banda" } }).state;
    expect(s.tokens.find((t) => t.id === "tok-a")!.faction).toBe("banda");
    s = run(s, { type: "token.update", tokenId: "tok-a", patch: { faction: null } }).state;
    expect("faction" in s.tokens.find((t) => t.id === "tok-a")!).toBe(false);
  });
});
