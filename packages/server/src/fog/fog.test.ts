import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import type { CampaignView, Command, UploadResponse } from "@lanterna/shared";
import { addMemberAs, command, hello, populate, scene, token, MAIN, createTable, type Table } from "../test/campaign.js";
import { ORIGIN, createTestApp, loginAs, type TestContext } from "../test/helpers.js";
import { multipart } from "../test/images.js";
import { WsClient, listen, settle } from "../test/ws.js";
import { decodeImage } from "../media/tiles.js";

/**
 * Nebbia di guerra con WebSocket e HTTP reali: GM + due giocatori con maschere diverse.
 * Scena 1400x1000, celle da 70 px, tessere da 512 px (3 x 2).
 * - A (p1) vede la stanza in alto a sinistra (0..280 x 0..210);
 * - B (p2) vede la zona in basso a destra (980..1400 x 630..1000).
 */
const W = 1400;
const H = 1000;
const ROOM_A = { kind: "rect", x: 0, y: 0, width: 280, height: 210 } as const;
const ROOM_B = { kind: "rect", x: 980, y: 630, width: 420, height: 370 } as const;
const ONLY_A = { token: "SegretoSoloPerA-XYZ", tokenId: "tok-solo-a", wall: "muro-solo-a-XYZ", wallX: 222.25 };
const ONLY_B = { token: "SegretoSoloPerB-XYZ", tokenId: "tok-solo-b", x: 1155 };
const DARK = { token: "NelBuio-XYZ", tokenId: "tok-buio", wall: "muro-buio-XYZ", wallX: 777.75 };

