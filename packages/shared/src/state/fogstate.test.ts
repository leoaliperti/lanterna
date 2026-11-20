import { describe, expect, it } from "vitest";
import { applyServerEvent } from "../protocol/client.js";
import { deltaFor, planResync, createEventLog, appendToLog } from "../protocol/sync.js";
import type { Command } from "./commands.js";
import { filterEventsFor } from "./filter.js";
import { GM, MAIN, P1, P2, PREP, baseState, deepFreeze, expectNoLeak, rng } from "./fixtures.test-utils.js";
import { createHistory, execute, undo, redo } from "./history.js";
import { checkInvariants, withMembers } from "./invariants.js";
import { applyCommand } from "./reducer.js";
import { fogOf, type Actor, type CampaignState } from "./schema.js";
import { viewFor, type CampaignView } from "./view.js";

/**
 * Nebbia: scena 1400x1000, celle da 70 px.
 * - tok-p1 (di p1) in (35,35), tok-p2 (di p2) in (175,35), tok-orc in (315,315).
 * - A p1 si rivela la stanza in alto a sinistra (0..210 x 0..140), a p2 la zona dell'orco.
 */
const ROOM_A = { kind: "rect", x: 0, y: 0, width: 210, height: 140 } as const;
const ROOM_B = { kind: "rect", x: 280, y: 280, width: 140, height: 140 } as const;
const SECRET_WALL = "wall-segreto-XYZ";
const SECRET_X = 1234.5;

function ok(state: CampaignState, cmd: unknown, actor: Actor = GM): CampaignState {
  const r = applyCommand(state, cmd, actor);
  if (!r.ok) throw new Error(`${JSON.stringify(cmd)}: ${r.error.message}`);
  return r.state;
}

function fogged(): CampaignState {
  let s = baseState();
  s = ok(s, { type: "fog.enable", sceneId: MAIN, initial: "covered" });
  s = ok(s, { type: "fog.reveal", sceneId: MAIN, shape: ROOM_A, target: { kind: "players", userIds: ["p1"] } });
  s = ok(s, { type: "fog.reveal", sceneId: MAIN, shape: ROOM_B, target: { kind: "players", userIds: ["p2"] } });
  // Un muro nella zona coperta per tutti (x = 1234.5).
  s = ok(s, {
    type: "wall.add",
    wall: { id: SECRET_WALL, sceneId: MAIN, x1: SECRET_X, y1: 700, x2: SECRET_X, y2: 900, door: false, open: false },
  });
  // Un muro che parte dalla stanza di p1 e prosegue nel buio.
  s = ok(s, { type: "wall.add", wall: { id: "wall-bordo", sceneId: MAIN, x1: 0, y1: 140, x2: 700, y2: 140, door: true, open: false } });
  return deepFreeze(s);
}

const ids = (v: CampaignView) => v.tokens.map((t) => t.id).sort();

