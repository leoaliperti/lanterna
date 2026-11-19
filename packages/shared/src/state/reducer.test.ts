import { describe, expect, it } from "vitest";
import type { Command } from "./commands.js";
import { GM, MAIN, P1, PREP, SECRET, baseState, deepFreeze, scene, token } from "./fixtures.test-utils.js";
import { gridDistance, normalizeRotation, snapToGrid } from "./grid.js";
import { checkInvariants } from "./invariants.js";
import { applyCommand, applyCommands, type ApplyResult } from "./reducer.js";
import { DEFAULT_GRID, createCampaignState, resolveActor, type CampaignState } from "./schema.js";

function ok(r: ApplyResult): Extract<ApplyResult, { ok: true }> {
  if (!r.ok) throw new Error(`atteso ok, ricevuto ${r.error.code}: ${r.error.message}`);
  return r;
}
function code(r: ApplyResult): string {
  return r.ok ? "ok" : r.error.code;
}
const tok = (s: CampaignState, id: string) => s.tokens.find((t) => t.id === id);

describe("griglia", () => {
  const grid = { ...DEFAULT_GRID, cellSize: 70 };
  it("token di lato 1 al centro della cella", () => {
    expect(snapToGrid(100, 10, 1, grid)).toEqual({ x: 105, y: 35 });
  });
  it("token di lato 2 sull'incrocio", () => {
    expect(snapToGrid(130, 75, 2, grid)).toEqual({ x: 140, y: 70 });
  });
  it("token di lato 3 al centro della cella", () => {
    expect(snapToGrid(100, 100, 3, grid)).toEqual({ x: 105, y: 105 });
  });
  it("rispetta l'offset", () => {
    expect(snapToGrid(100, 100, 1, { ...grid, offsetX: 10, offsetY: -10 })).toEqual({ x: 115, y: 95 });
  });
  it("distanza in unità di gioco (5 ft per cella, diagonale 5e)", () => {
    expect(gridDistance({ x: 35, y: 35 }, { x: 315, y: 175 }, grid, { unitsPerCell: 5, unit: "ft" })).toBe(20);
  });
  it("normalizza la rotazione", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(720)).toBe(0);
    expect(normalizeRotation(-0)).toBe(0);
    expect(normalizeRotation(359.5)).toBe(359.5);
  });
});

describe("token.move", () => {
  it("aggancia alla griglia, incrementa la versione e produce l'inverso", () => {
    const s = deepFreeze(baseState());
    const r = ok(applyCommand(s, { type: "token.move", tokenId: "tok-p1", x: 250, y: 260 }, P1));
    expect(tok(r.state, "tok-p1")).toMatchObject({ x: 245, y: 245 });
    expect(r.state.version).toBe(1);
    expect(r.inverse).toEqual([{ type: "token.move", tokenId: "tok-p1", x: 35, y: 35, snap: false }]);
    expect(r.changes).toHaveLength(1);
  });
  it("snap: false lascia la posizione libera", () => {
    const r = ok(applyCommand(baseState(), { type: "token.move", tokenId: "tok-p1", x: 250.5, y: 260 , snap: false }, P1));
    expect(tok(r.state, "tok-p1")).toMatchObject({ x: 250.5, y: 260 });
  });
  it("senza snap sulla scena la posizione è libera", () => {
    const s0 = ok(applyCommand(baseState(), { type: "scene.setGrid", sceneId: MAIN, grid: { snap: false } }, GM)).state;
    const r = ok(applyCommand(s0, { type: "token.move", tokenId: "tok-p1", x: 250, y: 260 }, P1));
    expect(tok(r.state, "tok-p1")).toMatchObject({ x: 250, y: 260 });
  });
  it("lo snap vicino al bordo resta dentro la mappa", () => {
    const r = ok(applyCommand(baseState(), { type: "token.move", tokenId: "tok-p1", x: 1400, y: 1000 }, P1));
    const t = tok(r.state, "tok-p1");
    expect(t!.x).toBeLessThanOrEqual(1400);
    expect(t!.y).toBeLessThanOrEqual(1000);
    expect(checkInvariants(r.state)).toEqual([]);
  });
  it("una mossa senza effetto non cambia versione né produce eventi", () => {
    const s = baseState();
    const r = ok(applyCommand(s, { type: "token.move", tokenId: "tok-p1", x: 35, y: 35 }, P1));
    expect(r.state).toBe(s);
    expect(r.changes).toEqual([]);
  });
  for (const [x, y] of [
    [-1, 10],
    [10, -0.001],
    [1400.01, 10],
    [10, 1000.5],
    [Number.NaN, 10],
    [Number.POSITIVE_INFINITY, 10],
    [10, Number.NEGATIVE_INFINITY],
    [1e308, 1e308],
  ]) {
    it(`rifiuta coordinate non valide (${x}, ${y})`, () => {
      expect(code(applyCommand(baseState(), { type: "token.move", tokenId: "tok-p1", x: x!, y: y! }, P1))).toBe("INVALID");
    });
  }
  it("rifiuta coordinate come stringhe", () => {
    expect(code(applyCommand(baseState(), { type: "token.move", tokenId: "tok-p1", x: "10", y: 10 }, P1))).toBe("INVALID");
  });
});

