import { describe, expect, it } from "vitest";
import { applyServerEvent } from "../protocol/client.js";
import type { StateChange } from "./changes.js";
import type { Command } from "./commands.js";
import { filterEventFor, filterEventsFor } from "./filter.js";
import { GM, MAIN, P1, P2, STRANGER, baseState, deepFreeze, expectNoLeak, token } from "./fixtures.test-utils.js";
import { createHistory, execute, undo } from "./history.js";
import { applyCommand } from "./reducer.js";
import { type Actor, type CampaignState } from "./schema.js";
import { viewFor, type CampaignView } from "./view.js";

const SECRET = {
  hiddenMonster: "MostroNascostoXYZ",
  hiddenEntry: "VoceNascostaXYZ",
  secretEffect: "EffettoSegretoXYZ",
  faction: "FazioneSegretaXYZ",
  freeName: "AraldoLiberoXYZ",
};

function world(): CampaignState {
  const s = baseState();
  return deepFreeze({
    ...s,
    tokens: [
      ...s.tokens,
      token("tok-a", { name: "Goblin A", x: 455, faction: SECRET.faction }),
      token("tok-m", { name: SECRET.hiddenMonster, x: 525, hidden: true }),
    ],
  });
}

const ok = (s: CampaignState, cmd: Command | Record<string, unknown>, actor: Actor = GM) => {
  const r = applyCommand(s, cmd, actor);
  if (!r.ok) throw new Error(`${(cmd as { type: string }).type}: ${r.error.code} ${r.error.message}`);
  return r;
};

const entry = (id: string, tokenId: string | null, initiative: number | null, over: Record<string, unknown> = {}) => ({
  id,
  tokenId,
  name: tokenId ? null : `Libero ${id}`,
  initiative,
  hidden: false,
  hideInitiative: false,
  ...over,
});

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

/** Combattimento avviato con vari tipi di partecipanti. */
function fight(): CampaignState {
  let s = world();
  const add = (p: Record<string, unknown>) => (s = ok(s, { type: "combat.add", sceneId: MAIN, participant: p }).state);
  add(entry("pa", "tok-p1", 18));
  add(entry("pb", "tok-p2", 14));
  add(entry("po", "tok-orc", 12, { hideInitiative: true }));
  add(entry("pm", "tok-m", 10)); // token nascosto
  add(entry("ph", null, 9, { hidden: true, name: SECRET.hiddenEntry }));
  add(entry("pf", null, 7, { name: SECRET.freeName }));
  s = ok(s, { type: "combat.start", sceneId: MAIN }).state;
  return s;
}

