// @vitest-environment node
/**
 * Integrazione della nebbia: `RealtimeClient` reale e logica della UI (`availableTiles`, `viewMask`, comandi dei
 * pennelli) contro il server vero. Un GM e due giocatori con maschere diverse. Si cercano i dati segreti nei byte
 * ricevuti e si chiedono al server le tessere: una coperta non si ottiene (404), una rivelata si'.
 * Scena 1400x1000, celle da 70 px, tessere da 512 px (3 x 2).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Command, FogView, UploadResponse } from "@lanterna/shared";
import { ORIGIN, createTestApp, type TestContext } from "../../server/src/test/helpers";
import { MAIN, createTable, scene, token, type Table } from "../../server/src/test/campaign";
import { makePng, multipart } from "../../server/src/test/images";
import { listen } from "../../server/src/test/ws";
import { availableTiles, fogShapeCommand, fogTarget, geometryOf, tileUrl, viewMask } from "../src/fog/fogLogic";
import { closeConnections, connect, until, type Player } from "./helpers";

let ctx: TestContext | undefined;

afterEach(async () => {
  closeConnections();
  await ctx?.close();
  ctx = undefined;
});

const W = 1400;
const H = 1000;
const ROOM_A = { kind: "rect", x: 0, y: 0, width: 280, height: 210 } as const; // tessera 0,0
const ROOM_B = { kind: "rect", x: 980, y: 630, width: 420, height: 370 } as const; // tessere 1,1 e 2,1
const NEW_ZONE = { kind: "rect", x: 1050, y: 70, width: 280, height: 140 } as const; // celle con il centro oltre x=1024: solo la tessera 2,0
const SECRET = { name: "SoloPerBXYZ", id: "tok-solo-b", dark: "NelBuioXYZ", darkId: "tok-buio" };

async function must(p: ReturnType<Player["client"]["sendCommand"]>) {
  const r = await p;
  if (!r.ok) throw new Error(`comando rifiutato: ${r.code} ${r.message}`);
}

async function setup() {
  ctx = await createTestApp();
  const port = await listen(ctx);
  const t = await createTable(ctx);
  const gm = connect(port, t.campaignId, t.gm.cookie);
  await until(() => gm.client.getState().status === "connected", "GM connesso");

  const body = multipart(makePng(W, H), "mappa.png", "image/png");
  const up = await ctx.app.inject({ method: "POST", url: "/uploads/map", headers: { ...body.headers, origin: ORIGIN, cookie: t.gm.cookie }, payload: body.payload });
  expect(up.statusCode).toBe(201);
  const map = up.json() as UploadResponse;

  const cmds: Command[] = [
    { type: "scene.create", scene: scene(MAIN, { name: "Taverna", map: { assetId: map.assetId, url: map.url } }) },
    { type: "scene.activate", sceneId: MAIN },
    { type: "token.create", token: token("tok-p1", { ownerUserId: t.p1.id, kind: "pc", name: "Eroe1", x: 105, y: 105 }) },
    { type: "token.create", token: token("tok-p2", { ownerUserId: t.p2.id, kind: "pc", name: "Eroe2", x: 1155, y: 805 }) },
    { type: "token.create", token: token(SECRET.darkId, { name: SECRET.dark, x: 735, y: 455 }) },
    { type: "fog.enable", sceneId: MAIN, initial: "covered" },
    // I pennelli della UI producono questi stessi comandi.
    fogShapeCommand("reveal", MAIN, ROOM_A, fogTarget([t.p1.id])),
    fogShapeCommand("reveal", MAIN, ROOM_B, fogTarget([t.p2.id]))
  ];
  for (const c of cmds) await must(gm.client.sendCommand(c));

  const p1 = connect(port, t.campaignId, t.p1.cookie);
  const p2 = connect(port, t.campaignId, t.p2.cookie);
  await until(() => !!p1.client.getState().view?.fogs?.length && !!p2.client.getState().view?.fogs?.length, "giocatori con nebbia");
  return { t, port, gm, p1, p2 };
}

const fogOf = (p: Player): FogView => p.client.getState().view!.fogs![0]!;
const sceneOf = (p: Player) => p.client.getState().view!.scenes[0]!;

function plan(p: Player, campaignId: string) {
  const fog = fogOf(p);
  const sc = sceneOf(p);
  return availableTiles(fog.tiles!, fog.mask, geometryOf(fog), sc.width, sc.height, (c, r, k) => tileUrl("", campaignId, MAIN, c, r, k));
}

const fetchTile = (cookie: string, t: Table, col: number, row: number) =>
  ctx!.app.inject({ method: "GET", url: `/campaigns/${t.campaignId}/scenes/${MAIN}/tiles/${col}/${row}`, headers: { cookie } });

describe("nebbia: client reale contro server reale", () => {
  it("un giocatore ottiene solo le tessere che la sua UI considera disponibili; le coperte sono 404; niente token sotto la nebbia", async () => {
    const { t, p1, p2 } = await setup();
    for (const [p, cookie, expected] of [
      [p1, t.p1.cookie, ["0,0"]],
      [p2, t.p2.cookie, ["1,1", "2,1"]]
    ] as const) {
      const planned = plan(p, t.campaignId);
      expect(planned.map((x) => x.id)).toEqual(expected);
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const res = await fetchTile(cookie, t, col, row);
          expect(res.statusCode, `tessera ${col},${row}`).toBe(expected.includes(`${col},${row}` as never) ? 200 : 404);
          if (res.statusCode === 404) expect(res.json()).toEqual({ error: "Non trovato" });
        }
      }
    }
    // Mappa a tessere: mai l'URL intero; nessun token sotto la nebbia, nei dati ricevuti.
    for (const p of [p1, p2]) {
      expect(p.client.getState().view!.scenes[0]!.map).toBeNull();
      const traffic = p.traffic.join("");
      expect(traffic).not.toContain(SECRET.dark);
      expect(traffic).not.toContain(SECRET.darkId);
      expect(traffic).not.toContain("/assets/");
    }
    expect(p1.client.getState().view!.tokens.map((x) => x.id)).toEqual(["tok-p1"]);
    expect(p2.client.getState().view!.tokens.map((x) => x.id)).toEqual(["tok-p2"]);
  });

  it("il GM rivela a un solo giocatore: l'altro non riceve nulla; il velo del GM coincide con la maschera del giocatore", async () => {
    const { t, gm, p1, p2 } = await setup();
    const maskP1 = JSON.stringify(fogOf(p1).mask);
    const tilesP1 = plan(p1, t.campaignId).map((x) => x.id);
    const before = p1.traffic.length;

    await must(gm.client.sendCommand({ type: "token.create", token: token(SECRET.id, { name: SECRET.name, x: 1155, y: 105 }) }));
    await must(gm.client.sendCommand(fogShapeCommand("reveal", MAIN, NEW_ZONE, fogTarget([t.p2.id]))));

    await until(() => plan(p2, t.campaignId).some((x) => x.id === "2,0"), "p2 riceve la nuova zona");
    expect(p2.client.getState().view!.tokens.some((x) => x.name === SECRET.name)).toBe(true);
    expect((await fetchTile(t.p2.cookie, t, 2, 0)).statusCode).toBe(200);

    // A (p1) non vede cambiare nulla: stessa maschera, stesse tessere, nessun dato nuovo nel traffico.
    await new Promise((r) => setTimeout(r, 200));
    expect(JSON.stringify(fogOf(p1).mask)).toBe(maskP1);
    expect(plan(p1, t.campaignId).map((x) => x.id)).toEqual(tilesP1);
    expect((await fetchTile(t.p1.cookie, t, 2, 0)).statusCode).toBe(404);
    const newTraffic = p1.traffic.slice(before).join("");
    expect(newTraffic).not.toContain(SECRET.name);
    expect(newTraffic).not.toContain(SECRET.id);
    expect(newTraffic).not.toContain("1050");
    expect(p1.client.getState().view!.tokens.some((x) => x.name === SECRET.name)).toBe(false);

    // Il GM ha tutte le maschere: "vista come" un giocatore e' esattamente quello che il giocatore riceve.
    await until(() => (gm.client.getState().view!.fogs![0]!.players ?? []).length === 2, "GM con le maschere dei giocatori");
    const gmFog = gm.client.getState().view!.fogs![0]!;
    expect(viewMask(gmFog, t.p2.id)).toEqual(fogOf(p2).mask);
    expect(viewMask(gmFog, t.p1.id)).toEqual(fogOf(p1).mask);
    expect(viewMask(gmFog, null)).toEqual({ base: "covered", runs: [] }); // "tutti": ancora tutto coperto
    // Il GM vede la mappa intera (URL) e tutti i token.
    expect(gm.client.getState().view!.scenes[0]!.map).not.toBeNull();
    expect(gm.client.getState().view!.tokens.some((x) => x.id === SECRET.darkId)).toBe(true);
  });

  it("rivela a tutti e copri: le tessere seguono la maschera e annulla le ripristina", async () => {
    const { t, gm, p1 } = await setup();
    await must(gm.client.sendCommand({ type: "fog.revealAll", sceneId: MAIN, target: { kind: "all" } }));
    await until(() => plan(p1, t.campaignId).length === 6, "tutte le tessere");
    expect((await fetchTile(t.p1.cookie, t, 2, 1)).statusCode).toBe(200);
    expect(p1.client.getState().view!.tokens.some((x) => x.name === SECRET.dark)).toBe(true);

    const undone = await gm.client.undo();
    expect(undone.ok).toBe(true);
    await until(() => plan(p1, t.campaignId).length === 1, "tessere di prima");
    expect((await fetchTile(t.p1.cookie, t, 2, 1)).statusCode).toBe(404);
    expect(p1.client.getState().view!.tokens.some((x) => x.name === SECRET.dark)).toBe(false);
  });
});
