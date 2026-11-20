import { describe, expect, it } from "vitest";
import { viewFor, type Actor } from "@lanterna/shared";
import { BLANK_BACKGROUND_URL, movableIds, sceneToShow, toMapScene, tokenColor } from "./adapter";
import { permissionsFor } from "./permissions";
import { gm, luca, sara, state } from "./testState";

const sceneFor = (actor: Actor, viewed: string | null = null) => {
  const view = viewFor(state, actor);
  const scene = sceneToShow(view, viewed)!;
  return { view, scene, map: toMapScene(view, scene) };
};

describe("adattatore stato condiviso -> props del canvas", () => {
  it("il GM vede il token nascosto (marcato hidden) e la vita di tutti", () => {
    const { map } = sceneFor(gm);
    const drago = map.tokens.find((t) => t.id === "drago");
    expect(drago).toMatchObject({ hidden: true, health: { current: 200, max: 200, temp: 0 } });
    expect(map.role).toBe("gm");
    expect(map.tokens.map((t) => t.id)).toEqual(["pg-luca", "pg-sara", "drago"]);
    expect(map.movableTokenIds).toEqual(["pg-luca", "pg-sara", "drago"]);
  });

  it("il giocatore non riceve il token nascosto e vede la vita solo del proprio", () => {
    const { map } = sceneFor(luca);
    expect(map.tokens.map((t) => t.id)).toEqual(["pg-luca", "pg-sara"]);
    expect(map.tokens.find((t) => t.id === "pg-luca")?.health).toEqual({ current: 12, max: 20, temp: 3 });
    expect(map.tokens.find((t) => t.id === "pg-sara")?.health).toBeUndefined();
    expect(map.role).toBe("player");
    expect(map.movableTokenIds).toEqual(["pg-luca"]);
    expect(JSON.stringify(map)).not.toContain("segreto del GM");
    expect(JSON.stringify(map)).not.toContain("drago");
  });

  it("le condizioni sono visibili a tutti", () => {
    const { map } = sceneFor(sara);
    expect(map.tokens.find((t) => t.id === "pg-luca")?.conditions).toEqual([{ id: "prone", label: "Prono" }]);
  });

  it("converte griglia, scala, tipo e URL degli asset (prefisso /api)", () => {
    const { map } = sceneFor(luca);
    expect(map.background).toEqual({ url: "/api/assets/aaaa.png", width: 1400, height: 1050 });
    expect(map.grid).toMatchObject({ cellSize: 70, snap: true, visible: true });
    expect(map.scale).toEqual({ unitsPerCell: 5, unitLabel: "ft" });
    const pg = map.tokens.find((t) => t.id === "pg-luca")!;
    expect(pg.kind).toBe("character");
    expect(pg.imageUrl).toBe("/api/assets/bbbb.webp");
    expect(pg.color).toBeUndefined();
    const sara = map.tokens.find((t) => t.id === "pg-sara")!;
    expect(sara.imageUrl).toBeUndefined();
    expect(sara.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("scena senza mappa: sfondo trasparente con le dimensioni della scena", () => {
    const { map } = sceneFor(gm, "s2");
    expect(map.background).toEqual({ url: BLANK_BACKGROUND_URL, width: 800, height: 600 });
    expect(map.tokens.map((t) => t.id)).toEqual(["altra-scena"]);
  });

  it("il giocatore segue sempre la scena attiva, anche se chiede un'altra", () => {
    const view = viewFor(state, luca);
    expect(sceneToShow(view, "s2")?.id).toBe("s1");
    expect(sceneToShow(viewFor({ ...state, activeSceneId: null }, luca))).toBeNull();
  });

  it("il GM con una scena scelta che non esiste piu' torna a quella attiva", () => {
    expect(sceneToShow(viewFor(state, gm), "eliminata")?.id).toBe("s1");
  });

  it("il colore e' stabile e dipende dal tipo", () => {
    expect(tokenColor({ id: "x", kind: "pc" })).toBe(tokenColor({ id: "x", kind: "pc" }));
    expect(tokenColor({ id: "x", kind: "pc" })).not.toBe(tokenColor({ id: "x", kind: "monster" }));
  });

  it("segna il token di turno, conta gli effetti e porta forme e richiami alla mappa", () => {
    const view = viewFor(state, gm);
    const scene = sceneToShow(view)!;
    const withEffects = {
      ...view,
      tokens: view.tokens.map((t) => (t.id === "drago" ? { ...t, effects: [{ id: "e1", name: "Fiamma", condition: null, remaining: 2, timing: "end" as const }] } : t))
    };
    const ephemerals = [{ key: "gm:1", shape: { kind: "ping" as const, x: 1, y: 1 }, expiresAt: 5, ttlMs: 4000 }];
    const pulses = [{ key: "k", tokenId: "pg-luca", kind: "turn" as const }];
    const map = toMapScene(withEffects, scene, { turnTokenId: "pg-sara", ephemerals, pulses });
    expect(map.tokens.find((t) => t.id === "pg-sara")?.turn).toBe(true);
    expect(map.tokens.find((t) => t.id === "pg-luca")?.turn).toBeUndefined();
    expect(map.tokens.find((t) => t.id === "drago")?.effects).toBe(1);
    expect(map.tokens.find((t) => t.id === "pg-luca")?.effects).toBeUndefined();
    expect(map.ephemerals).toBe(ephemerals);
    expect(map.pulses).toBe(pulses);
    expect("turnTokenId" in map).toBe(false);
  });

  it("movableIds: il giocatore non puo' muovere i token degli altri", () => {
    expect(movableIds(viewFor(state, sara), "s1")).toEqual(["pg-sara"]);
  });
});

describe("permessi di UX (il server resta l'autorita')", () => {
  it("il GM puo' tutto", () => {
    const view = viewFor(state, gm);
    const p = permissionsFor(view);
    const t = view.tokens.find((x) => x.id === "drago")!;
    expect(p).toMatchObject({ isGm: true, canManageScenes: true, canCreateTokens: true, canSeeGmNotes: true });
    expect(p.canMoveToken(t)).toBe(true);
    expect(p.canEditFields(t)).toEqual({ all: true, conditions: true });
  });

  it("il giocatore proprietario puo' spostare e cambiare le condizioni del proprio token, non il resto", () => {
    const view = viewFor(state, luca);
    const p = permissionsFor(view);
    const mine = view.tokens.find((x) => x.id === "pg-luca")!;
    const other = view.tokens.find((x) => x.id === "pg-sara")!;
    expect(p).toMatchObject({ isGm: false, canManageScenes: false, canCreateTokens: false, canSeeGmNotes: false });
    expect(p.canMoveToken(mine)).toBe(true);
    expect(p.canEditFields(mine)).toEqual({ all: false, conditions: true });
    expect(p.canOpenEditor(mine)).toBe(true);
    expect(p.canMoveToken(other)).toBe(false);
    expect(p.canOpenEditor(other)).toBe(false);
    expect(p.canEditFields(other)).toEqual({ all: false, conditions: false });
  });
});
