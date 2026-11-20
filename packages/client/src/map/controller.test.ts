import { describe, expect, it, vi } from "vitest";
import { MapController, type PointerInput } from "./controller";
import type { MapScene, MapToken } from "./types";

const tok = (id: string, x: number, y: number, extra: Partial<MapToken> = {}): MapToken => ({ id, x, y, size: 1, rotation: 0, kind: "character", ...extra });

function scene(over: Partial<MapScene> = {}): MapScene {
  return {
    background: { url: "x.png", width: 1000, height: 800 },
    grid: { cellSize: 50, color: "#ffffff", opacity: 0.3, offsetX: 0, offsetY: 0, snap: true },
    scale: { unitsPerCell: 5, unitLabel: "piedi" },
    tokens: [tok("a", 125, 125), tok("b", 325, 125), tok("h", 525, 125, { hidden: true })],
    role: "gm",
    movableTokenIds: ["a", "b", "h"],
    ...over
  };
}

function setup(over: Partial<MapScene> = {}) {
  const c = new MapController();
  const h = { onMoveToken: vi.fn(), onResizeToken: vi.fn(), onRotateToken: vi.fn(), onSelectionChange: vi.fn(), onViewportChange: vi.fn() };
  c.handlers = h;
  c.init({ x: 0, y: 0, scale: 1 }); // viewport identita': schermo = mappa
  c.setSize(1000, 800);
  c.setScene(scene(over));
  return { c, h };
}

const ptr = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({ id: 1, type: "mouse", button: 0, x, y, ...extra });

function drag(c: MapController, from: [number, number], to: [number, number], extra: Partial<PointerInput> = {}) {
  c.pointerDown(ptr(from[0], from[1], extra));
  c.pointerMove(ptr(to[0], to[1], extra));
  c.pointerUp(ptr(to[0], to[1], extra));
}

describe("adattamento iniziale", () => {
  it("senza viewport iniziale adatta la mappa allo schermo alla prima misura", () => {
    const c = new MapController();
    c.setScene(scene());
    expect(c.viewport).toEqual({ x: 0, y: 0, scale: 1 });
    c.setSize(500, 400);
    expect(c.viewport.scale).toBeCloseTo((400 - 48) / 800);
  });
});

describe("trascinamento token", () => {
  it("mostra l'anteprima con snap e chiama onMoveToken solo al rilascio", () => {
    const { c, h } = setup();
    c.pointerDown(ptr(125, 125));
    c.pointerMove(ptr(190, 180));
    expect(h.onMoveToken).not.toHaveBeenCalled();
    expect(c.preview.get("a")).toEqual({ x: 175, y: 175 }); // 125+65=190 -> cella 3 (centro 175); 125+55=180 -> cella 3
    expect(c.previewCells).toEqual([{ x: 150, y: 150, width: 50, height: 50 }]);
    c.pointerUp(ptr(190, 180));
    expect(h.onMoveToken).toHaveBeenCalledExactlyOnceWith("a", 175, 175);
    // il canvas non modifica lo stato: l'anteprima sparisce e la scena resta quella del padre
    expect(c.preview.size).toBe(0);
    expect(c.scene?.tokens[0]).toMatchObject({ x: 125, y: 125 });
  });
  it("un semplice clic seleziona senza muovere", () => {
    const { c, h } = setup();
    drag(c, [125, 125], [126, 125]);
    expect(h.onMoveToken).not.toHaveBeenCalled();
    expect([...c.selection]).toEqual(["a"]);
    expect(h.onSelectionChange).toHaveBeenLastCalledWith(["a"]);
  });
  it("senza snap la posizione e' libera", () => {
    const { c, h } = setup({ grid: { cellSize: 50, color: "#fff", opacity: 1, offsetX: 0, offsetY: 0, snap: false } });
    drag(c, [125, 125], [141, 133]);
    expect(h.onMoveToken).toHaveBeenCalledWith("a", 141, 133);
    expect(c.previewCells).toEqual([]);
  });
  it("il giocatore non muove token che non sono suoi, ma puo' selezionarli", () => {
    const { c, h } = setup({ role: "player", movableTokenIds: ["a"] });
    drag(c, [325, 125], [425, 225]);
    expect(h.onMoveToken).not.toHaveBeenCalled();
    expect([...c.selection]).toEqual(["b"]);
    drag(c, [125, 125], [225, 225]);
    expect(h.onMoveToken).toHaveBeenCalledWith("a", 225, 225);
  });
  it("trascinando una selezione multipla muove tutti i token spostabili", () => {
    const { c, h } = setup({ movableTokenIds: ["a", "b"] });
    drag(c, [100, 100], [400, 200]); // marquee: seleziona a e b
    expect([...c.selection].sort()).toEqual(["a", "b"]);
    drag(c, [125, 125], [125, 225]);
    expect(h.onMoveToken).toHaveBeenCalledWith("a", 125, 225);
    expect(h.onMoveToken).toHaveBeenCalledWith("b", 325, 225);
  });
  it("Esc durante il trascinamento annulla senza chiamare la callback", () => {
    const { c, h } = setup();
    c.pointerDown(ptr(125, 125));
    c.pointerMove(ptr(300, 300));
    expect(c.preview.size).toBe(1);
    c.keyDown("Escape");
    c.pointerUp(ptr(300, 300));
    expect(h.onMoveToken).not.toHaveBeenCalled();
    expect(c.preview.size).toBe(0);
  });
  it("con il tocco serve una soglia piu' alta prima di spostare", () => {
    const { c } = setup();
    c.pointerDown(ptr(125, 125, { type: "touch" }));
    c.pointerMove(ptr(131, 125, { type: "touch" }));
    expect(c.preview.size).toBe(0);
    c.pointerMove(ptr(140, 125, { type: "touch" }));
    expect(c.preview.size).toBe(1);
  });
});

