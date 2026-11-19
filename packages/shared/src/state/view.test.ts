import { describe, expect, it } from "vitest";
import { applyServerEvent } from "../protocol/client.js";
import type { StateChange } from "./changes.js";
import type { Command } from "./commands.js";
import { filterEventFor, filterEventsFor, type ServerEvent } from "./filter.js";
import { GM, MAIN, P1, P2, PREP, SECRET, baseState, expectNoLeak, token } from "./fixtures.test-utils.js";
import { applyCommand } from "./reducer.js";
import type { Actor, CampaignState } from "./schema.js";
import { CampaignViewSchema, viewFor } from "./view.js";

/** Segreti che nessun giocatore deve mai vedere nello stato di riferimento. */
const ALWAYS_SECRET = [
  SECRET.hiddenOgreId,
  SECRET.hiddenOgreName,
  SECRET.hiddenP1Id,
  SECRET.hiddenP1Name,
  SECRET.prepDragonId,
  SECRET.prepDragonName,
  SECRET.prepSceneName,
  SECRET.prepAsset,
  PREP,
  SECRET.notesP1,
  SECRET.notesOrc,
  "gmNotes",
  SECRET.orcHp,
];

function apply(s: CampaignState, cmd: Command, actor: Actor = GM) {
  const r = applyCommand(s, cmd, actor);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r;
}

describe("viewFor", () => {
  it("il GM vede tutto, note comprese", () => {
    const v = viewFor(baseState(), GM);
    const json = JSON.stringify(v);
    for (const s of [SECRET.hiddenOgreName, SECRET.prepDragonName, SECRET.notesOrc, String(SECRET.p2Hp)]) {
      expect(json).toContain(s);
    }
    expect(v.tokens).toHaveLength(baseState().tokens.length);
    expect(v.scenes).toHaveLength(2);
  });

  it("P1: niente token nascosti, niente scene non attive, niente note, niente vita altrui", () => {
    const v = viewFor(baseState(), P1);
    const json = JSON.stringify(v);
    expectNoLeak(json, [...ALWAYS_SECRET, SECRET.p2Hp]);
    // La propria vita sì.
    expect(json).toContain(String(SECRET.p1Hp));
    // Condizioni visibili a tutti, anche sui token altrui.
    expect(json).toContain("Prono");
    expect(v.tokens.map((t) => t.id)).toEqual(["tok-p1", "tok-p2", "tok-orc"]);
    expect(v.tokens.find((t) => t.id === "tok-orc")!.health).toBeNull();
    expect(v.tokens.every((t) => !("gmNotes" in t))).toBe(true);
    expect(v.scenes.map((s) => s.id)).toEqual([MAIN]);
    expect(CampaignViewSchema.safeParse(v).success).toBe(true);
  });

  it("P2: vede la propria vita e non quella di P1", () => {
    const json = JSON.stringify(viewFor(baseState(), P2));
    expectNoLeak(json, [...ALWAYS_SECRET, SECRET.p1Hp]);
    expect(json).toContain(String(SECRET.p2Hp));
  });

  it("un token nascosto di proprietà del giocatore resta nascosto anche a lui", () => {
    expect(JSON.stringify(viewFor(baseState(), P1))).not.toContain(SECRET.hiddenP1Id);
  });

  it("nessuna scena attiva: il giocatore non vede né scene né token", () => {
    const s = apply(baseState(), { type: "scene.activate", sceneId: null }).state;
    const v = viewFor(s, P1);
    expect(v.scenes).toEqual([]);
    expect(v.tokens).toEqual([]);
  });

  it("la vista è una copia: modificarla non tocca lo stato", () => {
    const s = baseState();
    const v = viewFor(s, GM);
    v.tokens[0]!.conditions.push({ id: "x", name: "X" });
    v.scenes[0]!.grid.cellSize = 1;
    expect(s.tokens[0]!.conditions).toHaveLength(1);
    expect(s.scenes[0]!.grid.cellSize).toBe(70);
  });
});

/** Esegue un comando come GM e restituisce gli eventi per `viewer` serializzati. */
function eventsJson(cmd: Command, viewer: Actor, s = baseState()): { events: ServerEvent[]; json: string } {
  const r = apply(s, cmd);
  const events = filterEventsFor(r.changes, viewer);
  return { events, json: JSON.stringify(events) };
}