describe("validazione dei comandi", () => {
  const bad: unknown[] = [
    null,
    undefined,
    42,
    "token.move",
    {},
    { type: "boh" },
    { type: "token.move" },
    { type: "token.move", tokenId: "tok-p1", x: 1, y: 1, extra: true },
    { type: "token.move", tokenId: "../etc", x: 1, y: 1 },
    { type: "token.move", tokenId: "a".repeat(65), x: 1, y: 1 },
    { type: "token.update", tokenId: "tok-p1", patch: {} },
    { type: "token.update", tokenId: "tok-p1", patch: { x: 5 } },
    { type: "token.update", tokenId: "tok-p1", patch: { sceneId: PREP } },
    { type: "token.update", tokenId: "tok-p1", patch: { size: 0 } },
    { type: "token.update", tokenId: "tok-p1", patch: { size: 1000 } },
    { type: "token.update", tokenId: "tok-p1", patch: { size: Number.NaN } },
    { type: "token.update", tokenId: "tok-p1", patch: { rotation: Number.POSITIVE_INFINITY } },
    { type: "token.update", tokenId: "tok-p1", patch: { health: { current: 11, max: 10, temp: 0 } } },
    { type: "token.update", tokenId: "tok-p1", patch: { health: { current: -1, max: 10, temp: 0 } } },
    { type: "token.update", tokenId: "tok-p1", patch: { health: { current: 1.5, max: 10, temp: 0 } } },
    { type: "token.update", tokenId: "tok-p1", patch: { name: "" } },
    { type: "token.update", tokenId: "tok-p1", patch: { name: "   " } },
    { type: "token.update", tokenId: "tok-p1", patch: { imageUrl: "javascript:alert(1)" } },
    { type: "token.update", tokenId: "tok-p1", patch: { imageUrl: "data:image/png;base64,AAA" } },
    { type: "token.update", tokenId: "tok-p1", patch: { kind: "dragon" } },
    {
      type: "token.update",
      tokenId: "tok-p1",
      patch: { conditions: [{ id: "a", name: "A" }, { id: "a", name: "B" }] },
    },
    JSON.parse('{"type":"token.update","tokenId":"tok-p1","patch":{"__proto__":{"hidden":true}}}'),
    JSON.parse('{"type":"token.move","tokenId":"tok-p1","x":1,"y":1,"__proto__":{"snap":false}}'),
    { type: "scene.setGrid", sceneId: MAIN, grid: { cellSize: 1 } },
    { type: "scene.setGrid", sceneId: MAIN, grid: { opacity: 2 } },
    { type: "scene.setGrid", sceneId: MAIN, grid: { color: "red" } },
    { type: "scene.setGrid", sceneId: MAIN, grid: { offsetX: 70 } },
    { type: "scene.update", sceneId: MAIN, patch: { width: 0 } },
    { type: "scene.update", sceneId: MAIN, patch: { width: 1.5 } },
    { type: "scene.update", sceneId: MAIN, patch: { height: 100_000 } },
    { type: "scene.update", sceneId: MAIN, patch: { scale: { unitsPerCell: 0, unit: "ft" } } },
    { type: "scene.create", scene: { ...scene("x"), width: -5 } },
    { type: "token.create", token: { ...token("t"), rotation: 360 } },
  ];
  for (const [i, cmd] of bad.entries()) {
    it(`INVALID #${i}: ${JSON.stringify(cmd)?.slice(0, 80)}`, () => {
      expect(code(applyCommand(baseState(), cmd, GM))).toBe("INVALID");
    });
  }
  it("offset della griglia valido rispetto alla nuova cella", () => {
    const r = applyCommand(baseState(), { type: "scene.setGrid", sceneId: MAIN, grid: { offsetX: 60, cellSize: 50 } }, GM);
    expect(code(r)).toBe("INVALID");
  });
});

