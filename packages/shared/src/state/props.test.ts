import { describe, expect, it } from "vitest";
import { applyServerEvent } from "../protocol/client.js";
import type { Command } from "./commands.js";
import { filterEventsFor } from "./filter.js";
import { GM, MAIN, P1, PREP, STRANGER, baseState, token } from "./fixtures.test-utils.js";
import type { Prop } from "./props.js";
import { applyCommand, applyCommands } from "./reducer.js";
import type { Actor, CampaignState } from "./schema.js";
import { viewFor } from "./view.js";

const SECRET_NAME = "OggettoSegretoXYZ";

function prop(id: string, over: Partial<Prop> = {}): Prop {
  return {
    id,
    sceneId: MAIN,
    name: `Albero ${id}`,
    imageUrl: `/assets/${id}.png`,
    x: 300,
    y: 300,
    width: 140,
    height: 140,
    rotation: 0,
    layer: "above",
    opacity: 1,
    fade: true,
    hidden: false,
    ...over,
  };
}

function run(state: CampaignState, cmd: Command, actor: Actor = GM): CampaignState {
  const r = applyCommand(state, cmd, actor);
  if (!r.ok) throw new Error(`${cmd.type}: ${r.error.code}`);
  return r.state;
}

const stripVersion = (s: CampaignState) => ({ ...s, version: 0, props: s.props ?? [] });

describe("oggetti di scena: permessi", () => {
  const cmds: Command[] = [
    { type: "prop.create", prop: prop("a") },
    { type: "prop.update", propId: "a", patch: { opacity: 0.5 } },
    { type: "prop.delete", propId: "a" },
    { type: "scene.duplicate", sceneId: MAIN, newSceneId: "dup", name: "Copia" },
  ];
  for (const cmd of cmds) {
    it(`${cmd.type}: giocatore FORBIDDEN, GM ok`, () => {
      const base = run(baseState(), { type: "prop.create", prop: prop("a") });
      for (const who of [P1, STRANGER]) {
        const r = applyCommand(base, cmd, who);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(["FORBIDDEN"]).toContain(r.error.code);
      }
      if (cmd.type === "prop.create") return;
      expect(applyCommand(base, cmd, GM).ok).toBe(true);
    });
  }

  it("id duplicato, scena inesistente, fuori mappa", () => {
    const s = run(baseState(), { type: "prop.create", prop: prop("a") });
    const code = (c: Command) => {
      const r = applyCommand(s, c, GM);
      return r.ok ? "ok" : r.error.code;
    };
    expect(code({ type: "prop.create", prop: prop("a") })).toBe("CONFLICT");
    expect(code({ type: "prop.create", prop: prop("b", { sceneId: "nope" }) })).toBe("NOT_FOUND");
    expect(code({ type: "prop.create", prop: prop("b", { x: 99999 }) })).toBe("INVALID");
    expect(code({ type: "prop.update", propId: "zzz", patch: { opacity: 0.1 } })).toBe("NOT_FOUND");
  });
});

describe("oggetti di scena: inverso esatto", () => {
  it("create, update e delete si annullano", () => {
    const s0 = baseState();
    const steps: Command[] = [
      { type: "prop.create", prop: prop("a") },
      { type: "prop.update", propId: "a", patch: { layer: "ground", x: 400, rotation: 90, hidden: true } },
      { type: "prop.delete", propId: "a" },
    ];
    let cur = s0;
    const inverses: Command[][] = [];
    const states: CampaignState[] = [s0];
    for (const c of steps) {
      const r = applyCommand(cur, c, GM);
      if (!r.ok) throw new Error("fallito");
      inverses.push(r.inverse);
      cur = r.state;
      states.push(cur);
    }
    for (let i = steps.length - 1; i >= 0; i--) {
      const r = applyCommands(cur, inverses[i]!, GM);
      if (!r.ok) throw new Error("inverso fallito");
      cur = r.state;
      expect(stripVersion(cur)).toEqual(stripVersion(states[i]!));
    }
  });

  it("scene.duplicate copia tutto e si annulla; eliminare la scena si annulla con gli oggetti", () => {
    let s = run(baseState(), { type: "prop.create", prop: prop("a") });
    s = run(s, { type: "fog.enable", sceneId: MAIN, initial: "revealed" });
    const r = applyCommand(s, { type: "scene.duplicate", sceneId: MAIN, newSceneId: "dup", name: "Copia" }, GM);
    if (!r.ok) throw new Error("duplicate");
    expect(r.state.scenes.find((x) => x.id === "dup")?.name).toBe("Copia");
    expect(r.state.props?.filter((p) => p.sceneId === "dup")).toHaveLength(1);
    expect(r.state.tokens.filter((t) => t.sceneId === "dup").length).toBe(s.tokens.filter((t) => t.sceneId === MAIN).length);
    expect(r.state.fogs?.some((f) => f.sceneId === "dup")).toBe(true);
    expect(r.state.activeSceneId).toBe(MAIN);
    const back = applyCommands(r.state, r.inverse, GM);
    if (!back.ok) throw new Error("undo");
    expect(stripVersion(back.state)).toEqual(stripVersion(s));

    const del = applyCommand(s, { type: "scene.delete", sceneId: MAIN }, GM);
    if (!del.ok) throw new Error("delete");
    expect(del.state.props ?? []).toHaveLength(0);
    const undo = applyCommands(del.state, del.inverse, GM);
    if (!undo.ok) throw new Error("undo delete");
    expect(undo.state.props).toEqual(s.props);
  });
});