let ctx: TestContext | undefined;
let clients: WsClient[] = [];
const extra: string[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await ctx?.close();
  ctx = undefined;
  for (const p of extra.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** Mappa con pixel riconoscibili: R = x % 256, G = y % 256, B = 200. */
function patternPng(): Buffer {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      png.data[i] = x % 256;
      png.data[i + 1] = y % 256;
      png.data[i + 2] = 200;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function uploadMap(cookie: string, file: Buffer, name = "mappa.png", type = "image/png"): Promise<UploadResponse> {
  const body = multipart(file, name, type);
  const res = await ctx!.app.inject({
    method: "POST",
    url: "/uploads/map",
    headers: { ...body.headers, origin: ORIGIN, cookie },
    payload: body.payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as UploadResponse;
}

const tile = (t: Table, cookie: string, col: number, row: number, extraHeaders: Record<string, string> = {}, sceneId = MAIN) =>
  ctx!.app.inject({
    method: "GET",
    url: `/campaigns/${t.campaignId}/scenes/${sceneId}/tiles/${col}/${row}`,
    headers: { cookie, ...extraHeaders },
  });

async function setup(persistent?: { dbPath: string; uploadDir: string }) {
  ctx = await createTestApp({}, undefined, persistent);
  const t = await createTable(ctx);
  const port = await listen(ctx);
  const gm = await WsClient.connect(port, { cookie: t.gm.cookie });
  clients.push(gm);
  await hello(gm, t.campaignId);
  await populate(gm, t);
  const map = await uploadMap(t.gm.cookie, patternPng());
  const cmds: Command[] = [
    { type: "scene.update", sceneId: MAIN, patch: { map: { assetId: map.assetId, url: map.url } } },
    { type: "fog.enable", sceneId: MAIN, initial: "covered" },
    { type: "fog.reveal", sceneId: MAIN, shape: ROOM_A, target: { kind: "players", userIds: [t.p1.id] } },
    { type: "fog.reveal", sceneId: MAIN, shape: ROOM_B, target: { kind: "players", userIds: [t.p2.id] } },
    { type: "token.create", token: token(ONLY_A.tokenId, { name: ONLY_A.token, x: 175, y: 105 }) },
    { type: "token.create", token: token(ONLY_B.tokenId, { name: ONLY_B.token, x: ONLY_B.x, y: 805 }) },
    { type: "token.create", token: token(DARK.tokenId, { name: DARK.token, x: 735, y: 455 }) },
    {
      type: "wall.add",
      wall: { id: ONLY_A.wall, sceneId: MAIN, x1: ONLY_A.wallX, y1: 20, x2: ONLY_A.wallX, y2: 180, door: false, open: false },
    },
    {
      type: "wall.add",
      wall: { id: DARK.wall, sceneId: MAIN, x1: DARK.wallX, y1: 300, x2: DARK.wallX, y2: 600, door: true, open: false },
    },
  ];
  for (const c of cmds) {
    const r = await command(gm, c);
    expect(r.type, `${c.type}: ${JSON.stringify(r)}`).toBe("ack");
  }
  const p1 = await WsClient.connect(port, { cookie: t.p1.cookie });
  const p2 = await WsClient.connect(port, { cookie: t.p2.cookie });
  clients.push(p1, p2);
  const s1 = await hello(p1, t.campaignId);
  const s2 = await hello(p2, t.campaignId);
  if (s1.type !== "snapshot" || s2.type !== "snapshot") throw new Error("snapshot atteso");
  return { t, port, gm, p1, p2, map, v1: s1.view, v2: s2.view };
}

function pixel(img: { data: Uint8Array; width: number }, x: number, y: number) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

describe("nebbia: dati per giocatore via WebSocket", () => {
  it("A e B ricevono solo ciò che è rivelato a ciascuno; mai la mappa intera", async () => {
    const { v1, v2, p1, p2, map, gm, t } = await setup();
    const ids = (v: CampaignView) => v.tokens.map((x) => x.id).sort();
    expect(ids(v1)).toEqual(["tok-p1", "tok-p2", ONLY_A.tokenId].sort());
    expect(ids(v2)).toEqual(["tok-p2", ONLY_B.tokenId]); // il proprio token si vede sempre
    expect(v1.scenes[0]!.map).toBeNull();
    expect(v1.fogs![0]!.tiles).toMatchObject({ size: 512, cols: 3, rows: 2 });
    expect(v1.walls!.map((w) => w.id)).toEqual([ONLY_A.wall]);

    // Altre azioni del GM dopo la connessione: rivela a B una zona nuova, muove token nel buio.
    for (const c of [
      { type: "fog.reveal", sceneId: MAIN, shape: { kind: "circle", x: 1155, y: 175, radius: 100 }, target: { kind: "players", userIds: [t.p2.id] } },
      { type: "token.move", tokenId: DARK.tokenId, x: 843.5, y: 525.25, snap: false },
      { type: "wall.update", wallId: DARK.wall, patch: { open: true } },
      { type: "token.move", tokenId: ONLY_A.tokenId, x: 245, y: 175 },
    ] as Command[]) {
      expect((await command(gm, c)).type).toBe("ack");
    }
    await settle();

    const a = p1.traffic();
    const b = p2.traffic();
    for (const traffic of [a, b]) {
      expect(traffic).not.toContain(map.assetId);
      expect(traffic).not.toContain("/assets/");
      expect(traffic).not.toContain(DARK.token);
      expect(traffic).not.toContain(DARK.tokenId);
      expect(traffic).not.toContain(DARK.wall);
      expect(traffic).not.toContain(String(DARK.wallX));
      expect(traffic).not.toContain("843.5");
      expect(traffic).not.toContain("525.25");
      expect(traffic).not.toContain(SECRET_HIDDEN);
    }
    // B non ottiene nulla di ciò che è rivelato solo ad A (e viceversa), né le maschere altrui.
    for (const s of [ONLY_A.token, ONLY_A.tokenId, ONLY_A.wall, String(ONLY_A.wallX), "tok-p1", `"userId":"${t.p1.id}","mask"`]) {
      expect(b, s).not.toContain(s);
    }
    for (const s of [ONLY_B.token, ONLY_B.tokenId, String(ONLY_B.x), `"userId":"${t.p2.id}","mask"`]) {
      expect(a, s).not.toContain(s);
    }
  });

  it("un giocatore non può usare i comandi della nebbia né muovere token che non vede", async () => {
    const { p1, t } = await setup();
    for (const c of [
      { type: "fog.revealAll", sceneId: MAIN, target: { kind: "all" } },
      { type: "fog.reveal", sceneId: MAIN, shape: ROOM_B, target: { kind: "players", userIds: [t.p1.id] } },
      { type: "wall.remove", wallId: DARK.wall },
      { type: "fog.disable", sceneId: MAIN },
    ]) {
      const r = await command(p1, c);
      expect(r.type === "error" && r.code).toBe("FORBIDDEN");
    }
    const hiddenTok = await command(p1, { type: "token.move", tokenId: DARK.tokenId, x: 35, y: 35 });
    const ghost = await command(p1, { type: "token.move", tokenId: "non-esiste", x: 35, y: 35 });
    expect(hiddenTok.type === "error" && ghost.type === "error" && [hiddenTok.code, hiddenTok.message]).toEqual(
      ghost.type === "error" ? [ghost.code, ghost.message] : null,
    );
  });
});

const SECRET_HIDDEN = "OgreNascostoXYZ";

describe("nebbia: tessere della mappa per giocatore", () => {
  it("tessera rivelata: pixel originali dove è rivelato, neri e trasparenti dove è coperto", async () => {
    const { t } = await setup();
    const res = await tile(t, t.p1.cookie, 0, 0);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("private, no-cache");
    const img = PNG.sync.read(res.rawPayload);
    expect([img.width, img.height]).toEqual([512, 512]);
    expect(pixel(img, 10, 10)).toEqual([10, 10, 200, 255]); // dentro la stanza di A
    expect(pixel(img, 279, 209)).toEqual([279 % 256, 209, 200, 255]);
    expect(pixel(img, 281, 10)).toEqual([0, 0, 0, 0]); // fuori: oscurato
    expect(pixel(img, 10, 300)).toEqual([0, 0, 0, 0]);
    // Nessun pixel non rivelato sopravvive.
    for (let y = 0; y < 512; y += 7) {
      for (let x = 0; x < 512; x += 7) {
        if (x >= 280 || y >= 210) expect(pixel(img, x, y)[3]).toBe(0);
      }
    }
    // Il GM ha la tessera intera.
    const g = PNG.sync.read((await tile(t, t.gm.cookie, 0, 0)).rawPayload);
    expect(pixel(g, 400, 400)).toEqual([400 % 256, 400 % 256, 200, 255]);
  });

  it("tessera coperta = 404 identico a tessera, scena o campagna inesistente", async () => {
    const { t } = await setup();
    const outsider = await loginAs(ctx!.app, "player");
    const covered = await tile(t, t.p2.cookie, 0, 0); // B non ha nulla in alto a sinistra
    const variants = [
      covered,
      await tile(t, t.p2.cookie, 99, 0),
      await tile(t, t.p2.cookie, 0, 0, {}, "scena-inesistente"),
      await tile(t, t.p2.cookie, 1, 1, {}, "scn-prep"),
      await ctx!.app.inject({ method: "GET", url: `/campaigns/nope/scenes/${MAIN}/tiles/0/0`, headers: { cookie: t.p2.cookie } }),
      await tile(t, outsider.cookie, 2, 1), // non membro, anche se la tessera di B esiste
      await tile(t, t.p2.cookie, -1, 0),
    ];
    for (const r of variants) {
      expect(r.statusCode).toBe(404);
      expect(r.body).toBe(covered.body);
      expect(r.headers["content-type"]).toBe(covered.headers["content-type"]);
      expect(r.headers.etag).toBeUndefined();
    }
    // Senza sessione: 401 come ogni rotta protetta.
    const anon = await ctx!.app.inject({ method: "GET", url: `/campaigns/${t.campaignId}/scenes/${MAIN}/tiles/0/0` });
    expect(anon.statusCode).toBe(401);
    // B ottiene invece le sue tessere.
    expect((await tile(t, t.p2.cookie, 2, 1)).statusCode).toBe(200);
    // B non può ottenere in nessun modo tessere solo di A: le prova tutte.
    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 2; row++) {
        const r = await tile(t, t.p2.cookie, col, row);
        if (r.statusCode !== 200) continue;
        const img = PNG.sync.read(r.rawPayload);
        // Nessun pixel della stanza di A (0..280 x 0..210) è visibile a B.
        for (let y = 0; y < img.height; y += 5) {
          for (let x = 0; x < img.width; x += 5) {
            const sx = col * 512 + x;
            const sy = row * 512 + y;
            if (sx < 280 && sy < 210) expect(pixel(img, x, y)[3]).toBe(0);
          }
        }
      }
    }
  });

  it("la mappa intera non si scarica da /assets con la nebbia (giocatori), il GM sì", async () => {
    const { t, map, gm } = await setup();
    for (const cookie of [t.p1.cookie, t.p2.cookie]) {
      const r = await ctx!.app.inject({ method: "GET", url: map.url, headers: { cookie } });
      expect(r.statusCode).toBe(404);
    }
    expect((await ctx!.app.inject({ method: "GET", url: map.url, headers: { cookie: t.gm.cookie } })).statusCode).toBe(200);
    // Senza nebbia si torna al comportamento di prima.
    expect((await command(gm, { type: "fog.disable", sceneId: MAIN })).type).toBe("ack");
    expect((await ctx!.app.inject({ method: "GET", url: map.url, headers: { cookie: t.p2.cookie } })).statusCode).toBe(200);
  });

  it("quando la nebbia cambia le tessere si aggiornano (ETag) o spariscono (404)", async () => {
    const { t, gm } = await setup();
    const first = await tile(t, t.p1.cookie, 0, 0);
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    expect((await tile(t, t.p1.cookie, 0, 0, { "if-none-match": etag })).statusCode).toBe(304);
    // Rivelare altro nella tessera cambia l'ETag.
    await command(gm, { type: "fog.reveal", sceneId: MAIN, shape: { kind: "rect", x: 280, y: 0, width: 70, height: 70 }, target: { kind: "players", userIds: [t.p1.id] } });
    const second = await tile(t, t.p1.cookie, 0, 0, { "if-none-match": etag });
    expect(second.statusCode).toBe(200);
    expect(second.headers.etag).not.toBe(etag);
    // Coprire tutto per A: la tessera sparisce.
    await command(gm, { type: "fog.coverAll", sceneId: MAIN, target: { kind: "players", userIds: [t.p1.id] } });
    expect((await tile(t, t.p1.cookie, 0, 0)).statusCode).toBe(404);
    // Disattivare la scena: niente tessere per i giocatori.
    await command(gm, { type: "fog.revealAll", sceneId: MAIN, target: { kind: "all" } });
    expect((await tile(t, t.p2.cookie, 0, 0)).statusCode).toBe(200);
    await command(gm, { type: "scene.activate", sceneId: null });
    expect((await tile(t, t.p2.cookie, 0, 0)).statusCode).toBe(404);
  });

  it("dopo un riavvio nebbia, muri e maschere sono gli stessi", async () => {
    const dbPath = join(tmpdir(), `lanterna-fog-${randomUUID()}.db`);
    const uploadDir = join(tmpdir(), `lanterna-fog-up-${randomUUID()}`);
    extra.push(uploadDir);
    for (const s of ["", "-wal", "-shm"]) extra.push(dbPath + s);
    const persistent = { dbPath, uploadDir };
    const { t, v1, v2 } = await setup(persistent);
    const before = ctx!.app.realtime.stateOf(t.campaignId)!.state;
    const etag = (await tile(t, t.p1.cookie, 0, 0)).headers.etag;
    for (const c of clients) c.close();
    clients = [];
    await ctx!.close();

    ctx = await createTestApp({}, undefined, persistent);
    const after = ctx.app.realtime.stateOf(t.campaignId)!.state;
    expect(after.fogs).toEqual(before.fogs);
    expect(after.walls).toEqual(before.walls);
    const port = await listen(ctx);
    const p1 = await WsClient.connect(port, { cookie: t.p1.cookie });
    const p2 = await WsClient.connect(port, { cookie: t.p2.cookie });
    clients.push(p1, p2);
    const s1 = await hello(p1, t.campaignId);
    const s2 = await hello(p2, t.campaignId);
    if (s1.type !== "snapshot" || s2.type !== "snapshot") throw new Error("snapshot atteso");
    expect(s1.view.fogs).toEqual(v1.fogs);
    expect(s2.view.tokens).toEqual(v2.tokens);
    const again = await tile(t, t.p1.cookie, 0, 0);
    expect(again.statusCode).toBe(200);
    expect(again.headers.etag).toBe(etag);
    expect((await tile(t, t.p2.cookie, 0, 0)).statusCode).toBe(404);
  });

  it("un giocatore rimosso dalla campagna perde maschera e tessere", async () => {
    const { t } = await setup();
    const res = await ctx!.app.inject({
      method: "DELETE",
      url: `/campaigns/${t.campaignId}/members/${t.p1.id}`,
      headers: { origin: ORIGIN, cookie: t.gm.cookie },
    });
    expect(res.statusCode).toBe(204);
    await settle();
    expect((await tile(t, t.p1.cookie, 0, 0)).statusCode).toBe(404);
    const fog = ctx!.app.realtime.stateOf(t.campaignId)!.state.fogs![0]!;
    expect(fog.players.map((p) => p.userId)).toEqual([t.p2.id]);
    // Se rientra riparte dalla maschera di tutti (tutto coperto).
    await addMemberAs(ctx!, t.gm.cookie, t.campaignId, t.p1.id);
    await settle();
    expect((await tile(t, t.p1.cookie, 0, 0)).statusCode).toBe(404);
  });

  it("mappe JPEG e WebP: tessere decodificate in JS/WASM, coperto = nero", async () => {
    ctx = await createTestApp();
    const t = await createTable(ctx);
    const port = await listen(ctx);
    const gm = await WsClient.connect(port, { cookie: t.gm.cookie });
    clients.push(gm);
    await hello(gm, t.campaignId);
    const raw = new Uint8Array(640 * 480 * 4).fill(255);
    const jpg = Buffer.from(jpeg.encode({ data: raw, width: 640, height: 480 }, 90).data);
    const up = await uploadMap(t.gm.cookie, jpg, "m.jpg", "image/jpeg");
    for (const c of [
      { type: "scene.create", scene: scene(MAIN, { width: 640, height: 480, map: { assetId: up.assetId, url: up.url } }) },
      { type: "scene.activate", sceneId: MAIN },
      { type: "fog.enable", sceneId: MAIN, initial: "covered" },
      { type: "fog.reveal", sceneId: MAIN, shape: { kind: "rect", x: 0, y: 0, width: 140, height: 140 }, target: { kind: "all" } },
    ] as Command[]) {
      expect((await command(gm, c)).type).toBe("ack");
    }
    const r = await tile(t, t.p1.cookie, 0, 0);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    const img = jpeg.decode(r.rawPayload, { useTArray: true });
    expect([img.width, img.height]).toEqual([512, 480]);
    expect(img.data[(10 * 512 + 10) * 4]).toBeGreaterThan(240);
    expect(img.data[(300 * 512 + 300) * 4]).toBeLessThan(15);

    // WebP: decodifica WebAssembly (libwebp via @jsquash/webp).
    const { default: encode, init } = (await import("@jsquash/webp/encode.js")) as unknown as {
      default: (img: { data: Uint8ClampedArray; width: number; height: number }, o: object) => Promise<ArrayBuffer>;
      init: (m: WebAssembly.Module) => Promise<unknown>;
    };
    const { createRequire } = await import("node:module");
    const { readFile } = await import("node:fs/promises");
    const req = createRequire(import.meta.url);
    await init(await WebAssembly.compile(await readFile(req.resolve("@jsquash/webp/codec/enc/webp_enc.wasm"))));
    const webp = Buffer.from(await encode({ data: new Uint8ClampedArray(raw.buffer), width: 640, height: 480 }, { quality: 90 }));
    const decoded = await decodeImage(webp, "image/webp");
    expect([decoded.width, decoded.height]).toEqual([640, 480]);
    expect(decoded.data[0]).toBeGreaterThan(240);
  });
});

