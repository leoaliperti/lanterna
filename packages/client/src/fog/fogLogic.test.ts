import { describe, expect, it } from "vitest";
import { LIMITS, type FogMask } from "@lanterna/shared";
import {
  CellPath, availableTiles, cellAt, cellBox, cellCenter, cellInScene, cellsAlongSegment, circleShape, coveredBitmap, describeTarget, diffTiles,
  fogAllCommand, fogShapeCommand, fogTarget, polygonShape, previewRuns, rectShape, revealedCount, snapToCenter, snapToCorner, tileUrl, viewMask
} from "./fogLogic";

const G = { cellSize: 70, offsetX: 0, offsetY: 0 };
const OFF = { cellSize: 70, offsetX: 20, offsetY: 10 };

describe("conversioni punto <-> cella", () => {
  it("cella, riquadro e centro con e senza offset", () => {
    expect(cellAt(G, { x: 69.9, y: 70 })).toEqual([0, 1]);
    expect(cellAt(OFF, { x: 19, y: 9 })).toEqual([-1, -1]);
    expect(cellAt(OFF, { x: 20, y: 10 })).toEqual([0, 0]);
    expect(cellBox(OFF, 2, 1)).toEqual({ x: 160, y: 80, width: 70, height: 70 });
    expect(cellCenter(G, 1, 1)).toEqual({ x: 105, y: 105 });
  });
  it("aggancio agli incroci e al centro cella", () => {
    expect(snapToCorner(G, { x: 100, y: 34 })).toEqual({ x: 70, y: 0 });
    expect(snapToCorner(OFF, { x: 100, y: 34 })).toEqual({ x: 90, y: 10 });
    expect(snapToCenter(G, { x: 100, y: 34 })).toEqual({ x: 105, y: 35 });
  });
  it("cellInScene rispetta il bordo della mappa", () => {
    expect(cellInScene(G, 140, 140, 1, 1)).toBe(true);
    expect(cellInScene(G, 140, 140, 2, 0)).toBe(false);
    expect(cellInScene(G, 150, 140, 2, 0)).toBe(true); // cella parziale ai bordi
    expect(cellInScene(G, 140, 140, -1, 0)).toBe(false);
  });
});

