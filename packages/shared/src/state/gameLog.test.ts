import { describe, expect, it } from "vitest";
import { describeChanges } from "./gameLog.js";
import type { StateChange } from "./changes.js";
import { token } from "./fixtures.test-utils.js";

describe("frasi del registro di gioco", () => {
  it("descrive aggiunta, rimozione e modifica di un token con nomi e numeri", () => {
    const before = token("g1", { name: "Goblin", x: 0, y: 0, health: { current: 7, max: 7, temp: 0 } });
    const after = { ...before, x: 70, health: { current: 3, max: 7, temp: 0 } };
    const changes: StateChange[] = [
      { type: "token", before: null, after: before, activeSceneId: null },
      { type: "token", before, after, activeSceneId: null },
      { type: "token", before: after, after: null, activeSceneId: null },
    ];
    expect(describeChanges(changes)).toEqual([
      "Token «Goblin» aggiunto",
      "Goblin: spostato, PF 7 → 3",
      "Token «Goblin» rimosso",
    ]);
  });

  it("le notifiche private non entrano nel registro", () => {
    expect(describeChanges([{ type: "notice", notice: { kind: "rollHidden" } as never, token: null, activeSceneId: null, fog: null }])).toEqual([]);
  });
});