describe("comandi della nebbia: permessi", () => {
  const gmOnly: Command[] = [
    { type: "fog.enable", sceneId: MAIN, initial: "covered" },
    { type: "fog.disable", sceneId: MAIN },
    { type: "fog.reveal", sceneId: MAIN, shape: ROOM_A, target: { kind: "all" } },
    { type: "fog.cover", sceneId: MAIN, shape: ROOM_A, target: { kind: "all" } },
    { type: "fog.revealAll", sceneId: MAIN, target: { kind: "all" } },
    { type: "fog.coverAll", sceneId: MAIN, target: { kind: "players", userIds: ["p1"] } },
    { type: "fog.setLighting", sceneId: MAIN, lighting: "dark" },
    { type: "wall.add", wall: { id: "w1", sceneId: MAIN, x1: 0, y1: 0, x2: 10, y2: 10, door: false, open: false } },
    { type: "wall.update", wallId: SECRET_WALL, patch: { open: true } },
    { type: "wall.remove", wallId: SECRET_WALL },
  ];
  for (const cmd of gmOnly) {
    it(`${cmd.type}: FORBIDDEN per il giocatore, anche su id inesistenti`, () => {
      const s = fogged();
      for (const p of [P1, P2]) {
        const r = applyCommand(s, cmd, p);
        expect(r.ok ? null : r.error.code).toBe("FORBIDDEN");
      }
      const ghost = JSON.parse(JSON.stringify(cmd).replaceAll(MAIN, "ghost-scene").replaceAll(SECRET_WALL, "ghost")) as Command;
      const r = applyCommand(s, ghost, P1);
      expect(r.ok ? null : r.error.code).toBe("FORBIDDEN");
    });
  }

  it("destinatari: solo giocatori membri", () => {
    const s = fogged();
    for (const userIds of [["gm1"], ["stranger"], ["p1", "p1"]]) {
      const r = applyCommand(s, { type: "fog.reveal", sceneId: MAIN, shape: ROOM_A, target: { kind: "players", userIds } }, GM);
      expect(r.ok ? null : r.error.code).toBe("INVALID");
    }
  });

  it("enable due volte: CONFLICT; reveal senza nebbia: NOT_FOUND", () => {
    const s = fogged();
    const r1 = applyCommand(s, { type: "fog.enable", sceneId: MAIN, initial: "revealed" }, GM);
    expect(r1.ok ? null : r1.error.code).toBe("CONFLICT");
    const r2 = applyCommand(s, { type: "fog.revealAll", sceneId: PREP, target: { kind: "all" } }, GM);
    expect(r2.ok ? null : r2.error.code).toBe("NOT_FOUND");
  });
});

describe("viewFor con la nebbia", () => {
  it("ogni giocatore vede solo i token nelle proprie aree rivelate (e i propri)", () => {
    const s = fogged();
    expect(ids(viewFor(s, P1))).toEqual(["tok-p1", "tok-p2"]);
    expect(ids(viewFor(s, P2))).toEqual(["tok-orc", "tok-p2"]);
    expect(ids(viewFor(s, GM))).toContain("tok-orc");
    // P1 non sa nulla dell'orco né della maschera di P2.
    const j1 = JSON.stringify(viewFor(s, P1));
    expectNoLeak(j1, ["tok-orc", "Orco", '"p2","mask"', SECRET_WALL, String(SECRET_X)]);
    expect(viewFor(s, P1).fogs![0]!.players).toBeUndefined();
  });

  it("la mappa non arriva come URL ai giocatori, solo come tessere", () => {
    const s = fogged();
    const v = viewFor(s, P1);
    expect(v.scenes[0]!.map).toBeNull();
    expect(v.fogs![0]!.tiles).toMatchObject({ size: 512, cols: 3, rows: 2 });
    expectNoLeak(JSON.stringify(v), ["asset-scn-main", "scn-main.webp"]);
    expect(viewFor(s, GM).scenes.find((x) => x.id === MAIN)!.map).not.toBeNull();
  });

  it("muri: il giocatore riceve solo i pezzi nelle celle rivelate", () => {
    const s = fogged();
    const w1 = viewFor(s, P1).walls!;
    expect(w1.map((w) => w.id)).toEqual(["wall-bordo"]);
    expect(w1[0]!.segments).toEqual([0, 140, 210, 140]);
    expect(viewFor(s, P2).walls).toEqual([]);
    expect(viewFor(s, GM).walls!.length).toBe(2);
  });

  it("senza nebbia: comportamento di prima (mappa e token visibili)", () => {
    const s = baseState();
    const v = viewFor(s, P1);
    expect(v.scenes[0]!.map).not.toBeNull();
    expect(ids(v)).toEqual(["tok-orc", "tok-p1", "tok-p2"]);
    expect(v.fogs).toEqual([]);
  });

  it("revealAll per tutti e coverAll per uno", () => {
    let s = fogged();
    s = ok(s, { type: "fog.revealAll", sceneId: MAIN, target: { kind: "all" } });
    expect(ids(viewFor(s, P1))).toEqual(["tok-orc", "tok-p1", "tok-p2"]);
    s = ok(s, { type: "fog.coverAll", sceneId: MAIN, target: { kind: "players", userIds: ["p2"] } });
    expect(ids(viewFor(s, P2))).toEqual(["tok-p2"]);
    expect(ids(viewFor(s, P1))).toEqual(["tok-orc", "tok-p1", "tok-p2"]);
    // Le maschere uguali a quella di tutti non si conservano.
    expect(fogOf(s, MAIN)!.players.map((p) => p.userId)).toEqual(["p2"]);
  });

  it("il giocatore non può muovere/vedere un token sotto la nebbia: NOT_FOUND come inesistente", () => {
    let s = fogged();
    s = ok(s, { type: "token.update", tokenId: "tok-orc", patch: { ownerUserId: "p2" } });
    s = ok(s, { type: "token.update", tokenId: "tok-p2", patch: { ownerUserId: "p1" } });
    // tok-p2 ora è di p1: lo vede comunque. tok-orc è di p2, sotto la nebbia per p1.
    const r = applyCommand(s, { type: "token.move", tokenId: "tok-orc", x: 35, y: 35 }, P1);
    const r2 = applyCommand(s, { type: "token.move", tokenId: "non-esiste", x: 35, y: 35 }, P1);
    expect(r.ok ? null : r.error).toEqual(r2.ok ? null : r2.error);
  });
});

