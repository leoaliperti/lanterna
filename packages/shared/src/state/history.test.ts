import { describe, expect, it } from "vitest";
import type { Command } from "./commands.js";
import { GM, MAIN, P1, P2, SECRET, baseState, token } from "./fixtures.test-utils.js";
import { createHistory, execute, redo, undo, type History, type HistoryResult } from "./history.js";
import type { Actor, CampaignState } from "./schema.js";

interface World {
  state: CampaignState;
  history: History;
}

function ok(r: HistoryResult): Extract<HistoryResult, { ok: true }> {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r;
}
function start(): World {
  return { state: baseState(), history: createHistory() };
}
function run(w: World, cmd: Command, actor: Actor): World {
  const r = ok(execute(w.state, w.history, cmd, actor));
  return { state: r.state, history: r.history };
}
function doUndo(w: World, actor: Actor): World {
  const r = ok(undo(w.state, w.history, actor));
  return { state: r.state, history: r.history };
}
function doRedo(w: World, actor: Actor): World {
  const r = ok(redo(w.state, w.history, actor));
  return { state: r.state, history: r.history };
}
const pos = (w: World, id: string) => {
  const t = w.state.tokens.find((x) => x.id === id);
  return t ? { x: t.x, y: t.y } : undefined;
};
const errCode = (r: HistoryResult) => (r.ok ? "ok" : r.error.code);

