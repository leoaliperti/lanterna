import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import type { Command, ServerMessage, UploadResponse } from "@lanterna/shared";
import { MAIN, SECRET, command, createTable, hello, populate, send, token, type Table } from "../test/campaign.js";
import { ORIGIN, createTestApp, type TestContext } from "../test/helpers.js";
import { multipart } from "../test/images.js";
import { WsClient, listen, settle, upgradeStatus } from "../test/ws.js";
import { parseViewOptions } from "./server.js";

/**
 * Finestre multiple e vista giocatore (M9) con WebSocket e HTTP reali.
 * Il GM apre `/ws?viewAs=<A>`: il server filtra tutto con l'attore di A (stessi byte di A),
 * la connessione è in sola lettura e un giocatore non può usarla per guardare come un altro.
 */

/** Stringhe distintive (non numeri corti: gli UUID darebbero falsi positivi). */
const ONLY_B = { tokenId: "tok-solo-per-b", name: "SegretoSoloPerB-VIEWAS" };
const DARK = { tokenId: "tok-nel-buio", name: "NelBuioVIEWAS-XYZ" };
const WHISPER_B = "SussurroSoloPerB-VIEWAS";
const WHISPER_A = "SussurroPerA-VIEWAS";
const SECRET_ROLL_LABEL = "TiroSegretoDelGM-VIEWAS";

const W = 1400;
const H = 1000;
const ROOM_A = { kind: "rect", x: 0, y: 0, width: 280, height: 210 } as const;
const ROOM_B = { kind: "rect", x: 980, y: 630, width: 420, height: 370 } as const;

let ctx: TestContext | undefined;
let clients: WsClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await ctx?.close();
  ctx = undefined;
});

async function connect(port: number, cookie: string, path = "/ws"): Promise<WsClient> {
  const c = await WsClient.connect(port, { cookie, path });
  clients.push(c);
  return c;
}

async function request(c: WsClient, msg: Record<string, unknown>) {
  const requestId = randomUUID();
  c.send({ ...msg, requestId });
  return c.next<Extract<ServerMessage, { type: "ack" | "error" }>>(
    (m) => (m.type === "ack" || m.type === "error" || m.type === "chat.message" || m.type === "roll.result") && "requestId" in m && m.requestId === requestId,
  );
}