const ALL_COMMANDS: [string, Record<string, unknown>][] = [
  ["combat.add", { type: "combat.add", sceneId: MAIN, participant: entry("n1", "tok-a", 1) }],
  ["combat.update", { type: "combat.update", sceneId: MAIN, participantId: "pa", patch: { initiative: 3 } }],
  ["combat.remove", { type: "combat.remove", sceneId: MAIN, participantId: "pb" }],
  ["combat.reorder", { type: "combat.reorder", sceneId: MAIN, participantId: "pb", toIndex: 0 }],
  ["combat.setInitiative", { type: "combat.setInitiative", sceneId: MAIN, values: [{ participantId: "pb", initiative: 30 }] }],
  ["combat.sort", { type: "combat.sort", sceneId: MAIN }],
  ["combat.start", { type: "combat.start", sceneId: MAIN }],
  ["combat.next", { type: "combat.next", sceneId: MAIN }],
  ["combat.previous", { type: "combat.previous", sceneId: MAIN }],
  ["combat.end", { type: "combat.end", sceneId: MAIN }],
  ["combat.restore", { type: "combat.restore", sceneId: MAIN, combat: null }],
  ["effect.add", { type: "effect.add", tokenId: "tok-p1", effect: eff("x1") }],
  ["effect.update", { type: "effect.update", tokenId: "tok-p1", effectId: "x1", patch: { remaining: 3 } }],
  ["effect.remove", { type: "effect.remove", tokenId: "tok-p1", effectId: "x1" }],
  ["group.create", { type: "group.create", group: { id: "g9", name: "G", tokenIds: ["tok-p1"] } }],
  ["group.update", { type: "group.update", groupId: "g1", patch: { name: "Z" } }],
  ["group.delete", { type: "group.delete", groupId: "g1" }],
  ["group.restore", { type: "group.restore", groupId: "g1", group: null }],
  ["group.apply (gruppo)", { type: "group.apply", target: { kind: "group", groupId: "g1" }, action: { kind: "heal", amount: 1 } }],
  ["group.apply (categoria)", { type: "group.apply", target: { kind: "category", sceneId: MAIN }, action: { kind: "move", dx: 1, dy: 1 } }],
  ["group.apply danno proprio", { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-p1"] }, action: { kind: "damage", amount: 1 } }],
  ["group.apply cura propria", { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-p1"] }, action: { kind: "heal", amount: 1 } }],
  ["group.apply PF temp propri", { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-p1"] }, action: { kind: "tempHp", amount: 1 } }],
  ["group.apply effetto proprio", { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-p1"] }, action: { kind: "addEffect", effect: eff("q") } }],
  ["token.update effects", { type: "token.update", tokenId: "tok-p1", patch: { effects: [] } }],
  ["token.update faction", { type: "token.update", tokenId: "tok-p1", patch: { faction: "x" } }],
];

describe("matrice dei permessi (M7)", () => {
  const base = (() => {
    let s = fight();
    s = ok(s, { type: "group.create", group: { id: "g1", name: "G", tokenIds: ["tok-p1", "tok-orc"] } }).state;
    s = ok(s, { type: "effect.add", tokenId: "tok-p1", effect: eff("x1") }).state;
    return s;
  })();

  for (const [name, cmd] of ALL_COMMANDS) {
    it(`${name}: il GM può, i giocatori no`, () => {
      const gm = applyCommand(base, cmd, GM);
      // Il GM non riceve mai FORBIDDEN (altri errori dipendono dallo stato di prova).
      if (!gm.ok) expect(gm.error.code, name).not.toBe("FORBIDDEN");
      for (const who of [P1, P2, STRANGER]) {
        const r = applyCommand(base, cmd, who);
        expect(r.ok, `${name} per ${who.userId}`).toBe(false);
        if (!r.ok) {
          // Il giocatore riceve FORBIDDEN, senza rivelare cosa esista; per un token non suo/invisibile NOT_FOUND.
          expect(["FORBIDDEN", "NOT_FOUND"]).toContain(r.error.code);
          expectNoLeak(JSON.stringify(r), [SECRET.hiddenMonster, SECRET.hiddenEntry, SECRET.faction, SECRET.secretEffect]);
        }
      }
    });
  }

  it("i comandi solo-GM rispondono FORBIDDEN ai giocatori anche con un id inesistente (prima di guardare lo stato)", () => {
    for (const cmd of [
      { type: "combat.next", sceneId: "ghost" },
      { type: "effect.add", tokenId: "ghost", effect: eff("z") },
      { type: "group.delete", groupId: "ghost" },
      { type: "group.apply", target: { kind: "group", groupId: "ghost" }, action: { kind: "move", dx: 1, dy: 1 } },
      { type: "group.apply", target: { kind: "category", sceneId: "ghost" }, action: { kind: "move", dx: 1, dy: 1 } },
    ]) {
      const r = applyCommand(base, cmd, P1);
      expect(r, JSON.stringify(cmd)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    }
  });

  describe("azioni di gruppo del giocatore: solo sulle proprie cose già consentite", () => {
    const own = { kind: "tokens", tokenIds: ["tok-p1"] };
    const sc = (s: CampaignState, target: unknown, action: unknown, who: Actor) => applyCommand(s, { type: "group.apply", target, action }, who);

    it("può muovere e cambiare le condizioni dei propri token", () => {
      const moved = sc(base, own, { kind: "move", dx: 70, dy: 0 }, P1);
      expect(moved.ok).toBe(true);
      const cond = sc(base, own, { kind: "addCondition", condition: { id: "prone", name: "Prono" } }, P1);
      expect(cond.ok).toBe(true);
      if (cond.ok) expect(cond.state.tokens.find((t) => t.id === "tok-p1")!.conditions.map((c) => c.id)).toContain("prone");
      const rem = sc(base, own, { kind: "removeCondition", conditionId: "poisoned" }, P1);
      expect(rem.ok).toBe(true);
    });

    it("non può muovere o cambiare i token altrui, né quelli nascosti", () => {
      expect(sc(base, { kind: "tokens", tokenIds: ["tok-p2"] }, { kind: "move", dx: 70, dy: 0 }, P1)).toMatchObject({ error: { code: "FORBIDDEN" } });
      expect(sc(base, { kind: "tokens", tokenIds: ["tok-p1", "tok-p2"] }, { kind: "move", dx: 70, dy: 0 }, P1)).toMatchObject({ error: { code: "FORBIDDEN" } });
      // token nascosto: indistinguibile da uno inesistente
      const hidden = sc(base, { kind: "tokens", tokenIds: ["tok-m"] }, { kind: "move", dx: 1, dy: 1 }, P1);
      const ghost = sc(base, { kind: "tokens", tokenIds: ["tok-ghost"] }, { kind: "move", dx: 1, dy: 1 }, P1);
      expect(hidden).toEqual(ghost);
      expect(hidden).toMatchObject({ error: { code: "NOT_FOUND" } });
    });

    it("l'azione di gruppo è atomica anche per il giocatore (un token non suo annulla tutto)", () => {
      const r = sc(base, { kind: "tokens", tokenIds: ["tok-p1", "tok-orc"] }, { kind: "addCondition", condition: { id: "x", name: "x" } }, P1);
      expect(r.ok).toBe(false);
    });

    it("il giocatore annulla la propria azione di gruppo, non quella del GM", () => {
      const h1 = execute(base, createHistory(), { type: "group.apply", target: own, action: { kind: "move", dx: 70, dy: 0 } }, P1);
      if (!h1.ok) throw new Error("move");
      const u = undo(h1.state, h1.history, P1);
      expect(u.ok).toBe(true);
      const h2 = execute(base, createHistory(), { type: "group.apply", target: { kind: "group", groupId: "g1" }, action: { kind: "damage", amount: 1 } }, GM);
      if (!h2.ok) throw new Error("dmg");
      expect(undo(h2.state, h2.history, P1)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    });
  });
});

describe("visibilità del combattimento (nessuna fuga ai giocatori)", () => {
  const s = fight();
  const view = (who: Actor) => viewFor(s, who);

  it("il GM vede tutto, con flag e iniziative", () => {
    const c = view(GM).combats![0]!;
    expect(c.participants.map((p) => p.id)).toEqual(["pa", "pb", "po", "pm", "ph", "pf"]);
    expect(c.participants.find((p) => p.id === "po")).toMatchObject({ initiative: 12, hideInitiative: true, hidden: false });
    expect(c.participants.find((p) => p.id === "ph")).toMatchObject({ hidden: true, name: SECRET.hiddenEntry });
    expect(c.turnId).toBe("pa");
  });

  it("il giocatore non vede voci nascoste né di token nascosti, e non vede le iniziative nascoste", () => {
    for (const who of [P1, P2]) {
      const c = view(who).combats![0]!;
      expect(c.participants.map((p) => p.id)).toEqual(["pa", "pb", "po", "pf"]);
      expect(c.participants.find((p) => p.id === "po")).toEqual({ id: "po", tokenId: "tok-orc", name: "Orco", initiative: null });
      expect(c.participants.find((p) => p.id === "pa")!.initiative).toBe(18);
      const json = JSON.stringify(view(who));
      expectNoLeak(json, [SECRET.hiddenMonster, SECRET.hiddenEntry, "tok-m", '"pm"', "hideInitiative"]);
      expectNoLeak(JSON.stringify(c), ['"hidden"']);
      expect(json).not.toContain(SECRET.faction);
    }
  });

  it("se il turno è di un partecipante nascosto il giocatore non sa di chi sia", () => {
    let st = s;
    for (let i = 0; i < 3; i++) st = ok(st, { type: "combat.next", sceneId: MAIN }).state; // pm
    const c = viewFor(st, P1).combats![0]!;
    expect(c.turnId).toBeNull();
    expect(viewFor(st, GM).combats![0]!.turnId).toBe("pm");
    expect(JSON.stringify(viewFor(st, P1))).not.toContain(SECRET.hiddenMonster);
  });

  it("il giocatore vede solo il combattimento della scena attiva", () => {
    const st: CampaignState = { ...s, activeSceneId: "scn-prep" };
    expect(viewFor(st, P1).combats).toEqual([]);
    expect(viewFor(st, GM).combats).toHaveLength(1);
  });

  it("i gruppi e la fazione non arrivano ai giocatori", () => {
    const st = ok(s, { type: "group.create", group: { id: "g1", name: "BandaSegretaXYZ", tokenIds: ["tok-a"] } }).state;
    expect(viewFor(st, GM).groups).toEqual([{ id: "g1", name: "BandaSegretaXYZ", tokenIds: ["tok-a"] }]);
    expect(viewFor(st, GM).tokens.find((t) => t.id === "tok-a")!.faction).toBe(SECRET.faction);
    for (const who of [P1, P2]) {
      const v = viewFor(st, who);
      expect(v.groups).toBeUndefined();
      expectNoLeak(JSON.stringify(v), ["BandaSegretaXYZ", SECRET.faction, '"faction"']);
    }
    // eventi: solo al GM
    const r = ok(s, { type: "group.create", group: { id: "g1", name: "BandaSegretaXYZ", tokenIds: ["tok-a"] } });
    expect(filterEventsFor(r.changes, GM).map((e) => e.type)).toContain("group.created");
    for (const who of [P1, P2]) expect(filterEventsFor(r.changes, who)).toEqual([]);
  });

  it("gli effetti segreti sono solo del GM; gli altri non mostrano ancora né segreto", () => {
    let st = s;
    st = ok(st, { type: "effect.add", tokenId: "tok-p1", effect: eff("pub", { turnOf: "tok-orc", name: "Benedizione" }) }).state;
    st = ok(st, { type: "effect.add", tokenId: "tok-p1", effect: eff("sec", { name: SECRET.secretEffect, secret: true }) }).state;
    const gmEffects = viewFor(st, GM).tokens.find((t) => t.id === "tok-p1")!.effects!;
    expect(gmEffects.map((e) => e.id)).toEqual(["pub", "sec"]);
    expect(gmEffects[0]).toMatchObject({ turnOf: "tok-orc", secret: false });
    for (const who of [P1, P2]) {
      const t = viewFor(st, who).tokens.find((x) => x.id === "tok-p1")!;
      expect(t.effects).toEqual([{ id: "pub", name: "Benedizione", condition: null, remaining: 2, timing: "end" }]);
      expectNoLeak(JSON.stringify(viewFor(st, who)), [SECRET.secretEffect, "turnOf", "addedCondition", '"secret"']);
    }
    // eventi di aggiunta dell'effetto segreto
    const r = ok(s, { type: "effect.add", tokenId: "tok-p1", effect: eff("sec", { name: SECRET.secretEffect, secret: true }) });
    for (const who of [P1, P2]) expectNoLeak(JSON.stringify(filterEventsFor(r.changes, who)), [SECRET.secretEffect]);
    expect(JSON.stringify(filterEventsFor(r.changes, GM))).toContain(SECRET.secretEffect);
  });

  it("un token sotto la nebbia non compare nel tracker del giocatore finché non è rivelato", () => {
    let st = ok(s, { type: "fog.enable", sceneId: MAIN, initial: "covered" }).state;
    // P1 vede solo l'area intorno a tok-p1 (35,35) e a tok-orc? No: solo il suo token (sempre visibile) e la cella dell'orco.
    st = ok(st, { type: "fog.reveal", sceneId: MAIN, shape: { kind: "rect", x: 280, y: 280, width: 70, height: 70 }, target: { kind: "players", userIds: ["p1"] } }).state;
    const ids = (who: Actor) => viewFor(st, who).combats![0]!.participants.map((p) => p.id);
    expect(ids(P1)).toEqual(["pa", "po", "pf"]); // sé stesso, l'orco rivelato e la voce libera
    expect(ids(P2)).toEqual(["pb", "pf"]); // solo il proprio token
    expect(ids(GM)).toHaveLength(6);
    expectNoLeak(JSON.stringify(viewFor(st, P2)), ["Alice-PG", "Orco", "tok-orc", "tok-p1"]);
  });

  it("applicare gli eventi alla vista precedente dà esattamente la vista nuova (combattimento, gruppi, effetti)", () => {
    const cmds: Record<string, unknown>[] = [
      { type: "combat.next", sceneId: MAIN },
      { type: "combat.update", sceneId: MAIN, participantId: "po", patch: { hideInitiative: false } },
      { type: "combat.update", sceneId: MAIN, participantId: "pm", patch: { hidden: true } },
      { type: "token.update", tokenId: "tok-m", patch: { hidden: false } },
      { type: "token.update", tokenId: "tok-m", patch: { name: "Rinominato" } },
      { type: "effect.add", tokenId: "tok-orc", effect: eff("e1", { remaining: 1, timing: "start" }) },
      { type: "combat.next", sceneId: MAIN },
      { type: "combat.next", sceneId: MAIN },
      { type: "combat.next", sceneId: MAIN },
      { type: "combat.next", sceneId: MAIN },
      { type: "combat.next", sceneId: MAIN },
      { type: "combat.next", sceneId: MAIN },
      { type: "token.move", tokenId: "tok-m", x: 700, y: 700 },
      { type: "scene.activate", sceneId: "scn-prep" },
      { type: "scene.activate", sceneId: MAIN },
      { type: "group.create", group: { id: "g1", name: "G", tokenIds: ["tok-a"] } },
      { type: "token.delete", tokenId: "tok-orc" },
      { type: "combat.end", sceneId: MAIN },
    ];
    for (const who of [GM, P1, P2]) {
      let st = s;
      let v: CampaignView = viewFor(st, who);
      for (const cmd of cmds) {
        const r = ok(st, cmd);
        st = r.state;
        v = { ...filterEventsFor(r.changes, who).reduce(applyServerEvent, v), version: st.version };
        const expected = viewFor(st, who);
        const norm = (x: CampaignView): CampaignView => ({ ...x, tokens: [...x.tokens].sort((a, b) => a.id.localeCompare(b.id)) });
        expect(norm(v), `${who.userId} dopo ${JSON.stringify(cmd)}`).toEqual(norm(expected));
      }
    }
  });
});

describe("avvisi: solo ai diretti interessati", () => {
  const notice = (changes: StateChange[]) => changes.filter((c) => c.type === "notice");

  it("il turno è segnalato al GM e al proprietario del token, non agli altri", () => {
    const s = fight();
    const r = ok(s, { type: "combat.next", sceneId: MAIN }); // tocca a pb (tok-p2, di P2)
    const events = (who: Actor) => notice(r.changes).flatMap((c) => filterEventFor(c, who));
    expect(events(GM)).toEqual([expect.objectContaining({ type: "combat.turn", participantId: "pb", tokenId: "tok-p2" })]);
    expect(events(P2)).toEqual([expect.objectContaining({ type: "combat.turn", participantId: "pb" })]);
    expect(events(P1)).toEqual([]);
    expect(events(STRANGER)).toEqual([]);
  });

  it("il turno di una voce libera o di un token nascosto non avvisa i giocatori", () => {
    let s = fight();
    for (let i = 0; i < 2; i++) s = ok(s, { type: "combat.next", sceneId: MAIN }).state; // po
    const r1 = ok(s, { type: "combat.next", sceneId: MAIN }); // pm, token nascosto
    const r2 = ok(r1.state, { type: "combat.next", sceneId: MAIN }); // ph, voce libera nascosta
    for (const r of [r1, r2]) {
      for (const who of [P1, P2]) expect(notice(r.changes).flatMap((c) => filterEventFor(c, who))).toEqual([]);
      expect(notice(r.changes).flatMap((c) => filterEventFor(c, GM))).toHaveLength(1);
    }
  });

  it("scadenza e avviso di scadenza: proprietario e GM; i segreti solo il GM", () => {
    let s = fight();
    s = ok(s, { type: "effect.add", tokenId: "tok-p1", effect: eff("pub", { remaining: 2, name: "Benedizione" }) }).state;
    s = ok(s, { type: "effect.add", tokenId: "tok-p1", effect: eff("sec", { remaining: 2, name: SECRET.secretEffect, secret: true }) }).state;
    const r = ok(s, { type: "combat.next", sceneId: MAIN }); // fine turno di pa: remaining 2 -> 1 (avviso in arrivo)
    const ev = (who: Actor, rr = r) => rr.changes.filter((c) => c.type === "notice").flatMap((c) => filterEventFor(c, who));
    expect(ev(P1).map((e) => e.type).filter((t) => t.startsWith("effect"))).toEqual(["effect.expiring"]);
    expect(ev(GM).map((e) => e.type).filter((t) => t.startsWith("effect"))).toEqual(["effect.expiring", "effect.expiring"]);
    expect(ev(P2).filter((e) => e.type.startsWith("effect"))).toEqual([]);
    expectNoLeak(JSON.stringify(ev(P1)), [SECRET.secretEffect]);
    // il turno dopo il giro: scade
    let st = r.state;
    for (let i = 0; i < 5; i++) st = ok(st, { type: "combat.next", sceneId: MAIN }).state;
    const last = ok(st, { type: "combat.next", sceneId: MAIN });
    expect(ev(P1, last).map((e) => e.type).filter((t) => t.startsWith("effect"))).toEqual(["effect.expired"]);
    expect(ev(GM, last).map((e) => e.type).filter((t) => t.startsWith("effect"))).toEqual(["effect.expired", "effect.expired"]);
    expect(ev(P2, last).filter((e) => e.type.startsWith("effect"))).toEqual([]);
  });

  it("un token nascosto non manda avvisi al proprietario", () => {
    let s = world();
    s = ok(s, { type: "combat.add", sceneId: MAIN, participant: entry("pa", "tok-p1", 18) }).state;
    s = ok(s, { type: "effect.add", tokenId: "tok-hidden-p1", effect: eff("h", { remaining: 1, timing: "start", turnOf: "tok-p1" }) }).state;
    // Inizia il turno di tok-p1: l'effetto sul token nascosto (di P1) scade, ma P1 non lo deve sapere.
    const r = ok(s, { type: "combat.start", sceneId: MAIN });
    const expired = (who: Actor) => r.changes.filter((c) => c.type === "notice").flatMap((c) => filterEventFor(c, who)).filter((e) => e.type === "effect.expired");
    expect(expired(P1)).toEqual([]);
    expect(expired(GM)).toHaveLength(1);
  });
});
