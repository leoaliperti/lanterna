import { describe, expect, it } from "vitest";
import type { CampaignView, CombatView, TokenView } from "@lanterna/shared";
import {
  addEntryCommand,
  addTokenCommand,
  dropIndex,
  movedIndex,
  parseBonus,
  parseInitiative,
  previewOrder,
  rollRequest,
  statusLine,
  tokensToAdd,
  turnTokenId,
  withoutInitiative,
  combatOf,
  formatInitiative
} from "./combatLogic";

const combat: CombatView = {
  sceneId: "s1",
  started: true,
  round: 3,
  turnId: "p2",
  participants: [
    { id: "p1", tokenId: "t1", name: "Aldo", initiative: 18 },
    { id: "p2", tokenId: "t2", name: "Goblin", initiative: 12 },
    { id: "p3", tokenId: null, name: "Trappola", initiative: null }
  ]
};

const tok = (id: string, sceneId = "s1"): TokenView => ({ id, sceneId, name: id }) as TokenView;

describe("tracker: logica pura", () => {
  it("trova il combattimento della scena", () => {
    const view = { combats: [combat] } as unknown as CampaignView;
    expect(combatOf(view, "s1")).toBe(combat);
    expect(combatOf(view, "s2")).toBeNull();
    expect(combatOf(view, null)).toBeNull();
  });

  it("propone solo i token della scena non ancora presenti", () => {
    expect(tokensToAdd([tok("t1"), tok("t2"), tok("t3"), tok("t4", "s2")], "s1", combat).map((t) => t.id)).toEqual(["t3"]);
    expect(tokensToAdd([tok("t1")], "s1", null).map((t) => t.id)).toEqual(["t1"]);
  });

  it("costruisce i comandi di aggiunta", () => {
    expect(addTokenCommand("p9", "s1", "t9")).toMatchObject({ type: "combat.add", participant: { tokenId: "t9", name: null, hidden: false } });
    expect(addEntryCommand("p9", "s1", "  Drago  ", 14)).toMatchObject({ participant: { tokenId: null, name: "Drago", initiative: 14 } });
    expect(addEntryCommand("p9", "s1", "   ", null)).toBeNull();
    expect(addEntryCommand("p9", "s1", "Segreta", 3, true)).toMatchObject({ participant: { hidden: true } });
    expect(addEntryCommand("p9", "s1", "Visibile", 3)).toMatchObject({ participant: { hidden: false } });
  });

  it("interpreta l'iniziativa scritta a mano", () => {
    expect(parseInitiative("")).toBeNull();
    expect(parseInitiative(" 15 ")).toBe(15);
    expect(parseInitiative("12,5")).toBe(12.5);
    expect(parseInitiative("-2")).toBe(-2);
    expect(parseInitiative("abc")).toBe("invalid");
    expect(parseInitiative("5000")).toBe("invalid");
    expect(formatInitiative(12.5)).toBe("12,5");
    expect(formatInitiative(null)).toBe("");
  });

  it("limita il bonus a un intero tra -50 e 50", () => {
    expect(parseBonus("")).toBe(0);
    expect(parseBonus("+3")).toBe(3);
    expect(parseBonus("2,5")).toBe("invalid");
    expect(parseBonus("99")).toBe("invalid");
  });

  it("sposta con la tastiera senza uscire dall'elenco", () => {
    expect(movedIndex(1, -1, 3)).toBe(0);
    expect(movedIndex(0, -1, 3)).toBeNull();
    expect(movedIndex(2, 1, 3)).toBeNull();
    expect(movedIndex(0, 5, 3)).toBe(2);
  });

  it("calcola dove cade il rilascio nel trascinamento", () => {
    const rows = [
      { top: 0, height: 40 },
      { top: 40, height: 40 },
      { top: 80, height: 40 }
    ];
    expect(dropIndex(rows, -20)).toBe(0);
    expect(dropIndex(rows, 55)).toBe(1);
    expect(dropIndex(rows, 500)).toBe(2);
    expect(dropIndex([], 10)).toBe(0);
    expect(previewOrder(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(previewOrder(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("prepara la richiesta di tiro: il client manda solo bonus e modo, mai l'esito", () => {
    const r = rollRequest("s1", ["p1", "p3"], { bonus: 2, mode: "advantage" }, true);
    expect(r).toEqual({
      sceneId: "s1",
      rolls: [
        { participantId: "p1", bonus: 2, mode: "advantage" },
        { participantId: "p3", bonus: 2, mode: "advantage" }
      ],
      sort: true
    });
    expect(JSON.stringify(rollRequest("s1", ["p1"], { bonus: 0, mode: "normal" }, false))).not.toContain("mode");
    expect(rollRequest("s1", [], { bonus: 0, mode: "normal" }, false)).toBeNull();
  });

  it("descrive lo stato e il turno", () => {
    expect(statusLine(combat)).toBe("Round 3, turno di Goblin");
    expect(statusLine(null)).toBe("Nessun combattimento");
    expect(statusLine({ ...combat, started: false, round: 0, turnId: null })).toBe("Non ancora iniziato");
    expect(statusLine({ ...combat, turnId: null })).toBe("Round 3");
    expect(turnTokenId(combat)).toBe("t2");
    expect(turnTokenId({ ...combat, started: false })).toBeNull();
    expect(withoutInitiative(combat).map((p) => p.id)).toEqual(["p3"]);
  });
});