describe("selezione", () => {
  it("Shift aggiunge e toglie", () => {
    const { c } = setup();
    drag(c, [125, 125], [125, 125]);
    drag(c, [325, 125], [325, 125], { shift: true });
    expect([...c.selection].sort()).toEqual(["a", "b"]);
    drag(c, [125, 125], [125, 125], { ctrl: true });
    expect([...c.selection]).toEqual(["b"]);
  });
  it("clic sul vuoto deseleziona", () => {
    const { c, h } = setup();
    drag(c, [125, 125], [125, 125]);
    drag(c, [800, 600], [800, 600]);
    expect(c.selection.size).toBe(0);
    expect(h.onSelectionChange).toHaveBeenLastCalledWith([]);
  });
  it("il rettangolo seleziona e con Shift aggiunge alla selezione", () => {
    const { c, h } = setup();
    c.pointerDown(ptr(90, 90));
    c.pointerMove(ptr(160, 160));
    expect(c.marquee).toEqual({ x: 90, y: 90, width: 70, height: 70 });
    c.pointerUp(ptr(160, 160));
    expect([...c.selection]).toEqual(["a"]);
    expect(c.marquee).toBeNull();
    drag(c, [300, 90], [360, 160], { shift: true });
    expect([...c.selection].sort()).toEqual(["a", "b"]);
    expect(h.onSelectionChange).toHaveBeenLastCalledWith(expect.arrayContaining(["a", "b"]));
  });
  it("i token nascosti non sono selezionabili dai giocatori ma si dal GM", () => {
    const player = setup({ role: "player" });
    drag(player.c, [525, 125], [525, 125]);
    expect(player.c.selection.size).toBe(0);
    const gm = setup();
    drag(gm.c, [525, 125], [525, 125]);
    expect([...gm.c.selection]).toEqual(["h"]);
  });
  it("la selezione si ripulisce quando il token sparisce dalla scena", () => {
    const { c, h } = setup();
    drag(c, [125, 125], [125, 125]);
    c.setScene(scene({ tokens: [tok("b", 325, 125)] }));
    expect(c.selection.size).toBe(0);
    expect(h.onSelectionChange).toHaveBeenLastCalledWith([]);
  });
});

describe("rotazione e ridimensionamento (solo GM)", () => {
  it("le maniglie esistono solo per il GM con un token selezionato", () => {
    const gm = setup();
    expect(gm.c.handles()).toBeNull();
    drag(gm.c, [125, 125], [125, 125]);
    expect(gm.c.handles()?.tokenId).toBe("a");
    const player = setup({ role: "player" });
    drag(player.c, [125, 125], [125, 125]);
    expect(player.c.handles()).toBeNull();
  });
  it("trascinare la maniglia di rotazione ruota a passi di 15 gradi", () => {
    const { c, h } = setup();
    drag(c, [125, 125], [125, 125]);
    const rot = c.handles()!.rotate;
    drag(c, [rot.x, rot.y], [125 + 100, 125 + 2]); // a destra del centro: 90 gradi
    expect(h.onRotateToken).toHaveBeenCalledWith("a", 90);
  });
  it("trascinare la maniglia d'angolo ridimensiona a mezze celle", () => {
    const { c, h } = setup();
    drag(c, [125, 125], [125, 125]);
    const rs = c.handles()!.resize;
    drag(c, [rs.x, rs.y], [125 + 50, 125 + 50]);
    expect(h.onResizeToken).toHaveBeenCalledWith("a", 2);
  });
  it("i tasti [ ] ruotano solo per il GM", () => {
    const gm = setup();
    drag(gm.c, [125, 125], [125, 125]);
    expect(gm.c.keyDown("]")).toBe(true);
    expect(gm.h.onRotateToken).toHaveBeenCalledWith("a", 15);
    const player = setup({ role: "player" });
    drag(player.c, [125, 125], [125, 125]);
    expect(player.c.keyDown("]")).toBe(false);
    expect(player.h.onRotateToken).not.toHaveBeenCalled();
  });
});

