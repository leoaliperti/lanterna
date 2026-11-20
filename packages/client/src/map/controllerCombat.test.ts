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
  const h = {
    onMoveToken: vi.fn(),
    onSelectionChange: vi.fn(),
    onShape: vi.fn(),
    onShapeCancel: vi.fn(),
    onContextMenu: vi.fn(),
    onKey: vi.fn((k: string) => k === "d")
  };
  c.handlers = h;
  c.init({ x: 0, y: 0, scale: 1 }); // viewport identita': schermo = mappa
  c.setSize(1000, 800);
  c.setScene(scene(over));
  return { c, h };
}

const ptr = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({ id: 1, type: "mouse", button: 0, x, y, ...extra });

function drag(c: MapController, from: [number, number], to: [number, number]) {
  c.pointerDown(ptr(from[0], from[1]));
  c.pointerMove(ptr(to[0], to[1]));
  c.pointerUp(ptr(to[0], to[1]));
}

describe("misure e segnalazioni", () => {
  it("il cerchio mostra una bozza con il raggio in unita' di gioco e la consegna al rilascio", () => {
    const { c, h } = setup();
    c.keyDown("o");
    expect(c.tool).toBe("circle");
    c.pointerDown(ptr(200, 200));
    c.pointerMove(ptr(300, 200));
    expect(c.shapeDraft?.text).toBe("Raggio 10 piedi");
    expect(h.onShape).toHaveBeenLastCalledWith({ kind: "circle", x: 200, y: 200, radius: 100 }, "draft");
    c.pointerUp(ptr(300, 200));
    expect(h.onShape).toHaveBeenLastCalledWith({ kind: "circle", x: 200, y: 200, radius: 100 }, "end");
    expect(c.shapeDraft).not.toBeNull(); // resta visibile (misura privata) finche' non si annulla
    c.keyDown("Escape");
    expect(c.shapeDraft).toBeNull();
    expect(h.onShapeCancel).toHaveBeenCalled();
  });

  it("cono, linea e freccia producono le forme del protocollo", () => {
    const { c, h } = setup();
    c.setTool("cone");
    drag(c, [100, 100], [100, 250]);
    expect(h.onShape).toHaveBeenLastCalledWith({ kind: "cone", x: 100, y: 100, direction: 90, length: 150 }, "end");
    expect(c.shapeDraft?.text).toBe("Cono 15 piedi");
    c.setTool("line");
    expect(c.shapeDraft).toBeNull(); // cambiare strumento toglie la bozza
    drag(c, [100, 100], [400, 100]);
    expect(h.onShape).toHaveBeenLastCalledWith({ kind: "line", x1: 100, y1: 100, x2: 400, y2: 100, width: 50 }, "end");
    c.setTool("arrow");
    drag(c, [100, 100], [200, 200]);
    expect(h.onShape).toHaveBeenLastCalledWith({ kind: "arrow", x1: 100, y1: 100, x2: 200, y2: 200 }, "end");
  });

  it("il ping parte con un tocco; il righello consegna la sua forma durante e dopo il trascinamento", () => {
    const { c, h } = setup();
    c.setTool("ping");
    c.pointerDown(ptr(240, 260));
    c.pointerUp(ptr(240, 260));
    expect(h.onShape).toHaveBeenCalledExactlyOnceWith({ kind: "ping", x: 240, y: 260 }, "end");
    h.onShape.mockClear();
    c.setTool("ruler");
    c.pointerDown(ptr(120, 120));
    c.pointerMove(ptr(330, 130));
    const ruler = { kind: "ruler", points: [{ x: 125, y: 125 }, { x: 325, y: 125 }] };
    expect(h.onShape).toHaveBeenLastCalledWith(ruler, "draft");
    c.pointerUp(ptr(330, 130));
    expect(h.onShape).toHaveBeenLastCalledWith(ruler, "end");
    c.clearMeasurements();
    expect(c.ruler).toBeNull();
  });

  it("una misura consegnata altrove si toglie senza segnalare un annullamento", () => {
    const { c, h } = setup();
    c.setTool("circle");
    drag(c, [200, 200], [300, 200]);
    c.clearMeasurements();
    expect(c.shapeDraft).toBeNull();
    expect(h.onShapeCancel).not.toHaveBeenCalled();
  });

  it("le lettere non gestite arrivano a onKey (scorciatoie delle azioni)", () => {
    const { c, h } = setup();
    expect(c.keyDown("d")).toBe(true);
    expect(c.keyDown("q")).toBe(false);
    expect(h.onKey).toHaveBeenCalledTimes(2);
  });
});

describe("menu contestuale e selezione dall'esterno", () => {
  it("il tasto destro su un token lo seleziona e apre il menu; sul vuoto apre senza token", () => {
    const { c, h } = setup();
    c.pointerDown(ptr(125, 125, { button: 2 }));
    c.pointerUp(ptr(125, 125, { button: 2 }));
    expect(h.onContextMenu).toHaveBeenLastCalledWith(125, 125, "a");
    expect([...c.selection]).toEqual(["a"]);
    c.pointerDown(ptr(700, 600, { button: 2 }));
    c.pointerUp(ptr(700, 600, { button: 2 }));
    expect(h.onContextMenu).toHaveBeenLastCalledWith(700, 600, null);
  });

  it("la pressione prolungata (touch) apre il menu e non sposta ne' deseleziona", () => {
    vi.useFakeTimers();
    try {
      const { c, h } = setup();
      c.pointerDown(ptr(125, 125, { type: "touch" }));
      vi.advanceTimersByTime(600);
      expect(h.onContextMenu).toHaveBeenCalledExactlyOnceWith(125, 125, "a");
      c.pointerUp(ptr(125, 125, { type: "touch" }));
      expect(h.onMoveToken).not.toHaveBeenCalled();
      // Un tocco breve non apre nulla.
      c.pointerDown(ptr(325, 125, { id: 2, type: "touch" }));
      vi.advanceTimersByTime(200);
      c.pointerUp(ptr(325, 125, { id: 2, type: "touch" }));
      vi.advanceTimersByTime(600);
      expect(h.onContextMenu).toHaveBeenCalledTimes(1);
      // Se si trascina il menu non si apre.
      c.pointerDown(ptr(125, 125, { id: 3, type: "touch" }));
      c.pointerMove(ptr(200, 200, { id: 3, type: "touch" }));
      vi.advanceTimersByTime(600);
      c.pointerUp(ptr(200, 200, { id: 3, type: "touch" }));
      expect(h.onContextMenu).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setSelection sceglie solo token visibili al ruolo e segnala il cambio", () => {
    const { c, h } = setup({ role: "player", movableTokenIds: ["a"] });
    c.setSelection(["a", "b", "h", "inesistente"]);
    expect([...c.selection]).toEqual(["a", "b"]); // "h" e' nascosto: il giocatore non lo seleziona
    expect(h.onSelectionChange).toHaveBeenLastCalledWith(["a", "b"]);
    h.onSelectionChange.mockClear();
    c.setSelection(["b", "a"]);
    expect(h.onSelectionChange).not.toHaveBeenCalled(); // stessa selezione: niente rumore
  });
});