describe("oggetti di scena: cosa vede ciascun utente", () => {
  function scenario(): CampaignState {
    let s = baseState();
    s = run(s, { type: "prop.create", prop: prop("vis") });
    s = run(s, { type: "prop.create", prop: prop("hid", { hidden: true, name: SECRET_NAME }) });
    s = run(s, { type: "prop.create", prop: prop("prep", { sceneId: PREP, name: "PrepXYZ" }) });
    return s;
  }

  it("il giocatore riceve solo gli oggetti visibili della scena attiva, senza nome ne' hidden", () => {
    const v = viewFor(scenario(), P1);
    expect(v.props?.map((p) => p.id)).toEqual(["vis"]);
    const json = JSON.stringify(v);
    expect(json).not.toContain(SECRET_NAME);
    expect(json).not.toContain("PrepXYZ");
    expect(json).not.toContain("Albero");
    expect(v.props?.[0]).not.toHaveProperty("name");
    expect(v.props?.[0]).not.toHaveProperty("hidden");
    expect(viewFor(scenario(), GM).props?.map((p) => p.id).sort()).toEqual(["hid", "prep", "vis"]);
  });

  it("con la nebbia l'oggetto arriva solo se una cella sotto di lui e' rivelata", () => {
    let s = scenario();
    s = run(s, { type: "fog.enable", sceneId: MAIN, initial: "covered" });
    expect(viewFor(s, P1).props).toEqual([]);
    s = run(s, { type: "prop.create", prop: prop("far", { x: 1000, y: 800 }) });
    s = run(s, {
      type: "fog.reveal",
      sceneId: MAIN,
      shape: { kind: "rect", x: 280, y: 280, width: 40, height: 40 },
      target: { kind: "all" },
    } as Command);
    expect(viewFor(s, P1).props?.map((p) => p.id)).toEqual(["vis"]);
  });

  it("i delta ricostruiscono esattamente la vista di ciascuno e non perdono segreti", () => {
    let s = baseState();
    const views = new Map<string, ReturnType<typeof viewFor>>([[GM.userId, viewFor(s, GM)], [P1.userId, viewFor(s, P1)]]);
    const actors = [GM, P1];
    const steps: Command[] = [
      { type: "prop.create", prop: prop("vis") },
      { type: "prop.create", prop: prop("hid", { hidden: true, name: SECRET_NAME }) },
      { type: "prop.update", propId: "hid", patch: { hidden: false } },
      { type: "prop.update", propId: "vis", patch: { hidden: true } },
      { type: "fog.enable", sceneId: MAIN, initial: "covered" },
      { type: "prop.update", propId: "vis", patch: { hidden: false } },
      { type: "scene.activate", sceneId: PREP },
      { type: "scene.activate", sceneId: MAIN },
      { type: "prop.delete", propId: "hid" },
    ];
    for (const c of steps) {
      const r = applyCommand(s, c, GM);
      if (!r.ok) throw new Error(c.type);
      s = r.state;
      for (const a of actors) {
        const events = filterEventsFor(r.changes, a);
        if (a.role === "player") {
          expect(JSON.stringify(events)).not.toContain(SECRET_NAME);
        }
        views.set(a.userId, events.reduce(applyServerEvent, views.get(a.userId)!));
        expect(views.get(a.userId)!.props ?? []).toEqual(viewFor(s, a).props ?? []);
      }
    }
  });

  it("i token del giocatore non influenzano la vista degli oggetti (sola lettura)", () => {
    const s = run(scenario(), { type: "token.create", token: token("mine", { ownerUserId: "p1", x: 300, y: 300 }) });
    expect(viewFor(s, P1).props?.map((p) => p.id)).toEqual(["vis"]);
  });
});