describe("forme del pennello", () => {
  it("rettangolo: angoli agganciati alle linee, ordine indifferente", () => {
    expect(rectShape(G, { x: 150, y: 140 }, { x: 10, y: 20 })).toEqual({ kind: "rect", x: 0, y: 0, width: 140, height: 140 });
  });
  it("un clic o un rettangolo piccolo vale la cella cliccata", () => {
    expect(rectShape(G, { x: 100, y: 100 }, { x: 101, y: 101 })).toEqual({ kind: "cells", cells: [1, 1] });
  });
  it("con Alt (senza aggancio) il rettangolo resta libero", () => {
    expect(rectShape(G, { x: 13, y: 17 }, { x: 150, y: 90 }, false)).toEqual({ kind: "rect", x: 13, y: 17, width: 137, height: 73 });
  });
  it("cerchio: centro sul centro cella, raggio a mezzi passi; un clic vale una cella", () => {
    expect(circleShape(G, { x: 100, y: 100 }, { x: 210, y: 105 })).toEqual({ kind: "circle", x: 105, y: 105, radius: 105 });
    expect(circleShape(G, { x: 100, y: 100 }, { x: 101, y: 100 })).toEqual({ kind: "cells", cells: [1, 1] });
    expect(circleShape(G, { x: 100, y: 100 }, { x: 160, y: 100 }, false)).toEqual({ kind: "circle", x: 100, y: 100, radius: 60 });
  });
  it("poligono: servono tre vertici e il limite del protocollo", () => {
    expect(polygonShape([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    expect(polygonShape([{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 70 }])).toEqual({ kind: "polygon", points: [0, 0, 70, 0, 70, 70] });
    const many = Array.from({ length: LIMITS.fogMaxPolygonPoints + 10 }, (_, i) => ({ x: i, y: i % 7 }));
    expect((polygonShape(many) as { points: number[] }).points.length).toBe(LIMITS.fogMaxPolygonPoints * 2);
  });
  it("celle lungo un segmento: nessun salto, nessuna ripetizione", () => {
    const cells = cellsAlongSegment(G, { x: 5, y: 5 }, { x: 215, y: 5 });
    expect(cells).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
    const diag = cellsAlongSegment(G, { x: 5, y: 5 }, { x: 150, y: 150 });
    for (let i = 1; i < diag.length; i++) {
      expect(Math.abs(diag[i]![0] - diag[i - 1]![0]) + Math.abs(diag[i]![1] - diag[i - 1]![1])).toBeLessThanOrEqual(2);
    }
  });
  it("percorso a celle: uniche, dentro la mappa, con tetto", () => {
    const path = new CellPath(G, 280, 140);
    path.add({ x: 5, y: 5 });
    path.add({ x: 5, y: 5 });
    path.add({ x: 400, y: 5 }); // oltre il bordo destro: le celle fuori si scartano
    expect(path.shape()).toEqual({ kind: "cells", cells: [0, 0, 1, 0, 2, 0, 3, 0] });
    const big = new CellPath({ cellSize: 4, offsetX: 0, offsetY: 0 }, 20000, 20000);
    for (let y = 0; y < 100 && !big.full; y++) {
      big.add({ x: 0, y: y * 4 + 1 });
      big.add({ x: 19999, y: y * 4 + 1 });
    }
    expect(big.count).toBe(LIMITS.fogMaxCells);
  });
  it("anteprima = celle che il server rivelerebbe (stessa regola del centro)", () => {
    const shape = rectShape(G, { x: 0, y: 0 }, { x: 140, y: 70 });
    expect(previewRuns(shape, G, 1400, 1000)).toEqual([0, 0, 2]);
  });
});

describe("destinatari e comandi", () => {
  it("nessuno scelto = tutti; altrimenti i giocatori scelti", () => {
    expect(fogTarget([])).toEqual({ kind: "all" });
    expect(fogTarget(["a", "b"])).toEqual({ kind: "players", userIds: ["a", "b"] });
  });
  it("forma -> fog.reveal / fog.cover, e tutto -> revealAll / coverAll", () => {
    const shape = { kind: "cells", cells: [1, 1] } as const;
    expect(fogShapeCommand("reveal", "s", shape, fogTarget(["a"]))).toEqual({ type: "fog.reveal", sceneId: "s", shape, target: { kind: "players", userIds: ["a"] } });
    expect(fogShapeCommand("cover", "s", shape, fogTarget([])).type).toBe("fog.cover");
    expect(fogAllCommand("reveal", "s", fogTarget([]))).toEqual({ type: "fog.revealAll", sceneId: "s", target: { kind: "all" } });
    expect(fogAllCommand("cover", "s", fogTarget(["a"])).type).toBe("fog.coverAll");
  });
  it("descrizione dei destinatari per etichette e annunci", () => {
    const names = new Map([["a", "Luca"], ["b", "Sara"], ["c", "Dino"]]);
    expect(describeTarget([], names)).toBe("Tutti");
    expect(describeTarget(["a"], names)).toBe("Luca");
    expect(describeTarget(["a", "b"], names)).toBe("Luca e Sara");
    expect(describeTarget(["a", "b", "c"], names)).toBe("3 giocatori");
  });
});

describe("maschera da disegnare", () => {
  const everyone: FogMask = { base: "covered", runs: [] };
  const luca: FogMask = { base: "covered", runs: [0, 0, 2] };
  it("viewMask: tutti oppure la maschera del giocatore (senza maschera propria vale quella di tutti)", () => {
    const fog = { mask: everyone, players: [{ userId: "luca", mask: luca }] };
    expect(viewMask(fog, null)).toBe(everyone);
    expect(viewMask(fog, "luca")).toBe(luca);
    expect(viewMask(fog, "sara")).toBe(everyone);
    expect(viewMask({ mask: everyone }, "luca")).toBe(everyone);
  });
  it("coveredBitmap: base coperta con terne rivelate, e viceversa; ritaglio sul rettangolo", () => {
    const a = coveredBitmap({ base: "covered", runs: [0, 1, 3, 2, 0, 1] }, 0, 0, 4, 3);
    expect([...a]).toEqual([255, 0, 0, 255, 255, 255, 255, 255, 0, 255, 255, 255]);
    const b = coveredBitmap({ base: "revealed", runs: [1, 0, 2] }, 0, 0, 3, 2);
    expect([...b]).toEqual([0, 0, 0, 255, 255, 0]);
    // Ritaglio: la terna sulla riga 5 (colonne 0..9) cade tutta nel rettangolo [2,4) x [4,6).
    expect([...coveredBitmap({ base: "covered", runs: [5, 0, 9] }, 2, 4, 4, 6)]).toEqual([255, 255, 0, 0]);
  });
  it("celle rivelate contate sulla scena", () => {
    expect(revealedCount({ base: "covered", runs: [0, 0, 2] }, G, 280, 140)).toBe(2);
    expect(revealedCount({ base: "revealed", runs: [] }, G, 280, 140)).toBe(8);
    expect(revealedCount({ base: "covered", runs: [] }, G, 280, 140)).toBe(0);
  });
});

describe("tessere disponibili", () => {
  // Scena 1400x1000, celle da 70, tessere da 512: 3 colonne x 2 righe.
  const tiles = { size: 512, cols: 3, rows: 2, key: "k1" };
  const urlOf = (c: number, r: number, k: string) => `/t/${c}/${r}?k=${k}`;
  it("tutto coperto: nessuna tessera da caricare (il server risponderebbe 404)", () => {
    expect(availableTiles(tiles, { base: "covered", runs: [] }, G, 1400, 1000, urlOf)).toEqual([]);
  });
  it("solo le tessere con almeno una cella rivelata, con posizione e misura corrette", () => {
    // Stanza in alto a sinistra (celle 0..3 x 0..2): tocca solo la tessera (0,0).
    const room: FogMask = { base: "covered", runs: [0, 0, 4, 1, 0, 4, 2, 0, 4] };
    const list = availableTiles(tiles, room, G, 1400, 1000, urlOf);
    expect(list.map((t) => t.id)).toEqual(["0,0"]);
    expect(list[0]).toMatchObject({ x: 0, y: 0, width: 512, height: 512 });
    expect(list[0]!.url.startsWith("/t/0/0?k=")).toBe(true);
  });
  it("tessere ai bordi hanno la misura ridotta; tutto rivelato = tutte le sei", () => {
    const all = availableTiles(tiles, { base: "revealed", runs: [] }, G, 1400, 1000, urlOf);
    expect(all).toHaveLength(6);
    const last = all.find((t) => t.id === "2,1")!;
    expect([last.x, last.y, last.width, last.height]).toEqual([1024, 512, 376, 488]);
  });
  it("la chiave cambia se cambia la copertura o l'immagine, non se cambia altrove", () => {
    const a = availableTiles(tiles, { base: "covered", runs: [0, 0, 2] }, G, 1400, 1000, urlOf);
    const sameElsewhere = availableTiles(tiles, { base: "covered", runs: [0, 0, 2, 9, 15, 17] }, G, 1400, 1000, urlOf);
    expect(sameElsewhere.find((t) => t.id === "0,0")!.key).toBe(a[0]!.key);
    const more = availableTiles(tiles, { base: "covered", runs: [0, 0, 3] }, G, 1400, 1000, urlOf);
    expect(more[0]!.key).not.toBe(a[0]!.key);
    const newImage = availableTiles({ ...tiles, key: "k2" }, { base: "covered", runs: [0, 0, 2] }, G, 1400, 1000, urlOf);
    expect(newImage[0]!.key).not.toBe(a[0]!.key);
  });
  it("diff: carica le nuove e quelle cambiate, toglie quelle sparite, non tocca le uguali", () => {
    const mk = (id: string, key: string) => ({ id, key });
    const loaded = new Map([["0,0", "a"], ["1,0", "b"], ["2,0", "c"]]);
    const d = diffTiles(loaded, [mk("0,0", "a"), mk("1,0", "b2"), mk("0,1", "x")]);
    expect(d.load.map((t) => t.id)).toEqual(["1,0", "0,1"]);
    expect(d.remove).toEqual(["2,0"]);
  });
  it("URL: sotto /api, con la chiave di copertura per scavalcare la cache", () => {
    expect(tileUrl("/api", "c 1", "s1", 2, 3, "a:b")).toBe("/api/campaigns/c%201/scenes/s1/tiles/2/3?k=a%3Ab");
  });
});