function patternPng(): Buffer {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) {
    png.data[i * 4] = i % 256;
    png.data[i * 4 + 1] = 90;
    png.data[i * 4 + 2] = 200;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function uploadMap(cookie: string): Promise<UploadResponse> {
  const body = multipart(patternPng(), "mappa.png", "image/png");
  const res = await ctx!.app.inject({ method: "POST", url: "/uploads/map", headers: { ...body.headers, origin: ORIGIN, cookie }, payload: body.payload });
  expect(res.statusCode).toBe(201);
  return res.json() as UploadResponse;
}

/** Tavolo con nebbia: A (p1) vede la stanza in alto a sinistra, B (p2) quella in basso a destra. */
async function setup(): Promise<{ t: Table; port: number; gm: WsClient }> {
  ctx = await createTestApp();
  const t = await createTable(ctx);
  const port = await listen(ctx);
  const gm = await connect(port, t.gm.cookie);
  await hello(gm, t.campaignId);
  await populate(gm, t);
  const map = await uploadMap(t.gm.cookie);
  const cmds: Command[] = [
    { type: "scene.update", sceneId: MAIN, patch: { map: { assetId: map.assetId, url: map.url } } },
    { type: "fog.enable", sceneId: MAIN, initial: "covered" },
    { type: "fog.reveal", sceneId: MAIN, shape: ROOM_A, target: { kind: "players", userIds: [t.p1.id] } },
    { type: "fog.reveal", sceneId: MAIN, shape: ROOM_B, target: { kind: "players", userIds: [t.p2.id] } },
    { type: "token.create", token: token(ONLY_B.tokenId, { name: ONLY_B.name, x: 1155, y: 805 }) },
    { type: "token.create", token: token(DARK.tokenId, { name: DARK.name, x: 735, y: 455 }) },
  ];
  for (const c of cmds) expect((await command(gm, c)).type, c.type).toBe("ack");
  return { t, port, gm };
}

const tile = (t: Table, cookie: string, col: number, row: number, query = "") =>
  ctx!.app.inject({ method: "GET", url: `/campaigns/${t.campaignId}/scenes/${MAIN}/tiles/${col}/${row}${query}`, headers: { cookie } });

describe("parametri del percorso /ws", () => {
  it("viewAs implica la sola lettura; valori non validi rifiutati", () => {
    expect(parseViewOptions(new URLSearchParams(""))).toEqual({ viewAs: null, readOnly: false });
    expect(parseViewOptions(new URLSearchParams("readOnly=1"))).toEqual({ viewAs: null, readOnly: true });
    expect(parseViewOptions(new URLSearchParams("viewAs=abc"))).toEqual({ viewAs: "abc", readOnly: true });
    expect(parseViewOptions(new URLSearchParams("viewAs=abc&readOnly=0"))).toEqual({ viewAs: "abc", readOnly: true });
    expect(parseViewOptions(new URLSearchParams("viewAs=../x"))).toBeNull();
    expect(parseViewOptions(new URLSearchParams("viewAs="))).toBeNull();
    expect(parseViewOptions(new URLSearchParams("viewAs=a&viewAs=b"))).toBeNull();
    expect(parseViewOptions(new URLSearchParams("readOnly=si"))).toBeNull();
  });
});

describe("vista giocatore: il GM riceve esattamente ciò che riceve A", () => {
  it("stessi byte di A (snapshot, delta, chat, tiri, effimeri) e nulla di ciò che A non vede", async () => {
    const { t, port, gm } = await setup();
    const a = await connect(port, t.p1.cookie);
    const b = await connect(port, t.p2.cookie);
    const asA = await connect(port, t.gm.cookie, `/ws?viewAs=${t.p1.id}`);
    expect((await hello(a, t.campaignId)).type).toBe("snapshot");
    expect((await hello(b, t.campaignId)).type).toBe("snapshot");
    expect((await hello(asA, t.campaignId)).type).toBe("snapshot");
    await a.nextOfType("history");
    await asA.nextOfType("history");

    // Attività di GM e B dopo la connessione: movimenti nel buio e nella stanza di A, nebbia, chat, tiri.
    const actions: Command[] = [
      { type: "token.move", tokenId: DARK.tokenId, x: 843.5, y: 525.25, snap: false },
      { type: "token.move", tokenId: "tok-p1", x: 175, y: 105 },
      { type: "fog.reveal", sceneId: MAIN, shape: { kind: "rect", x: 280, y: 0, width: 140, height: 210 }, target: { kind: "players", userIds: [t.p1.id] } },
      { type: "token.update", tokenId: SECRET.hiddenId, patch: { gmNotes: "AltraNotaGM-VIEWAS" } },
    ];
    for (const c of actions) expect((await command(gm, c)).type, c.type).toBe("ack");
    expect((await request(gm, { type: "chat.send", text: WHISPER_B, whisperTo: t.p2.id })).type).toBe("chat.message");
    expect((await request(gm, { type: "chat.send", text: WHISPER_A, whisperTo: t.p1.id })).type).toBe("chat.message");
    expect((await request(gm, { type: "roll.request", formula: "1d20+7", visibility: "gm", label: SECRET_ROLL_LABEL })).type).toBe("roll.result");
    expect((await request(b, { type: "chat.send", text: "ciao a tutti" })).type).toBe("chat.message");
    expect(
      (await request(gm, { type: "ephemeral.show", id: "ping-1", sceneId: MAIN, audience: "all", shape: { kind: "ping", x: 100, y: 100 } })).type,
    ).toBe("ack");
    await settle(200);

    // Stessa sequenza di frame, byte per byte (nessuno dei due ha inviato richieste proprie).
    expect(asA.frames.length).toBeGreaterThan(4);
    expect(asA.frames).toEqual(a.frames);

    const traffic = asA.traffic();
    for (const s of [
      SECRET.hiddenName,
      SECRET.hiddenId,
      SECRET.prepSceneName,
      SECRET.prepTokenName,
      SECRET.notes,
      ONLY_B.name,
      ONLY_B.tokenId,
      DARK.name,
      DARK.tokenId,
      "843.5",
      WHISPER_B,
      SECRET_ROLL_LABEL,
      "/assets/",
      `"userId":"${t.p2.id}","mask"`,
    ]) {
      expect(traffic, s).not.toContain(s);
    }
    expect(traffic).toContain(WHISPER_A);
  });

  it("la cronologia richiesta dalla vista è quella di A", async () => {
    const { t, port, gm } = await setup();
    expect((await request(gm, { type: "chat.send", text: WHISPER_B, whisperTo: t.p2.id })).type).toBe("chat.message");
    expect((await request(gm, { type: "chat.send", text: WHISPER_A, whisperTo: t.p1.id })).type).toBe("chat.message");
    const a = await connect(port, t.p1.cookie);
    const asA = await connect(port, t.gm.cookie, `/ws?viewAs=${t.p1.id}`);
    const pages: string[] = [];
    for (const c of [a, asA]) {
      await hello(c, t.campaignId);
      await c.nextOfType("history");
      // La lettura della cronologia è ammessa anche in sola lettura.
      c.send({ type: "history.request", requestId: "pagina", before: null });
      const page = await c.next((m) => m.type === "history" && m.requestId === "pagina");
      pages.push(JSON.stringify(page));
    }
    expect(pages[1]).toBe(pages[0]);
    expect(pages[1]).toContain(WHISPER_A);
    expect(pages[1]).not.toContain(WHISPER_B);
  });
});

describe("vista giocatore: sola lettura e permessi", () => {
  it("comandi, annulla, chat, tiri, iniziativa ed effimeri dalla vista sono FORBIDDEN e non cambiano nulla", async () => {
    const { t, port } = await setup();
    const asA = await connect(port, t.gm.cookie, `/ws?viewAs=${t.p1.id}`);
    await hello(asA, t.campaignId);
    const before = ctx!.app.realtime.stateOf(t.campaignId)!.state.version;
    const attempts: Record<string, unknown>[] = [
      { type: "command", command: { type: "token.move", tokenId: "tok-p1", x: 35, y: 35 } },
      { type: "command", command: { type: "scene.activate", sceneId: null } },
      { type: "undo" },
      { type: "redo" },
      { type: "chat.send", text: "come A" },
      { type: "roll.request", formula: "1d20", visibility: "public" },
      { type: "initiative.roll", sceneId: MAIN, rolls: [{ participantId: "x", bonus: 1 }] },
      { type: "ephemeral.show", id: "e1", sceneId: MAIN, audience: "all", shape: { kind: "ping", x: 10, y: 10 } },
      { type: "ephemeral.clear", id: "e1" },
    ];
    for (const msg of attempts) {
      const r = await request(asA, msg);
      expect(r, String(msg.type)).toMatchObject({ type: "error", code: "FORBIDDEN" });
    }
    expect(ctx!.app.realtime.stateOf(t.campaignId)!.state.version).toBe(before);
    const log = await ctx!.app.inject({ method: "GET", url: `/campaigns/${t.campaignId}/log`, headers: { cookie: t.gm.cookie } });
    expect(log.body).not.toContain("come A");
  });

  it("un giocatore non può guardare come un altro (403 prima dell'handshake); come se stesso sì, in sola lettura", async () => {
    const { t, port } = await setup();
    expect(await upgradeStatus(port, { cookie: t.p1.cookie, path: `/ws?viewAs=${t.p2.id}` })).toBe(403);
    expect(await upgradeStatus(port, { cookie: t.p1.cookie, path: `/ws?viewAs=${t.gm.id}` })).toBe(403);
    expect(await upgradeStatus(port, { cookie: t.gm.cookie, path: "/ws?viewAs=../../x" })).toBe(400);

    const self = await connect(port, t.p1.cookie, `/ws?viewAs=${t.p1.id}`);
    expect((await hello(self, t.campaignId)).type).toBe("snapshot");
    expect(await send(self, { type: "command", command: { type: "token.move", tokenId: "tok-p1", x: 35, y: 35 } })).toMatchObject({
      code: "FORBIDDEN",
    });

    // readOnly=1: la finestra del proiettore di un utente qualsiasi non invia nulla.
    const ro = await connect(port, t.p2.cookie, "/ws?readOnly=1");
    expect((await hello(ro, t.campaignId)).type).toBe("snapshot");
    expect(await send(ro, { type: "command", command: { type: "token.move", tokenId: "tok-p2", x: 35, y: 35 } })).toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("utente guardato non membro: FORBIDDEN con messaggio fisso e chiusura 4403", async () => {
    const { t, port } = await setup();
    for (const target of ["utente-inesistente", randomUUID()]) {
      const c = await connect(port, t.gm.cookie, `/ws?viewAs=${target}`);
      const r = await hello(c, t.campaignId);
      expect(r).toMatchObject({ type: "error", code: "FORBIDDEN", message: "vista non consentita" });
      expect((await c.waitClose()).code).toBe(4403);
    }
  });

  it("se A esce dalla campagna la vista come A si chiude (4403)", async () => {
    const { t, port } = await setup();
    const asA = await connect(port, t.gm.cookie, `/ws?viewAs=${t.p1.id}`);
    await hello(asA, t.campaignId);
    const res = await ctx!.app.inject({
      method: "DELETE",
      url: `/campaigns/${t.campaignId}/members/${t.p1.id}`,
      headers: { origin: ORIGIN, cookie: t.gm.cookie },
    });
    expect(res.statusCode).toBe(204);
    expect((await asA.waitClose()).code).toBe(4403);
  });
});

describe("vista giocatore: tessere della mappa come A", () => {
  it("il GM con ?viewAs riceve le stesse tessere di A; un giocatore non può chiederle per altri", async () => {
    const { t } = await setup();
    const mine = await tile(t, t.p1.cookie, 0, 0);
    const asA = await tile(t, t.gm.cookie, 0, 0, `?viewAs=${t.p1.id}`);
    expect(mine.statusCode).toBe(200);
    expect(asA.statusCode).toBe(200);
    expect(Buffer.compare(asA.rawPayload, mine.rawPayload)).toBe(0);
    expect(asA.headers.etag).toBe(mine.headers.etag);
    // Senza viewAs il GM ha la tessera intera: diversa da quella mascherata.
    expect(Buffer.compare((await tile(t, t.gm.cookie, 0, 0)).rawPayload, mine.rawPayload)).not.toBe(0);
    // La stanza di B (in basso a destra) è coperta per A: stesso 404 di A.
    expect((await tile(t, t.gm.cookie, 2, 1, `?viewAs=${t.p1.id}`)).statusCode).toBe(404);
    expect((await tile(t, t.p1.cookie, 2, 1)).statusCode).toBe(404);
    // Giocatore: verso altri 403, verso se stesso come senza parametro, parametro non valido 404.
    expect((await tile(t, t.p1.cookie, 2, 1, `?viewAs=${t.p2.id}`)).statusCode).toBe(403);
    expect((await tile(t, t.p1.cookie, 0, 0, `?viewAs=${t.p1.id}`)).statusCode).toBe(200);
    expect((await tile(t, t.gm.cookie, 0, 0, "?viewAs=..%2Fx")).statusCode).toBe(404);
    expect((await tile(t, t.gm.cookie, 0, 0, `?viewAs=${randomUUID()}`)).statusCode).toBe(404);
    // Senza sessione: 401 come sempre.
    const anon = await ctx!.app.inject({ method: "GET", url: `/campaigns/${t.campaignId}/scenes/${MAIN}/tiles/0/0?viewAs=${t.p1.id}` });
    expect(anon.statusCode).toBe(401);
  });
});

describe("finestre multiple: sincronizzazione via WebSocket", () => {
  it("un token mosso in una finestra del GM compare nelle altre (GM, vista di A e A)", async () => {
    const { t, port, gm } = await setup();
    const second = await connect(port, t.gm.cookie);
    const asA = await connect(port, t.gm.cookie, `/ws?viewAs=${t.p1.id}`);
    const a = await connect(port, t.p1.cookie);
    for (const c of [second, asA, a]) await hello(c, t.campaignId);
    for (const c of [second, asA, a]) c.skip();
    expect((await command(gm, { type: "token.move", tokenId: "tok-p1", x: 245, y: 175, snap: false })).type).toBe("ack");
    for (const c of [second, asA, a]) {
      const d = await c.nextOfType("delta");
      expect(JSON.stringify(d.events)).toContain('"x":245');
    }
  });
});