describe("filtro dei delta con la nebbia", () => {
  function replay(s0: CampaignState, cmds: unknown[], viewers: Actor[]) {
    let s = s0;
    const views = new Map(viewers.map((v) => [v.userId, viewFor(s0, v)]));
    const traffic = new Map(viewers.map((v) => [v.userId, ""]));
    for (const cmd of cmds) {
      const r = applyCommand(s, cmd, GM);
      if (!r.ok) throw new Error(r.error.message);
      for (const v of viewers) {
        const ev = filterEventsFor(r.changes, v);
        traffic.set(v.userId, traffic.get(v.userId)! + JSON.stringify(ev));
        const rebuilt = { ...ev.reduce(applyServerEvent, views.get(v.userId)!), version: r.state.version };
        const sort = (x: CampaignView) => ({ ...x, tokens: [...x.tokens].sort((a, b) => a.id.localeCompare(b.id)), walls: [...(x.walls ?? [])].sort((a, b) => a.id.localeCompare(b.id)) });
        expect(sort(rebuilt)).toEqual(sort(viewFor(r.state, v)));
        views.set(v.userId, rebuilt);
      }
      s = r.state;
    }
    return { state: s, traffic };
  }

  it("rivelare solo ad A non manda nulla di nuovo a B", () => {
    const s = fogged();
    const { traffic } = replay(
      s,
      [
        { type: "fog.reveal", sceneId: MAIN, shape: { kind: "rect", x: 1120, y: 630, width: 280, height: 350 }, target: { kind: "players", userIds: ["p1"] } },
        { type: "token.move", tokenId: "tok-orc", x: 1295, y: 805 },
      ],
      [GM, P1, P2],
    );
    expect(traffic.get("p2")).not.toContain(SECRET_WALL);
    expect(traffic.get("p2")).not.toContain("1295");
    expect(traffic.get("p2")).not.toContain("1120");
    // A riceve il muro (ritagliato) e l'orco.
    expect(traffic.get("p1")).toContain(SECRET_WALL);
    expect(traffic.get("p1")).toContain("tok-orc");
  });

  it("un token che entra nel buio sparisce, uno che esce compare; mai coordinate nel buio", () => {
    const s = fogged();
    const { traffic } = replay(
      s,
      [
        { type: "token.move", tokenId: "tok-orc", x: 1015, y: 945 },
        { type: "token.move", tokenId: "tok-orc", x: 1085, y: 875 },
        { type: "token.move", tokenId: "tok-orc", x: 105, y: 105 },
      ],
      [GM, P1, P2],
    );
    for (const p of ["p1", "p2"]) {
      expect(traffic.get(p)).not.toContain("1015");
      expect(traffic.get(p)).not.toContain("1085");
    }
  });

  it("coprire di nuovo toglie token e muri; disattivare ridà la mappa", () => {
    const s = fogged();
    replay(
      s,
      [
        { type: "fog.cover", sceneId: MAIN, shape: ROOM_A, target: { kind: "players", userIds: ["p1"] } },
        { type: "scene.update", sceneId: MAIN, patch: { width: 1500 } },
        { type: "fog.setLighting", sceneId: MAIN, lighting: "dark" },
        { type: "wall.update", wallId: "wall-bordo", patch: { open: true } },
        { type: "fog.disable", sceneId: MAIN },
        { type: "scene.activate", sceneId: PREP },
        { type: "fog.enable", sceneId: PREP, initial: "revealed" },
        { type: "scene.activate", sceneId: MAIN },
        { type: "scene.delete", sceneId: PREP },
      ],
      [GM, P1, P2],
    );
  });

  it("riconnessione: il delta dal registro dà la stessa vista dello snapshot", () => {
    const s0 = fogged();
    let s = s0;
    let log = createEventLog("e1");
    const cmds: unknown[] = [
      { type: "fog.reveal", sceneId: MAIN, shape: ROOM_B, target: { kind: "all" } },
      { type: "token.move", tokenId: "tok-orc", x: 1295, y: 805 },
      { type: "fog.cover", sceneId: MAIN, shape: ROOM_B, target: { kind: "players", userIds: ["p1"] } },
    ];
    for (const c of cmds) {
      const r = applyCommand(s, c, GM);
      if (!r.ok) throw new Error(r.error.message);
      s = r.state;
      log = appendToLog(log, s.version, r.changes);
    }
    for (const v of [P1, P2]) {
      const msg = planResync(s, log, v, { lastVersion: s0.version, epoch: "e1" });
      expect(msg.type).toBe("delta");
      if (msg.type !== "delta") continue;
      const rebuilt = { ...msg.events.reduce(applyServerEvent, viewFor(s0, v)), version: s.version };
      const sort = (x: CampaignView) => ({ ...x, tokens: [...x.tokens].sort((a, b) => a.id.localeCompare(b.id)), walls: [...(x.walls ?? [])].sort((a, b) => a.id.localeCompare(b.id)) });
      expect(sort(rebuilt)).toEqual(sort(viewFor(s, v)));
    }
    expect(deltaFor(P2, "e1", 0, 1, [])).toBeNull();
  });
});