describe("token.create / token.delete", () => {
  it("crea e l'inverso elimina", () => {
    const r = ok(applyCommand(baseState(), { type: "token.create", token: token("tok-new", { rotation: 0 }) }, GM));
    expect(tok(r.state, "tok-new")).toBeDefined();
    expect(r.inverse).toEqual([{ type: "token.delete", tokenId: "tok-new" }]);
  });
  it("id duplicato -> CONFLICT", () => {
    expect(code(applyCommand(baseState(), { type: "token.create", token: token("tok-orc") }, GM))).toBe("CONFLICT");
  });
  it("scena inesistente -> NOT_FOUND", () => {
    expect(code(applyCommand(baseState(), { type: "token.create", token: token("t9", { sceneId: "nope" }) }, GM))).toBe("NOT_FOUND");
  });
  it("fuori mappa -> INVALID", () => {
    expect(code(applyCommand(baseState(), { type: "token.create", token: token("t9", { x: 5000 }) }, GM))).toBe("INVALID");
  });
  it("proprietario non membro -> INVALID", () => {
    expect(code(applyCommand(baseState(), { type: "token.create", token: token("t9", { ownerUserId: "ghost" }) }, GM))).toBe("INVALID");
    expect(code(applyCommand(baseState(), { type: "token.update", tokenId: "tok-orc", patch: { ownerUserId: "ghost" } }, GM))).toBe("INVALID");
  });
  it("elimina e l'inverso ricrea identico", () => {
    const s = baseState();
    const r = ok(applyCommand(s, { type: "token.delete", tokenId: "tok-orc" }, GM));
    expect(tok(r.state, "tok-orc")).toBeUndefined();
    const back = ok(applyCommands(r.state, r.inverse, GM));
    expect(tok(back.state, "tok-orc")).toEqual(tok(s, "tok-orc"));
  });
});

