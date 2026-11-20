import { describe, expect, it } from "vitest";
import { LAYOUT_KEY, readLayout, saveGeometry, viewHref, windowFeatures, windowName } from "./layout";
import { formatViewRoute, isGmOnly, parseViewRoute, viewTitle, type ViewRoute } from "./routes";
import { windowItems } from "./WindowsMenu";
import { viewFor } from "@lanterna/shared";
import { gm, luca, state } from "../table/testState";

describe("viste con URL stabili", () => {
  it("analizza e ricompone ogni vista", () => {
    const routes: ViewRoute[] = [
      { kind: "table" },
      { kind: "map" },
      { kind: "notes" },
      { kind: "chat" },
      { kind: "combat" },
      { kind: "scene", sceneId: "scn-1" },
      { kind: "player", userId: "Ab_9-x" }
    ];
    for (const r of routes) expect(parseViewRoute(formatViewRoute(r))).toEqual(r);
    expect(parseViewRoute("/")).toEqual({ kind: "table" });
  });

  it("rifiuta percorsi sconosciuti o con id non validi", () => {
    for (const p of ["/view", "/view/mappa", "/view/map/extra", "/view/scene", "/view/scene/a/b", "/view/player/..", "/view/player/a%20b", "/admin/users", `/view/scene/${"x".repeat(65)}`]) {
      expect(parseViewRoute(p), p).toBeNull();
    }
  });

  it("solo GM: scena precisa e vista giocatore; titoli in italiano", () => {
    expect(isGmOnly({ kind: "player", userId: "a" })).toBe(true);
    expect(isGmOnly({ kind: "scene", sceneId: "a" })).toBe(true);
    expect(isGmOnly({ kind: "map" })).toBe(false);
    expect(viewTitle({ kind: "player", userId: "a" }, { player: "Luca" })).toBe("Vista di Luca");
    expect(viewTitle({ kind: "scene", sceneId: "a" }, { scene: "Cripta" })).toBe("Scena: Cripta");
    expect(viewTitle({ kind: "notes" })).toBe("Schede e note");
  });
});

function memoryStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data
  };
}

describe("disposizione delle finestre", () => {
  const screen = { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 };

  it("senza disposizione salvata: dimensioni di default centrate", () => {
    expect(windowFeatures({ kind: "chat" }, undefined, screen)).toBe("popup=yes,width=440,height=780,left=740,top=150");
    // Schermo piccolo: la finestra non lo supera.
    expect(windowFeatures({ kind: "map" }, undefined, { availWidth: 1024, availHeight: 700 })).toBe("popup=yes,width=1024,height=700,left=0,top=0");
  });

  it("con disposizione salvata (anche su un secondo schermo) la riusa", () => {
    const saved = { left: 2000, top: -50, width: 1600, height: 900 };
    expect(windowFeatures({ kind: "player", userId: "a" }, saved, screen)).toBe("popup=yes,width=1600,height=900,left=2000,top=-50");
  });

  it("salva per tipo di vista e ignora dati corrotti o storage che lancia", () => {
    const st = memoryStorage();
    saveGeometry({ kind: "player", userId: "a" }, { left: 10.4, top: 20, width: 800, height: 600 }, st);
    saveGeometry({ kind: "chat" }, { left: 0, top: 0, width: 10, height: 10 }, st); // troppo piccola: ignorata
    expect(readLayout(st).geometry).toEqual({ player: { left: 10, top: 20, width: 800, height: 600 } });
    expect(readLayout(memoryStorage({ [LAYOUT_KEY]: "{non json" })).geometry).toEqual({});
    expect(readLayout(memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ geometry: { map: { left: "x" } } }) })).geometry).toEqual({});
    const broken = {
      getItem: () => {
        throw new Error("bloccato");
      },
      setItem: () => {
        throw new Error("pieno");
      }
    };
    expect(readLayout(broken).geometry).toEqual({});
    expect(() => saveGeometry({ kind: "map" }, { left: 0, top: 0, width: 800, height: 600 }, broken)).not.toThrow();
    expect(readLayout(null).geometry).toEqual({});
  });

  it("nome stabile per vista e URL nella stessa app", () => {
    expect(windowName({ kind: "player", userId: "u1" })).toBe("lanterna-view-player-u1");
    expect(windowName({ kind: "map" })).not.toBe(windowName({ kind: "chat" }));
    expect(viewHref({ kind: "scene", sceneId: "s2" }, { pathname: "/", search: "" })).toBe("/#/view/scene/s2");
    expect(viewHref({ kind: "chat" }, { pathname: "/", search: "" }, "c 1")).toBe("/#/view/chat?campaign=c%201");
  });
});

describe("menu Finestre", () => {
  it("il giocatore vede solo le viste comuni; il GM anche scene e viste giocatore", () => {
    const asPlayer = windowItems({ id: "luca", role: "player" }, viewFor(state, luca));
    expect(asPlayer.map((i) => i.route.kind)).toEqual(["map", "notes", "chat", "combat"]);
    const asGm = windowItems({ id: "gm", role: "admin" }, viewFor(state, gm));
    expect(asGm.filter((i) => i.group === "scene").map((i) => i.label)).toEqual(["Scena: Cripta (in gioco)", "Scena: Bosco"]);
    expect(asGm.filter((i) => i.group === "player").map((i) => i.label)).toEqual(["Vista di Luca", "Vista di Sara"]);
  });
});