describe("annulla/ripeti della nebbia", () => {
  it("annulla ripristina la nebbia esatta, ripeti la rifà; conflitto se cambiata", () => {
    const s0 = fogged();
    let h = createHistory();
    const r1 = execute(s0, h, { type: "fog.reveal", sceneId: MAIN, shape: ROOM_B, target: { kind: "all" } }, GM);
    if (!r1.ok) throw new Error();
    h = r1.history;
    const u = undo(r1.state, h, GM);
    if (!u.ok) throw new Error(u.error.message);
    expect(fogOf(u.state, MAIN)).toEqual(fogOf(s0, MAIN));
    const rr = redo(u.state, u.history, GM);
    if (!rr.ok) throw new Error(rr.error.message);
    expect(fogOf(rr.state, MAIN)).toEqual(fogOf(r1.state, MAIN));
    // Cambio nel frattempo (comando non registrato) => CONFLICT.
    const changed = applyCommand(rr.state, { type: "fog.setLighting", sceneId: MAIN, lighting: "dim" }, GM);
    if (!changed.ok) throw new Error();
    const c = undo(changed.state, rr.history, GM);
    expect(c.ok ? null : c.error.code).toBe("CONFLICT");
  });

  it("annullare l'eliminazione della scena ricrea nebbia e muri", () => {
    const s0 = fogged();
    const r = execute(s0, createHistory(), { type: "scene.delete", sceneId: MAIN }, GM);
    if (!r.ok) throw new Error();
    expect(r.state.walls).toEqual([]);
    expect(r.state.fogs).toEqual([]);
    const u = undo(r.state, r.history, GM);
    if (!u.ok) throw new Error(u.error.message);
    expect(fogOf(u.state, MAIN)).toEqual(fogOf(s0, MAIN));
    expect(u.state.walls).toEqual(s0.walls);
    expect(checkInvariants(u.state)).toEqual([]);
  });

  it("il giocatore non può annullare azioni del GM sulla nebbia", () => {
    const s0 = fogged();
    const r = execute(s0, createHistory(), { type: "fog.revealAll", sceneId: MAIN, target: { kind: "all" } }, GM);
    if (!r.ok) throw new Error();
    const u = undo(r.state, r.history, P1);
    expect(u.ok ? null : u.error.code).toBe("NOT_FOUND");
  });
});