describe("token.update", () => {
  it("il proprietario aggiorna le proprie condizioni", () => {
    const r = ok(
      applyCommand(baseState(), { type: "token.update", tokenId: "tok-p1", patch: { conditions: [] } }, P1),
    );
    expect(tok(r.state, "tok-p1")!.conditions).toEqual([]);
    expect(r.inverse).toEqual([
      { type: "token.update", tokenId: "tok-p1", patch: { conditions: [{ id: "poisoned", name: "Avvelenato" }] } },
    ]);
  });
  it("normalizza la rotazione", () => {
    const r = ok(applyCommand(baseState(), { type: "token.update", tokenId: "tok-orc", patch: { rotation: -45 } }, GM));
    expect(tok(r.state, "tok-orc")!.rotation).toBe(315);
  });
  it("non muta lo stato in ingresso", () => {
    const s = deepFreeze(baseState());
    const before = JSON.stringify(s);
    ok(applyCommand(s, { type: "token.update", tokenId: "tok-orc", patch: { name: "Orco capo", size: 2 } }, GM));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("scene", () => {
  it("setGrid fonde la patch e l'inverso ripristina la griglia completa", () => {
    const s = baseState();
    const r = ok(applyCommand(s, { type: "scene.setGrid", sceneId: MAIN, grid: { cellSize: 50, color: "#ff0000" } }, GM));
    expect(r.state.scenes[0]!.grid).toMatchObject({ cellSize: 50, color: "#ff0000", opacity: DEFAULT_GRID.opacity });
    const back = ok(applyCommands(r.state, r.inverse, GM));
    expect(back.state.scenes[0]!.grid).toEqual(s.scenes[0]!.grid);
  });
  it("rimpicciolire la mappa riporta dentro i token e l'inverso li rimette dov'erano", () => {
    const s = baseState();
    const r = ok(applyCommand(s, { type: "scene.update", sceneId: MAIN, patch: { width: 300, height: 300 } }, GM));
    expect(checkInvariants(r.state)).toEqual([]);
    expect(tok(r.state, "tok-orc")).toMatchObject({ x: 300, y: 300 });
    const back = ok(applyCommands(r.state, r.inverse, GM));
    expect(back.state.tokens).toEqual(s.tokens);
    expect(back.state.scenes).toEqual(s.scenes);
  });
  it("eliminare la scena attiva elimina i suoi token e disattiva la scena", () => {
    const s = baseState();
    const r = ok(applyCommand(s, { type: "scene.delete", sceneId: MAIN }, GM));
    expect(r.state.activeSceneId).toBeNull();
    expect(r.state.tokens.every((t) => t.sceneId !== MAIN)).toBe(true);
    expect(r.changes[0]!.type).toBe("activeScene");
    expect(checkInvariants(r.state)).toEqual([]);
    const back = ok(applyCommands(r.state, r.inverse, GM));
    expect(back.state.activeSceneId).toBe(MAIN);
    expect(new Set(back.state.tokens.map((t) => t.id))).toEqual(new Set(s.tokens.map((t) => t.id)));
  });
  it("activate su scena inesistente -> NOT_FOUND, scena duplicata -> CONFLICT", () => {
    expect(code(applyCommand(baseState(), { type: "scene.activate", sceneId: "zzz" }, GM))).toBe("NOT_FOUND");
    expect(code(applyCommand(baseState(), { type: "scene.create", scene: scene(PREP) }, GM))).toBe("CONFLICT");
  });
});

describe("applyCommands è atomico", () => {
  it("se un comando fallisce lo stato non cambia", () => {
    const s = baseState();
    const cmds: Command[] = [
      { type: "token.move", tokenId: "tok-orc", x: 455, y: 455 },
      { type: "token.move", tokenId: "nope", x: 455, y: 455 },
    ];
    expect(code(applyCommands(s, cmds, GM))).toBe("NOT_FOUND");
    expect(tok(s, "tok-orc")!.x).toBe(315);
  });
  it("una sequenza riuscita conta come una sola versione", () => {
    const r = ok(
      applyCommands(
        baseState(),
        [
          { type: "token.move", tokenId: "tok-orc", x: 455, y: 455 },
          { type: "token.update", tokenId: "tok-orc", patch: { size: 2 } },
        ],
        GM,
      ),
    );
    expect(r.state.version).toBe(1);
  });
});

describe("utilità di stato", () => {
  it("createCampaignState e resolveActor", () => {
    const s = createCampaignState("c1", "Nuova", [{ userId: "u1", displayName: "U", role: "admin" }]);
    expect(s.version).toBe(0);
    expect(resolveActor(s, "u1")).toEqual({ userId: "u1", role: "admin" });
    expect(resolveActor(s, "u2")).toBeNull();
  });
  it("lo stato di riferimento rispetta gli invarianti", () => {
    expect(checkInvariants(baseState())).toEqual([]);
    expect(SECRET.hiddenOgreId).toBeTruthy();
  });
  it("checkInvariants trova le violazioni", () => {
    const s = baseState();
    const broken: CampaignState = {
      ...s,
      activeSceneId: "manca",
      tokens: [...s.tokens, { ...s.tokens[0]!, x: 99999 }, { ...s.tokens[1]!, id: "t-x", sceneId: "manca", ownerUserId: "ghost" }],
    };
    const problems = checkInvariants(broken);
    expect(problems.some((p) => p.includes("duplicato"))).toBe(true);
    expect(problems.some((p) => p.includes("fuori mappa"))).toBe(true);
    expect(problems.some((p) => p.includes("senza scena"))).toBe(true);
    expect(problems.some((p) => p.includes("proprietario"))).toBe(true);
    expect(problems.some((p) => p.includes("scena attiva"))).toBe(true);
  });
});
