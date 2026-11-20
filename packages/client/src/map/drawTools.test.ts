import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FogShape, WallPatch } from "@lanterna/shared";
import { MapController, type PointerInput } from "./controller";
import type { FogMode } from "../fog/fogLogic";
import type { MapScene, MapWall, Point } from "./types";

/** Pennelli della nebbia e muri: dal puntatore ai comandi (callback), senza DOM ne' Pixi. */

const CELL = 70;
const base = (over: Partial<MapScene> = {}): MapScene => ({
  background: { url: "x", width: 1400, height: 1000 },
  grid: { cellSize: CELL, color: "#fff", opacity: 0.3, offsetX: 0, offsetY: 0, snap: true },
  scale: { unitsPerCell: 5, unitLabel: "ft" },
  tokens: [],
  role: "gm",
  movableTokenIds: [],
  fog: { sceneId: "s", geometry: { cellSize: CELL, offsetX: 0, offsetY: 0 }, mask: { base: "covered", runs: [] }, opaque: false, tiles: [] },
  walls: [],
  ...over
});

let c: MapController;
const shapes: Array<{ shape: FogShape; mode: FogMode }> = [];
const added: Array<{ a: Point; b: Point; door: boolean }> = [];
const updates: Array<{ id: string; patch: WallPatch }> = [];
const removed: string[] = [];
const selected: Array<string | null> = [];
let nextId = 1;