describe("filterEventFor: nessuna fuga nei delta", () => {
  const gmCommandsOnSecrets: Command[] = [
    { type: "token.move", tokenId: SECRET.hiddenOgreId, x: 455, y: 455 },
    { type: "token.update", tokenId: SECRET.hiddenOgreId, patch: { name: "AltroNome", size: 3, rotation: 90 } },
    { type: "token.update", tokenId: SECRET.hiddenOgreId, patch: { health: { current: 1, max: 2, temp: 0 } } },
    { type: "token.update", tokenId: SECRET.hiddenOgreId, patch: { conditions: [{ id: "x", name: "X" }] } },
    { type: "token.delete", tokenId: SECRET.hiddenOgreId },
    { type: "token.create", token: token("tok-new-hidden-XYZ", { hidden: true, name: "NuovoNascostoXYZ" }) },
    { type: "token.create", token: token("tok-new-prep-XYZ", { sceneId: PREP, name: "NuovoPrepXYZ" }) },
    { type: "token.move", tokenId: SECRET.prepDragonId, x: 455, y: 455 },
    { type: "token.update", tokenId: SECRET.prepDragonId, patch: { hidden: true } },
    { type: "token.delete", tokenId: SECRET.prepDragonId },
    { type: "scene.update", sceneId: PREP, patch: { name: "AncoraSegretaXYZ" } },
    { type: "scene.setGrid", sceneId: PREP, grid: { cellSize: 33 } },
    { type: "scene.delete", sceneId: PREP },
    { type: "token.update", tokenId: "tok-orc", patch: { gmNotes: "NUOVA-NOTA-XYZ" } },
    { type: "token.update", tokenId: "tok-orc", patch: { health: { current: 9, max: 9876, temp: 0 } } },
    { type: "token.update", tokenId: "tok-p2", patch: { health: { current: 9, max: 9876, temp: 0 } } },
  ];
  for (const cmd of gmCommandsOnSecrets) {
    it(`P1 non riceve nulla per ${cmd.type} ${JSON.stringify(cmd).slice(0, 70)}`, () => {
      const { events, json } = eventsJson(cmd, P1);
      expect(events).toEqual([]);
      expectNoLeak(json, [...ALWAYS_SECRET, "XYZ", "9876"]);
    });
  }

  it("nascondere un token visibile = scomparsa (solo l'id, già noto)", () => {
    const { events } = eventsJson({ type: "token.update", tokenId: "tok-orc", patch: { hidden: true } }, P1);
    expect(events).toEqual([{ type: "token.deleted", tokenId: "tok-orc" }]);
  });

  it("rivelare un token = creazione, con la vista filtrata (niente note né vita)", () => {
    const { events, json } = eventsJson({ type: "token.update", tokenId: SECRET.hiddenOgreId, patch: { hidden: false } }, P1);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("token.created");
    expect(json).not.toContain("gmNotes");
    expect(events[0]!.type === "token.created" && events[0]!.token.health).toBeNull();
  });

  it("rivelare un token a P1: P1 vede la propria vita", () => {
    const { events } = eventsJson({ type: "token.update", tokenId: SECRET.hiddenP1Id, patch: { hidden: false } }, P1);
    expect(events[0]!.type === "token.created" && events[0]!.token.health).toEqual({ current: 10, max: 10, temp: 0 });
  });

  it("cambio di vita di un token altrui: nessun evento per il giocatore, evento per il proprietario e il GM", () => {
    const cmd: Command = { type: "token.update", tokenId: "tok-p2", patch: { health: { current: 5, max: 9999, temp: 0 } } };
    expect(eventsJson(cmd, P1).events).toEqual([]);
    expect(eventsJson(cmd, P2).events).toEqual([
      { type: "token.updated", tokenId: "tok-p2", changes: { health: { current: 5, max: 9999, temp: 0 } } },
    ]);
    expect(eventsJson(cmd, GM).events).toHaveLength(1);
  });

  it("cambio misto (nome + note + vita) su token altrui: il giocatore riceve solo il nome", () => {
    const { events, json } = eventsJson(
      { type: "token.update", tokenId: "tok-orc", patch: { name: "Orco capo", gmNotes: "SEGRETO-XYZ", health: { current: 1, max: 9876, temp: 0 } } },
      P1,
    );
    expect(events).toEqual([{ type: "token.updated", tokenId: "tok-orc", changes: { name: "Orco capo" } }]);
    expectNoLeak(json, ["XYZ", "9876"]);
  });

  it("passaggio di proprietà: il nuovo proprietario riceve la vita, il vecchio la perde", () => {
    const cmd: Command = { type: "token.update", tokenId: "tok-p1", patch: { ownerUserId: "p2" } };
    const forP1 = eventsJson(cmd, P1).events;
    const forP2 = eventsJson(cmd, P2).events;
    expect(forP1).toEqual([{ type: "token.updated", tokenId: "tok-p1", changes: { ownerUserId: "p2", health: null } }]);
    expect(forP2).toEqual([
      {
        type: "token.updated",
        tokenId: "tok-p1",
        changes: { ownerUserId: "p2", health: { current: SECRET.p1Hp, max: 9999, temp: 3 } },
      },
    ]);
  });

  it("le condizioni arrivano a tutti", () => {
    const cmd: Command = { type: "token.update", tokenId: "tok-orc", patch: { conditions: [{ id: "blinded", name: "Accecato" }] } };
    for (const v of [P1, P2, GM]) expect(eventsJson(cmd, v).json).toContain("Accecato");
  });

  it("cambio di scena: il giocatore riceve la nuova scena e solo i token visibili", () => {
    let s = apply(baseState(), {
      type: "token.create",
      token: token("tok-prep-hidden-XYZ", { sceneId: PREP, hidden: true, name: "PrepNascostoXYZ" }),
    }).state;
    s = apply(s, { type: "token.update", tokenId: SECRET.prepDragonId, patch: { gmNotes: "NOTA-DRAGO-XYZ" } }).state;
    const { events, json } = eventsJson({ type: "scene.activate", sceneId: PREP }, P1, s);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe("scene.activated");
    if (e.type !== "scene.activated") return;
    expect(e.sceneId).toBe(PREP);
    expect(e.tokens.map((t) => t.id)).toEqual([SECRET.prepDragonId]);
    expectNoLeak(json, ["tok-prep-hidden-XYZ", "PrepNascostoXYZ", "NOTA-DRAGO-XYZ", SECRET.hiddenOgreId, "Taverna"]);
  });

  it("eliminare la scena attiva: il giocatore riceve solo la disattivazione", () => {
    const { events, json } = eventsJson({ type: "scene.delete", sceneId: MAIN }, P1);
    expect(events).toEqual([{ type: "scene.activated", sceneId: null, scene: null, tokens: [] }]);
    expectNoLeak(json, ALWAYS_SECRET);
  });

  it("filterEventFor su ogni cambiamento grezzo: mai id di token invisibili", () => {
    const hiddenToken = baseState().tokens.find((t) => t.id === SECRET.hiddenOgreId)!;
    const raw: StateChange[] = [
      { type: "token", before: null, after: hiddenToken, activeSceneId: MAIN },
      { type: "token", before: hiddenToken, after: null, activeSceneId: MAIN },
      { type: "token", before: hiddenToken, after: { ...hiddenToken, x: 1 }, activeSceneId: MAIN },
    ];
    for (const c of raw) expect(filterEventFor(c, P1)).toEqual([]);
  });
});