describe("membri", () => {
  it("chi esce dalla campagna perde la maschera personale", () => {
    const s = fogged();
    const r = withMembers(s, s.members.filter((m) => m.userId !== "p2"));
    expect(fogOf(r.state, MAIN)!.players.map((p) => p.userId)).toEqual(["p1"]);
    expect(r.touchedFogSceneIds).toEqual([MAIN]);
    expect(checkInvariants(r.state)).toEqual([]);
  });
});

describe("fuzz mirato alla nebbia", () => {
  for (const seed of [5, 77, 4242]) {
    it(`seme ${seed}: delta = viewFor e nessuna fuga di token, muri e maschere altrui`, () => {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      const c = () => Math.floor(r() * 1400);
      let s: CampaignState = fogged();
      const viewers = [GM, P1, P2];
      const views = new Map(viewers.map((v) => [v.userId, viewFor(s, v)]));
      const sort = (x: CampaignView) => ({
        ...x,
        tokens: [...x.tokens].sort((a, b) => a.id.localeCompare(b.id)),
        walls: [...(x.walls ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
      });
      let applied = 0;
      for (let step = 0; step < 300; step++) {
        const target = pick<unknown>([{ kind: "all" }, { kind: "players", userIds: ["p1"] }, { kind: "players", userIds: ["p2"] }]);
        const cmd = pick<unknown>([
          { type: "fog.reveal", sceneId: MAIN, shape: { kind: "circle", x: c(), y: c() * 0.7, radius: 50 + r() * 200 }, target },
          { type: "fog.cover", sceneId: MAIN, shape: { kind: "rect", x: c(), y: c() * 0.7, width: r() * 300, height: r() * 300 }, target },
          { type: "token.move", tokenId: pick(["tok-orc", "tok-p1", "tok-p2"]), x: c(), y: c() * 0.7 },
          { type: "wall.add", wall: { id: `w-${step}`, sceneId: MAIN, x1: c(), y1: c() * 0.7, x2: c(), y2: c() * 0.7, door: false, open: false } },
          { type: "fog.revealAll", sceneId: MAIN, target },
          { type: "fog.coverAll", sceneId: MAIN, target },
        ]);
        const res = applyCommand(s, cmd, GM);
        if (!res.ok) continue;
        applied++;
        for (const v of viewers) {
          const ev = filterEventsFor(res.changes, v);
          const expected = viewFor(res.state, v);
          const before = views.get(v.userId)!;
          if (v.role === "player") {
            const other = v.userId === "p1" ? "p2" : "p1";
            expect(JSON.stringify(ev) + JSON.stringify(expected)).not.toContain(`"userId":"${other}","mask"`);
            // Un token o muro invisibile prima e dopo non compare negli eventi.
            const ids = [...res.state.tokens.map((t) => t.id), ...(res.state.walls ?? []).map((w) => w.id)];
            for (const id of ids) {
              const now = expected.tokens.some((x) => x.id === id) || expected.walls!.some((x) => x.id === id);
              const was = before.tokens.some((x) => x.id === id) || before.walls!.some((x) => x.id === id);
              if (!now && !was) expect(JSON.stringify(ev)).not.toContain(`"${id}"`);
            }
          }
          const rebuilt = { ...ev.reduce(applyServerEvent, before), version: res.state.version };
          expect(sort(rebuilt)).toEqual(sort(expected));
          views.set(v.userId, rebuilt);
        }
        s = res.state;
      }
      expect(checkInvariants(s)).toEqual([]);
      expect(applied).toBeGreaterThan(150);
    });
  }
});