const ev = (x: number, y: number, over: Partial<PointerInput> = {}): PointerInput => ({ id: 1, type: "mouse", button: 0, x, y, ...over });
const drag = (from: [number, number], to: [number, number], over: Partial<PointerInput> = {}) => {
  c.pointerDown(ev(from[0], from[1], over));
  c.pointerMove(ev((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, over));
  c.pointerMove(ev(to[0], to[1], over));
  c.pointerUp(ev(to[0], to[1], over));
};
const click = (x: number, y: number, over: Partial<PointerInput> = {}) => {
  c.pointerDown(ev(x, y, over));
  c.pointerUp(ev(x, y, over));
};

beforeEach(() => {
  shapes.length = added.length = updates.length = removed.length = selected.length = 0;
  nextId = 1;
  c = new MapController();
  c.init({ x: 0, y: 0, scale: 1 });
  c.setSize(1400, 1000);
  c.handlers = {
    onFogShape: (shape, mode) => shapes.push({ shape, mode }),
    onWallAdd: (a, b, door) => added.push({ a, b, door }),
    onWallUpdate: (id, patch) => updates.push({ id, patch }),
    onWallRemove: (id) => removed.push(id),
    onWallSelect: (id) => selected.push(id)
  };
  c.setScene(base());
  void nextId;
});

describe("strumenti: accesso e tastiera", () => {
  it("il giocatore non puo' usare i pennelli ne' i muri", () => {
    c.setScene(base({ role: "player" }));
    c.setTool("fog");
    c.setTool("wall");
    expect(c.tool).toBe("select");
    expect(c.keyDown("n")).toBe(false);
    expect(c.keyDown("w")).toBe(false);
  });
  it("N attiva/disattiva la nebbia, W i muri, V torna alla selezione; senza nebbia N non fa nulla", () => {
    expect(c.keyDown("n")).toBe(true);
    expect(c.tool).toBe("fog");
    expect(c.keyDown("N")).toBe(true);
    expect(c.tool).toBe("select");
    expect(c.keyDown("w")).toBe(true);
    expect(c.tool).toBe("wall");
    expect(c.keyDown("v")).toBe(true);
    expect(c.tool).toBe("select");
    c.setScene(base({ fog: null }));
    expect(c.keyDown("n")).toBe(false);
    expect(c.tool).toBe("select");
  });
  it("1-4 scelgono il pennello, X inverte rivela/copri; ogni cambio avvisa la barra", () => {
    const states: string[] = [];
    c.onToolState = (s) => states.push(`${s.tool}:${s.fogBrush}:${s.fogMode}`);
    c.keyDown("n");
    c.keyDown("3");
    c.keyDown("x");
    c.keyDown("4");
    expect(c.draw.fogBrush).toBe("cells");
    expect(c.draw.fogMode).toBe("cover");
    expect(states.at(-1)).toBe("fog:cells:cover");
  });
  it("togliere la nebbia dalla scena riporta alla selezione", () => {
    c.keyDown("n");
    c.setScene(base({ fog: null }));
    expect(c.tool).toBe("select");
  });
  it("Esc: prima annulla il disegno, poi esce dallo strumento", () => {
    c.keyDown("n");
    c.keyDown("3");
    click(100, 100);
    expect(c.draw.fogPreview?.vertices).toHaveLength(1);
    c.keyDown("Escape");
    expect(c.draw.fogPreview).toBeNull();
    expect(c.tool).toBe("fog");
    c.keyDown("Escape");
    expect(c.tool).toBe("select");
  });
});

describe("pennelli della nebbia -> forme", () => {
  beforeEach(() => c.keyDown("n"));

  it("rettangolo: trascinamento agganciato alla griglia, con anteprima prima del rilascio", () => {
    c.pointerDown(ev(10, 10));
    c.pointerMove(ev(200, 140));
    expect(c.draw.fogPreview?.runs).toEqual([0, 0, 3, 1, 0, 3]); // 3 colonne x 2 righe
    expect(shapes).toHaveLength(0); // niente prima del rilascio
    c.pointerUp(ev(200, 140));
    expect(shapes).toEqual([{ shape: { kind: "rect", x: 0, y: 0, width: 210, height: 140 }, mode: "reveal" }]);
    expect(c.draw.fogPreview).toBeNull();
  });
  it("un clic rivela subito la cella cliccata (rivelazione immediata)", () => {
    click(150, 220);
    expect(shapes).toEqual([{ shape: { kind: "cells", cells: [2, 3] }, mode: "reveal" }]);
  });
  it("X cambia in 'copri' e il modo arriva con la forma", () => {
    c.keyDown("x");
    drag([0, 0], [140, 140]);
    expect(shapes[0]!.mode).toBe("cover");
  });
  it("cerchio: centro al centro cella e raggio a mezzi passi", () => {
    c.keyDown("2");
    drag([100, 100], [210, 105]);
    expect(shapes[0]!.shape).toEqual({ kind: "circle", x: 105, y: 105, radius: 105 });
  });
  it("celle: il trascinamento accumula le celle toccate", () => {
    c.keyDown("4");
    drag([10, 10], [220, 10]);
    expect(shapes[0]!.shape).toEqual({ kind: "cells", cells: [0, 0, 1, 0, 2, 0, 3, 0] });
  });
  it("Alt: rettangolo libero, senza aggancio", () => {
    drag([13, 17], [150, 90], { alt: true });
    expect(shapes[0]!.shape).toEqual({ kind: "rect", x: 13, y: 17, width: 137, height: 73 });
  });
  it("poligono: un clic per vertice, chiusura sul primo punto", () => {
    c.keyDown("3");
    click(0, 0);
    click(210, 0);
    click(210, 140);
    c.pointerMove(ev(100, 100));
    expect(c.draw.fogPreview?.vertices).toHaveLength(3);
    expect(c.draw.fogPreview?.cursor).toBeTruthy();
    expect(shapes).toHaveLength(0);
    click(2, 2); // vicino al primo vertice: chiude
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.shape).toEqual({ kind: "polygon", points: [0, 0, 210, 0, 210, 140] });
  });
  it("poligono: Invio chiude, Backspace toglie l'ultimo vertice, meno di tre vertici non produce nulla", () => {
    c.keyDown("3");
    click(0, 0);
    click(70, 0);
    c.keyDown("Enter");
    expect(shapes).toHaveLength(0);
    click(0, 0);
    click(70, 0);
    click(70, 70);
    click(140, 140);
    c.keyDown("Backspace");
    expect(c.draw.fogPreview?.vertices).toHaveLength(3);
    c.keyDown("Enter");
    expect(shapes[0]!.shape).toEqual({ kind: "polygon", points: [0, 0, 70, 0, 70, 70] });
  });
  it("Esc a meta' trascinamento annulla senza inviare nulla", () => {
    c.pointerDown(ev(10, 10));
    c.pointerMove(ev(300, 300));
    c.keyDown("Escape");
    c.pointerUp(ev(300, 300));
    expect(shapes).toHaveLength(0);
    expect(c.draw.fogPreview).toBeNull();
  });
});