describe("annulla/ripeti", () => {
  it("il giocatore annulla e ripete la propria mossa", () => {
    let w = run(start(), { type: "token.move", tokenId: "tok-p1", x: 455, y: 455 }, P1);
    expect(pos(w, "tok-p1")).toEqual({ x: 455, y: 455 });
    w = doUndo(w, P1);
    expect(pos(w, "tok-p1")).toEqual({ x: 35, y: 35 });
    w = doRedo(w, P1);
    expect(pos(w, "tok-p1")).toEqual({ x: 455, y: 455 });
    w = doUndo(w, P1);
    expect(pos(w, "tok-p1")).toEqual({ x: 35, y: 35 });
  });

  it("annulla procede a ritroso su più azioni", () => {
    let w = start();
    w = run(w, { type: "token.move", tokenId: "tok-p1", x: 175, y: 175 }, P1);
    w = run(w, { type: "token.move", tokenId: "tok-p1", x: 315, y: 175 }, P1);
    w = doUndo(w, P1);
    expect(pos(w, "tok-p1")).toEqual({ x: 175, y: 175 });
    w = doUndo(w, P1);
    expect(pos(w, "tok-p1")).toEqual({ x: 35, y: 35 });
    expect(errCode(undo(w.state, w.history, P1))).toBe("NOT_FOUND");
  });

  it("il giocatore annulla solo le proprie azioni, non quelle altrui", () => {
    let w = run(start(), { type: "token.move", tokenId: "tok-p2", x: 455, y: 455 }, P2);
    expect(errCode(undo(w.state, w.history, P1))).toBe("NOT_FOUND");
    w = run(w, { type: "token.move", tokenId: "tok-orc", x: 455, y: 525 }, GM);
    // P1 non può annullare né l'azione del GM né quella di P2.
    expect(errCode(undo(w.state, w.history, P1))).toBe("NOT_FOUND");
    // P2 annulla la propria, anche se nel frattempo il GM ha agito.
    w = doUndo(w, P2);
    expect(pos(w, "tok-p2")).toEqual({ x: 175, y: 35 });
    expect(pos(w, "tok-orc")).toEqual({ x: 455, y: 525 });
  });

  it("il GM annulla qualsiasi azione (anche di un giocatore)", () => {
    let w = run(start(), { type: "token.move", tokenId: "tok-p2", x: 455, y: 455 }, P2);
    w = doUndo(w, GM);
    expect(pos(w, "tok-p2")).toEqual({ x: 175, y: 35 });
    // Il ripeti è di chi ha annullato.
    expect(errCode(redo(w.state, w.history, P2))).toBe("NOT_FOUND");
    w = doRedo(w, GM);
    expect(pos(w, "tok-p2")).toEqual({ x: 455, y: 455 });
  });

  it("annullare creazione, eliminazione, nascondimento", () => {
    let w = start();
    w = run(w, { type: "token.create", token: token("tok-new") }, GM);
    w = run(w, { type: "token.delete", tokenId: "tok-orc" }, GM);
    w = run(w, { type: "token.update", tokenId: "tok-p2", patch: { hidden: true } }, GM);
    w = doUndo(w, GM);
    expect(w.state.tokens.find((t) => t.id === "tok-p2")!.hidden).toBe(false);
    w = doUndo(w, GM);
    expect(w.state.tokens.find((t) => t.id === "tok-orc")).toEqual(baseState().tokens.find((t) => t.id === "tok-orc"));
    w = doUndo(w, GM);
    expect(w.state.tokens.find((t) => t.id === "tok-new")).toBeUndefined();
  });

  it("annullare l'eliminazione di una scena ripristina scena, token e scena attiva", () => {
    let w = run(start(), { type: "scene.delete", sceneId: MAIN }, GM);
    w = doUndo(w, GM);
    const s0 = baseState();
    expect(w.state.activeSceneId).toBe(MAIN);
    expect(new Set(w.state.tokens.map((t) => t.id))).toEqual(new Set(s0.tokens.map((t) => t.id)));
    w = doRedo(w, GM);
    expect(w.state.scenes.find((s) => s.id === MAIN)).toBeUndefined();
  });

  it("CONFLICT se qualcun altro ha cambiato lo stesso campo", () => {
    let w = run(start(), { type: "token.move", tokenId: "tok-p1", x: 455, y: 455 }, P1);
    w = run(w, { type: "token.move", tokenId: "tok-p1", x: 525, y: 525 }, GM);
    // L'ultima azione di P1 è la sua mossa, ma il GM l'ha già spostato.
    expect(errCode(undo(w.state, w.history, P1))).toBe("CONFLICT");
  });

  it("nessun conflitto se l'altra modifica tocca campi diversi", () => {
    let w = run(start(), { type: "token.move", tokenId: "tok-p1", x: 455, y: 455 }, P1);
    w = run(w, { type: "token.update", tokenId: "tok-p1", patch: { rotation: 90 } }, GM);
    w = doUndo(w, P1);
    expect(pos(w, "tok-p1")).toEqual({ x: 35, y: 35 });
    expect(w.state.tokens.find((t) => t.id === "tok-p1")!.rotation).toBe(90);
  });

  it("token nascosto nel frattempo: per il giocatore NOT_FOUND, senza rivelare nulla", () => {
    let w = run(start(), { type: "token.move", tokenId: "tok-p1", x: 455, y: 455 }, P1);
    w = run(w, { type: "token.update", tokenId: "tok-p1", patch: { hidden: true } }, GM);
    const r = undo(w.state, w.history, P1);
    expect(errCode(r)).toBe("NOT_FOUND");
    // Stesso esito se è anche stato spostato (niente CONFLICT che riveli lo spostamento).
    w = run(w, { type: "token.move", tokenId: "tok-p1", x: 595, y: 595 }, GM);
    expect(errCode(undo(w.state, w.history, P1))).toBe("NOT_FOUND");
  });

  it("proprietà persa nel frattempo: l'annullamento del giocatore è rifiutato", () => {
    let w = run(start(), { type: "token.move", tokenId: "tok-p1", x: 455, y: 455 }, P1);
    w = run(w, { type: "token.update", tokenId: "tok-p1", patch: { ownerUserId: "p2" } }, GM);
    expect(errCode(undo(w.state, w.history, P1))).toBe("FORBIDDEN");
  });

  it("una nuova azione cancella i ripeti di chi la compie, non quelli degli altri", () => {
    let w = run(start(), { type: "token.move", tokenId: "tok-p1", x: 455, y: 455 }, P1);
    w = run(w, { type: "token.move", tokenId: "tok-p2", x: 455, y: 525 }, P2);
    w = doUndo(w, P1);
    w = doUndo(w, P2);
    w = run(w, { type: "token.update", tokenId: "tok-p1", patch: { conditions: [] } }, P1);
    expect(errCode(redo(w.state, w.history, P1))).toBe("NOT_FOUND");
    w = doRedo(w, P2);
    expect(pos(w, "tok-p2")).toEqual({ x: 455, y: 525 });
  });

  it("i comandi falliti o senza effetto non entrano nella cronologia", () => {
    const w = start();
    expect(errCode(execute(w.state, w.history, { type: "token.delete", tokenId: "tok-p1" }, P1))).toBe("FORBIDDEN");
    const r = ok(execute(w.state, w.history, { type: "token.move", tokenId: "tok-p1", x: 35, y: 35 }, P1));
    expect(r.history.entries).toHaveLength(0);
  });

  it("la cronologia ha un limite", () => {
    let w: World = { state: baseState(), history: createHistory(3) };
    for (let i = 0; i < 6; i++) w = run(w, { type: "token.move", tokenId: "tok-p1", x: 35 + 70 * (i + 1), y: 35 }, P1);
    expect(w.history.entries).toHaveLength(3);
    w = doUndo(doUndo(doUndo(w, P1), P1), P1);
    expect(pos(w, "tok-p1")).toEqual({ x: 35 + 70 * 3, y: 35 });
    expect(errCode(undo(w.state, w.history, P1))).toBe("NOT_FOUND");
  });

  it("undo per id: il giocatore non può puntare voci altrui", () => {
    const w = run(start(), { type: "token.move", tokenId: "tok-orc", x: 455, y: 455 }, GM);
    const id = w.history.entries[0]!.id;
    expect(errCode(undo(w.state, w.history, P1, id))).toBe("NOT_FOUND");
    expect(errCode(undo(w.state, w.history, GM, id))).toBe("ok");
  });

  it("nessun dato segreto negli errori di annulla", () => {
    let w = run(start(), { type: "token.move", tokenId: SECRET.hiddenOgreId, x: 455, y: 455 }, GM);
    w = run(w, { type: "token.move", tokenId: "tok-p1", x: 455, y: 525 }, P1);
    w = run(w, { type: "token.update", tokenId: "tok-p1", patch: { hidden: true } }, GM);
    const json = JSON.stringify(undo(w.state, w.history, P1));
    expect(json).not.toContain(SECRET.hiddenOgreId);
    expect(json).not.toContain("tok-p1");
  });
});