describe("i delta ricostruiscono esattamente viewFor (scenario guidato)", () => {
  it("sequenza mista", () => {
    const viewers = [GM, P1, P2];
    let s = baseState();
    const views = new Map(viewers.map((v) => [v.userId, viewFor(s, v)]));
    const script: [Command, Actor][] = [
      [{ type: "token.move", tokenId: "tok-p1", x: 455, y: 455 }, P1],
      [{ type: "token.update", tokenId: SECRET.hiddenOgreId, patch: { hidden: false } }, GM],
      [{ type: "token.update", tokenId: "tok-orc", patch: { hidden: true } }, GM],
      [{ type: "token.update", tokenId: "tok-p1", patch: { ownerUserId: "p2" } }, GM],
      [{ type: "scene.activate", sceneId: PREP }, GM],
      [{ type: "token.create", token: token("tok-z", { sceneId: PREP }) }, GM],
      [{ type: "scene.setGrid", sceneId: PREP, grid: { cellSize: 50 } }, GM],
      [{ type: "scene.activate", sceneId: MAIN }, GM],
      [{ type: "scene.update", sceneId: MAIN, patch: { width: 200, height: 200 } }, GM],
      [{ type: "scene.delete", sceneId: MAIN }, GM],
    ];
    for (const [cmd, actor] of script) {
      const r = apply(s, cmd, actor);
      s = r.state;
      for (const v of viewers) {
        const events = filterEventsFor(r.changes, v);
        const next = { ...events.reduce(applyServerEvent, views.get(v.userId)!), version: s.version };
        views.set(v.userId, next);
        const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
        const expected = viewFor(s, v);
        expect({ ...next, tokens: byId(next.tokens) }).toEqual({ ...expected, tokens: byId(expected.tokens) });
      }
    }
  });
});