describe("muri e porte", () => {
  const wall = (id: string, x1: number, y1: number, x2: number, y2: number, door = false, open = false): MapWall => ({ id, door, open, segments: [x1, y1, x2, y2] });
  beforeEach(() => c.keyDown("w"));

  it("trascinamento: segmento agganciato agli incroci", () => {
    drag([68, 72], [213, 3]);
    expect(added).toEqual([{ a: { x: 70, y: 70 }, b: { x: 210, y: 0 }, door: false }]);
  });
  it("Alt: senza aggancio; fuori mappa si limita al bordo", () => {
    drag([13, 17], [1500, 17], { alt: true });
    expect(added[0]).toEqual({ a: { x: 13, y: 17 }, b: { x: 1400, y: 17 }, door: false });
  });
  it("clic dopo clic: catena di segmenti, Invio la termina", () => {
    click(0, 0);
    click(140, 0);
    click(140, 140);
    expect(added.map((s) => [s.a, s.b])).toEqual([
      [{ x: 0, y: 0 }, { x: 140, y: 0 }],
      [{ x: 140, y: 0 }, { x: 140, y: 140 }]
    ]);
    c.keyDown("Enter");
    click(500, 500); // nuova catena: un clic solo non crea nulla
    expect(added).toHaveLength(2);
  });
  it("un segmento di lunghezza nulla non parte", () => {
    drag([70, 70], [72, 71]);
    expect(added).toHaveLength(0);
  });
  it("modo porta (2): disegna una porta; un clic su una porta esistente la apre", () => {
    c.keyDown("2");
    drag([0, 0], [140, 0]);
    expect(added[0]!.door).toBe(true);
    c.setScene(base({ walls: [wall("d", 0, 0, 140, 0, true, false)] }));
    click(70, 2);
    expect(updates).toEqual([{ id: "d", patch: { open: true } }]);
    c.setScene(base({ walls: [wall("d", 0, 0, 140, 0, true, true)] }));
    click(70, 2);
    expect(updates[1]).toEqual({ id: "d", patch: { open: false } });
  });
  it("con lo strumento di selezione un clic su una porta la apre/chiude (solo GM, non i muri)", () => {
    c.setScene(base({ walls: [wall("m", 0, 0, 140, 0), wall("d", 0, 200, 140, 200, true)] }));
    c.keyDown("v");
    click(70, 1);
    expect(updates).toHaveLength(0);
    click(70, 201);
    expect(updates).toEqual([{ id: "d", patch: { open: true } }]);
    c.setScene(base({ role: "player", walls: [wall("d", 0, 200, 140, 200, true)] }));
    click(70, 201);
    expect(updates).toHaveLength(1);
  });
  it("modifica (3): seleziona, sposta un estremo agganciato, Canc elimina", () => {
    c.setScene(base({ walls: [wall("m", 0, 0, 140, 0)] }));
    c.keyDown("3");
    click(70, 2);
    expect(selected).toEqual(["m"]);
    expect(c.draw.selectedWall).toBe("m");
    drag([140, 0], [213, 142]);
    expect(updates).toEqual([{ id: "m", patch: { x1: 0, y1: 0, x2: 210, y2: 140 } }]);
    c.keyDown("Delete");
    expect(removed).toEqual(["m"]);
    expect(c.draw.selectedWall).toBeNull();
  });
  it("modifica: un clic sul vuoto deseleziona; il muro cancellato altrove sparisce dalla selezione", () => {
    c.setScene(base({ walls: [wall("m", 0, 0, 140, 0)] }));
    c.keyDown("3");
    click(70, 2);
    click(600, 600);
    expect(selected).toEqual(["m", null]);
    click(70, 2);
    c.setScene(base({ walls: [] }));
    expect(c.draw.selectedWall).toBeNull();
  });
  it("elimina (4): un clic sul muro lo rimuove, uno sul vuoto no", () => {
    c.setScene(base({ walls: [wall("m", 0, 0, 140, 0)] }));
    c.keyDown("4");
    click(600, 600);
    expect(removed).toHaveLength(0);
    click(70, 3);
    expect(removed).toEqual(["m"]);
  });
  it("lo spostamento di un estremo sullo stesso punto o sull'altro estremo non produce comandi", () => {
    c.setScene(base({ walls: [wall("m", 0, 0, 140, 0)] }));
    c.keyDown("3");
    drag([140, 0], [141, 1]);
    drag([140, 0], [0, 0]);
    expect(updates).toHaveLength(0);
  });
});

describe("clic sul velo senza i muri visibili", () => {
  it("con i muri nascosti le porte non rispondono al clic", () => {
    const spy = vi.fn();
    c.handlers = { onWallUpdate: spy };
    c.setScene(base({ wallsVisible: false, walls: [{ id: "d", door: true, open: false, segments: [0, 0, 140, 0] }] }));
    click(70, 1);
    expect(spy).not.toHaveBeenCalled();
  });
});