describe("viewport", () => {
  it("la rotella zooma centrando sul cursore", () => {
    const { c } = setup();
    const before = { x: 400, y: 300 };
    c.wheel(before.x, before.y, -200);
    expect(c.viewport.scale).toBeGreaterThan(1);
    expect((before.x - c.viewport.x) / c.viewport.scale).toBeCloseTo(400);
    expect((before.y - c.viewport.y) / c.viewport.scale).toBeCloseTo(300);
  });
  it("tasto centrale e spazio+trascinamento fanno scorrere la mappa", () => {
    const { c } = setup();
    drag(c, [300, 300], [350, 340], { button: 1 });
    expect(c.viewport).toMatchObject({ x: 50, y: 40 });
    c.keyDown(" ");
    drag(c, [300, 300], [310, 300]);
    expect(c.viewport.x).toBe(60);
    c.keyUp(" ");
  });
  it("un dito sul vuoto scorre, due dita fanno pinch", () => {
    const { c } = setup();
    drag(c, [600, 600], [640, 620], { type: "touch" });
    expect(c.viewport).toMatchObject({ x: 40, y: 20 });
    const vp0 = { ...c.viewport };
    c.pointerDown(ptr(400, 400, { id: 1, type: "touch" }));
    c.pointerDown(ptr(500, 400, { id: 2, type: "touch" }));
    c.pointerMove(ptr(350, 400, { id: 1, type: "touch" })); // distanza 100 -> 150
    expect(c.viewport.scale).toBeCloseTo(1.5);
    expect(c.viewport.scale).not.toBe(vp0.scale);
    c.pointerUp(ptr(350, 400, { id: 1, type: "touch" }));
    c.pointerUp(ptr(500, 400, { id: 2, type: "touch" }));
  });
  it("notifica il cambio di viewport una volta per raffica", async () => {
    const { c, h } = setup();
    c.zoomBy(1.1);
    c.zoomBy(1.1);
    c.fit();
    await Promise.resolve();
    expect(h.onViewportChange).toHaveBeenCalledTimes(1);
  });
  it("non si puo' perdere la mappa trascinandola lontano", () => {
    const { c } = setup();
    drag(c, [0, 0], [100000, 100000], { button: 1 });
    expect(c.viewport.x).toBeLessThanOrEqual(1000 - 96);
  });
});

describe("righello", () => {
  it("misura in unita' di gioco con snap ai centri cella, solo locale", () => {
    const { c, h } = setup();
    const out = vi.fn();
    c.onRuler = out;
    c.keyDown("r");
    expect(c.tool).toBe("ruler");
    drag(c, [120, 120], [330, 130]);
    expect(c.ruler?.text).toBe("20 piedi"); // 25,25 -> 325,125: 4 celle
    expect(out).toHaveBeenLastCalledWith("20 piedi");
    expect(h.onMoveToken).not.toHaveBeenCalled();
    expect(h.onSelectionChange).not.toHaveBeenCalled();
    c.keyDown("Escape");
    expect(c.ruler).toBeNull();
    expect(out).toHaveBeenLastCalledWith(null);
  });
  it("in modalita' griglia la diagonale vale una cella", () => {
    const { c } = setup({ rulerMode: "grid" });
    c.setTool("ruler");
    drag(c, [125, 125], [325, 325]);
    expect(c.ruler?.text).toBe("20 piedi");
  });
});

describe("tastiera", () => {
  it("le frecce spostano il token selezionato di una cella, altrimenti scorrono", () => {
    const { c, h } = setup();
    drag(c, [125, 125], [125, 125]);
    c.keyDown("ArrowRight");
    expect(h.onMoveToken).toHaveBeenCalledWith("a", 175, 125);
    c.keyDown("Escape"); // deseleziona
    c.keyDown("ArrowRight");
    expect(c.viewport.x).toBeLessThan(0);
  });
  it("+, - e 0 controllano lo zoom", () => {
    const { c } = setup();
    c.keyDown("+");
    expect(c.viewport.scale).toBeCloseTo(1.25);
    c.keyDown("0");
    expect(c.viewport.scale).toBeCloseTo(Math.min(1, (800 - 48) / 800, (1000 - 48) / 1000));
  });
});
