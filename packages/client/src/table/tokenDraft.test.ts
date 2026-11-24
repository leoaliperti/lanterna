import { describe, expect, it } from "vitest";
import { CommandSchema, type TokenView } from "@lanterna/shared";
import { createCommand, diffDraft, draftOfToken, emptyDraft, hasErrors, spawnPoint, validateDraft } from "./tokenDraft";

const baseToken = { id: "t1", sceneId: "s1", name: "Orco", imageUrl: null, x: 10, y: 10, size: 1, rotation: 0, ownerUserId: null, kind: "monster", hidden: false, conditions: [], health: null, gmNotes: "" } as unknown as TokenView;

describe("fazione del token (solo GM)", () => {
  it("la bozza parte dalla fazione attuale e la patch contiene solo il cambiamento", () => {
    const withFaction = { ...baseToken, faction: "Orda" };
    const d = draftOfToken(withFaction);
    expect(d.faction).toBe("Orda");
    expect(diffDraft(withFaction, d, null, false)).toEqual({});
    expect(diffDraft(withFaction, { ...d, faction: " Banda " }, null, false)).toEqual({ faction: "Banda" });
    // Svuotare il campo toglie la fazione.
    expect(diffDraft(withFaction, { ...d, faction: "  " }, null, false)).toEqual({ faction: null });
    // Un token senza fazione e un campo vuoto: nessuna modifica.
    expect(diffDraft(baseToken, draftOfToken(baseToken), null, false)).toEqual({});
  });

  it("il proprietario non invia mai la fazione e il comando e' valido per il server", () => {
    const d = { ...draftOfToken({ ...baseToken, faction: "Orda" }), faction: "Altra" };
    expect(diffDraft(baseToken, d, null, true)).toEqual({});
    const cmd = createCommand("n1", "s1", { ...emptyDraft(), name: "Goblin", faction: "Orda" }, null, 100, 100);
    expect(CommandSchema.safeParse(cmd).success).toBe(true);
    expect(cmd).toMatchObject({ token: { faction: "Orda" } });
    expect(JSON.stringify(createCommand("n2", "s1", { ...emptyDraft(), name: "Goblin" }, null, 1, 1))).not.toContain("faction");
    expect(hasErrors(validateDraft({ ...emptyDraft(), name: "x", faction: "a".repeat(80) }))).toBe(true);
  });
});

const scene = { width: 1400, height: 1000, grid: { cellSize: 70, offsetX: 0, offsetY: 0 } };

describe("spawnPoint", () => {
  it("senza token intorno sceglie il centro della scena, sul centro cella", () => {
    expect(spawnPoint(scene, 1)).toEqual({ x: 735, y: 525 });
  });

  it("se il centro è occupato sceglie una cella vicina libera", () => {
    const first = spawnPoint(scene, 1);
    const second = spawnPoint(scene, 1, [first]);
    expect(second).not.toEqual(first);
    expect(Math.max(Math.abs(second.x - first.x), Math.abs(second.y - first.y))).toBe(70);
  });

  it("più token nuovi di fila non si sovrappongono mai", () => {
    const taken: { x: number; y: number }[] = [];
    for (let i = 0; i < 20; i++) taken.push(spawnPoint(scene, 1, taken));
    const keys = new Set(taken.map((t) => `${t.x},${t.y}`));
    expect(keys.size).toBe(20);
  });
});
