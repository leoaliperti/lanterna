import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_CLIENT_MESSAGE_SIZE,
  PROTOCOL_VERSION,
  applyDelta,
  type CampaignView,
  type DeltaMessage,
  type SnapshotMessage,
} from "@lanterna/shared";
import { ORIGIN, createTestApp, loginAs, type TestContext } from "../test/helpers.js";
import { MAIN, SECRET, command, createTable, hello, populate, send, type Table } from "../test/campaign.js";
import { WsClient, listen, settle, upgradeStatus } from "../test/ws.js";
import { CLOSE } from "./hub.js";

let ctx: TestContext;
const clients: WsClient[] = [];
const cleanup: (() => void)[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await ctx?.close();
  for (const f of cleanup.splice(0)) f();
});

async function connect(port: number, cookie: string, opts: Parameters<typeof WsClient.connect>[1] = {}) {
  const c = await WsClient.connect(port, { cookie, ...opts });
  clients.push(c);
  return c;
}

/** Tavolo completo: server in ascolto, GM e due giocatori connessi, campagna popolata. */
async function table(tweak?: Parameters<typeof createTestApp>[1]) {
  ctx = await createTestApp({}, tweak);
  const port = await listen(ctx);
  const t = await createTable(ctx);
  const gm = await connect(port, t.gm.cookie);
  const p1 = await connect(port, t.p1.cookie);
  const p2 = await connect(port, t.p2.cookie);
  for (const c of [gm, p1, p2]) expect((await hello(c, t.campaignId)).type).toBe("snapshot");
  await populate(gm, t);
  await settle();
  return { port, t, gm, p1, p2 };
}

function lastView(c: WsClient): { view: CampaignView; epoch: string } {
  // Ricostruisce la vista del client applicando snapshot e delta come farebbe il browser.
  let view: CampaignView | null = null;
  let epoch = "";
  for (const m of c.messages) {
    if (m.type === "snapshot") {
      view = m.view;
      epoch = m.epoch;
    } else if (m.type === "delta" && view) {
      const r = applyDelta(view, epoch, m);
      if (!r.ok) throw new Error(`delta non applicabile: ${r.reason}`);
      view = r.view;
    }
  }
  if (!view) throw new Error("nessuno snapshot");
  return { view, epoch };
}

describe("WebSocket: autenticazione e origine prima dell'upgrade", () => {
  it("anonimo 401, origine sbagliata o assente 403, percorso sbagliato 404, sessione valida 101", async () => {
    ctx = await createTestApp();
    const port = await listen(ctx);
    const { cookie } = await loginAs(ctx.app, "player");
    expect(await upgradeStatus(port, {})).toBe(401);
    expect(await upgradeStatus(port, { cookie: "lanterna.session_token=falso" })).toBe(401);
    expect(await upgradeStatus(port, { cookie, origin: "https://evil.example" })).toBe(403);
    expect(await upgradeStatus(port, { cookie, origin: null })).toBe(403);
    expect(await upgradeStatus(port, { origin: "https://evil.example" })).toBe(403);
    expect(await upgradeStatus(port, { cookie, path: "/altro" })).toBe(404);
    expect(await upgradeStatus(port, { cookie })).toBe(101);
    expect(await upgradeStatus(port, { cookie, origin: "http://localhost:5173" })).toBe(101);
  });

  it("utente non membro: hello rifiutato come campagna inesistente", async () => {
    ctx = await createTestApp();
    const port = await listen(ctx);
    const t = await createTable(ctx);
    const outsider = await loginAs(ctx.app, "player");
    const c = await connect(port, outsider.cookie);
    const r = await hello(c, t.campaignId);
    expect(r).toMatchObject({ type: "error", code: "NOT_FOUND" });
    expect((await c.waitClose()).code).toBe(CLOSE.notFound);

    const c2 = await connect(port, t.p1.cookie);
    const r2 = await hello(c2, "campagna-inesistente");
    expect(r2).toMatchObject({ type: "error", code: "NOT_FOUND", message: (r as { message: string }).message });
  });

  it("versione del protocollo diversa: errore e chiusura", async () => {
    ctx = await createTestApp();
    const port = await listen(ctx);
    const t = await createTable(ctx);
    const c = await connect(port, t.p1.cookie);
    c.send({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1, campaignId: t.campaignId, lastVersion: null, epoch: null });
    expect(await c.nextOfType("error")).toMatchObject({ code: "INVALID" });
    expect((await c.waitClose()).code).toBe(CLOSE.badProtocol);
  });
});

describe("WebSocket: filtro per utente nel traffico reale", () => {
  it("un giocatore non riceve token nascosti, scene non attive, vita altrui né note del GM", async () => {
    const { t, gm, p1, p2 } = await table();
    // Il GM tocca dati invisibili ai giocatori: nessun byte deve arrivare loro.
    p1.skip();
    p2.skip();
    const before = { p1: p1.frames.length, p2: p2.frames.length };
    expect((await command(gm, { type: "token.move", tokenId: SECRET.hiddenId, x: 455, y: 315 })).type).toBe("ack");
    expect(
      (await command(gm, { type: "token.update", tokenId: "tok-p1", patch: { health: { current: 3, max: SECRET.p1HpMax, temp: 0 } } }))
        .type,
    ).toBe("ack");
    expect((await command(gm, { type: "token.update", tokenId: "tok-p2", patch: { gmNotes: `${SECRET.notes}-2` } })).type).toBe("ack");
    await settle();
    expect(p2.frames.length).toBe(before.p2); // vita di p1 e cose nascoste: niente per p2
    expect(p1.frames.length).toBe(before.p1 + 1); // solo la propria vita

    // Riconnessione con snapshot completo: ancora niente segreti.
    const p2b = await connect((ctx.app.server.address() as { port: number }).port, t.p2.cookie);
    expect((await hello(p2b, t.campaignId)).type).toBe("snapshot");

    for (const c of [p2, p2b]) {
      const traffic = c.traffic();
      expect(traffic).not.toContain(SECRET.hiddenId);
      expect(traffic).not.toContain(SECRET.hiddenName);
      expect(traffic).not.toContain(SECRET.prepSceneName);
      expect(traffic).not.toContain(SECRET.prepTokenName);
      expect(traffic).not.toContain(SECRET.notes);
      expect(traffic).not.toContain(String(SECRET.p1HpMax));
      expect(traffic).not.toContain("gmNotes");
      expect(traffic).toContain(String(SECRET.p2HpMax)); // la propria vita sì
    }
    const p1Traffic = p1.traffic();
    expect(p1Traffic).toContain(String(SECRET.p1HpMax));
    expect(p1Traffic).not.toContain(String(SECRET.p2HpMax));
    expect(p1Traffic).not.toContain(SECRET.hiddenName);
    expect(p1Traffic).not.toContain(SECRET.notes);

    // Il GM invece vede tutto.
    const gmTraffic = gm.traffic();
    for (const s of [SECRET.hiddenName, SECRET.prepSceneName, SECRET.notes, String(SECRET.p2HpMax)]) {
      expect(gmTraffic).toContain(s);
    }

    // La vista ricostruita dai delta coincide con uno snapshot nuovo (a parte la versione:
    // le modifiche invisibili non generano delta per p2).
    expect({ ...lastView(p2).view, version: 0 }).toEqual({ ...lastView(p2b).view, version: 0 });
  });

  it("un token rivelato arriva al giocatore, uno nascosto sparisce", async () => {
    const { gm, p2 } = await table();
    p2.skip();
    await command(gm, { type: "token.update", tokenId: SECRET.hiddenId, patch: { hidden: false } });
    const d = await p2.nextOfType("delta");
    expect(d.events).toEqual([expect.objectContaining({ type: "token.created" })]);
    await command(gm, { type: "token.update", tokenId: "tok-p1", patch: { hidden: true } });
    const d2 = await p2.nextOfType("delta");
    expect(d2.events).toEqual([{ type: "token.deleted", tokenId: "tok-p1" }]);
  });
});

describe("WebSocket: permessi dei comandi", () => {
  it("il giocatore muove il proprio token ma non quello altrui, né quello nascosto", async () => {
    const { t, gm, p1, p2 } = await table();
    const own = await command(p1, { type: "token.move", tokenId: "tok-p1", x: 175, y: 175 });
    expect(own.type).toBe("ack");
    const gmSees = await gm.nextOfType("delta");
    expect(gmSees.events[0]).toMatchObject({ type: "token.updated", tokenId: "tok-p1" });

    const other = await command(p2, { type: "token.move", tokenId: "tok-p1", x: 525, y: 525 });
    expect(other).toMatchObject({ type: "error", code: "FORBIDDEN" });
    const hidden = await command(p2, { type: "token.move", tokenId: SECRET.hiddenId, x: 525, y: 525 });
    const missing = await command(p2, { type: "token.move", tokenId: "non-esiste", x: 525, y: 525 });
    expect(hidden).toMatchObject({ type: "error", code: "NOT_FOUND" });
    expect({ ...hidden, requestId: "" }).toEqual({ ...missing, requestId: "" });

    // Nessun campo "userId" o simili accettato: l'attore è quello della sessione.
    const spoof = await command(p2, { type: "token.move", tokenId: "tok-p1", x: 525, y: 525, userId: t.p1.id });
    expect(spoof).toMatchObject({ type: "error", code: "INVALID" });
    const spoof2 = await send(p2, { type: "command", command: { type: "token.move", tokenId: "tok-p1", x: 1, y: 1 }, actor: { userId: t.p1.id, role: "admin" } } as never);
    expect(spoof2).toMatchObject({ type: "error", code: "INVALID" });

    const forbidden = await command(p2, { type: "token.delete", tokenId: "tok-p2" });
    expect(forbidden).toMatchObject({ type: "error", code: "FORBIDDEN" });

    const state = ctx.app.realtime.stateOf(t.campaignId)!.state;
    expect(state.tokens.find((x) => x.id === "tok-p1")).toMatchObject({ x: 175, y: 175 });
  });

  it("annulla/ripeti per utente", async () => {
    const { t, p1 } = await table();
    await command(p1, { type: "token.move", tokenId: "tok-p1", x: 175, y: 175 });
    expect((await send(p1, { type: "undo" })).type).toBe("ack");
    expect(ctx.app.realtime.stateOf(t.campaignId)!.state.tokens.find((x) => x.id === "tok-p1")).toMatchObject({ x: 105 });
    expect((await send(p1, { type: "redo" })).type).toBe("ack");
    expect(ctx.app.realtime.stateOf(t.campaignId)!.state.tokens.find((x) => x.id === "tok-p1")).toMatchObject({ x: 175 });
  });

  it("comandi prima di hello: errore", async () => {
    ctx = await createTestApp();
    const port = await listen(ctx);
    const t = await createTable(ctx);
    const c = await connect(port, t.gm.cookie);
    const r = await command(c, { type: "scene.activate", sceneId: null });
    expect(r).toMatchObject({ type: "error", code: "INVALID" });
  });
});

describe("WebSocket: robustezza", () => {
  it("messaggi malformati non fanno crollare il server", async () => {
    const { port, t, gm, p1 } = await table();
    for (const raw of ["non json", "{}", "[]", "null", '{"type":"command"}', '{"type":"hello","campaignId":{}}', "\u0000￿"]) {
      p1.sendRaw(raw);
      expect(await p1.nextOfType("error")).toMatchObject({ code: "INVALID" });
    }
    p1.sendRaw(Buffer.from([1, 2, 3]), true);
    expect(await p1.nextOfType("error")).toMatchObject({ message: "messaggio non testuale" });
    p1.send({ type: "command", requestId: "r-1", command: { type: "token.move", tokenId: "tok-p1", x: "1e400", y: null } });
    expect(await p1.nextOfType("error")).toMatchObject({ requestId: "r-1", code: "INVALID" });
    p1.send({ type: "ping" });
    expect((await p1.nextOfType("pong")).type).toBe("pong");

    // Messaggio oltre il limite: il socket viene chiuso (1009), il server resta su.
    const big = await connect(port, t.p2.cookie);
    big.sendRaw("x".repeat(MAX_CLIENT_MESSAGE_SIZE + 10));
    expect((await big.waitClose()).code).toBe(1009);

    expect((await command(gm, { type: "token.move", tokenId: "tok-p2", x: 595, y: 595 })).type).toBe("ack");
    const health = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
  });

  it("rate limit per connessione", async () => {
    ctx = await createTestApp({ WS_MESSAGES_PER_SECOND: "5", WS_MESSAGE_BURST: "5" });
    const port = await listen(ctx);
    const t = await createTable(ctx);
    const c = await connect(port, t.p1.cookie);
    for (let i = 0; i < 30; i++) c.send({ type: "ping" });
    expect(await c.next((m) => m.type === "error" && m.message === "troppi messaggi")).toBeTruthy();
    await settle();
    expect(c.messages.filter((m) => m.type === "pong").length).toBeLessThanOrEqual(6);
    // Continuare a martellare porta alla chiusura.
    for (let i = 0; i < 40; i++) c.send({ type: "ping" });
    expect((await c.waitClose()).code).toBe(CLOSE.policy);
  });

  it("keep-alive: la connessione che non risponde ai ping viene chiusa", async () => {
    ctx = await createTestApp({ WS_HEARTBEAT_MS: "100" });
    const port = await listen(ctx);
    const t = await createTable(ctx);
    const dead = await connect(port, t.p1.cookie, { autoPong: false });
    const live = await connect(port, t.p2.cookie);
    await hello(dead, t.campaignId);
    await hello(live, t.campaignId);
    await dead.waitClose(2000);
    await settle(300);
    expect(live.closed).toBeNull();
  });

  it("hello mancante: chiusura dopo il timeout", async () => {
    ctx = await createTestApp({ WS_HELLO_TIMEOUT_MS: "100" });
    const port = await listen(ctx);
    const { cookie } = await loginAs(ctx.app, "player");
    const c = await connect(port, cookie);
    expect((await c.waitClose()).code).toBe(CLOSE.helloTimeout);
  });
});

describe("WebSocket: riconnessione", () => {
  it("delta se il registro copre l'intervallo, snapshot con epoca diversa o prima connessione", async () => {
    const { port, t, gm, p1 } = await table();
    const before = lastView(p1);
    p1.close();
    await p1.waitClose();
    await command(gm, { type: "token.move", tokenId: "tok-p2", x: 595, y: 595 });
    await command(gm, { type: "token.move", tokenId: SECRET.hiddenId, x: 665, y: 665 });

    const again = await connect(port, t.p1.cookie);
    const r = (await hello(again, t.campaignId, before.view.version, before.epoch)) as DeltaMessage;
    expect(r.type).toBe("delta");
    expect(r.fromVersion).toBe(before.view.version);
    expect(r.events).toHaveLength(1); // solo il token visibile
    const applied = applyDelta(before.view, before.epoch, r);
    expect(applied.ok).toBe(true);

    const fresh = (await hello(again, t.campaignId)) as SnapshotMessage;
    expect(fresh.type).toBe("snapshot");
    expect(applied.ok && applied.view).toEqual(fresh.view);

    const wrongEpoch = await hello(again, t.campaignId, before.view.version, "altra-epoca");
    expect(wrongEpoch.type).toBe("snapshot");
    const future = await hello(again, t.campaignId, 10_000, before.epoch);
    expect(future.type).toBe("snapshot");
  });

  it("stato intatto dopo il riavvio del server (ricarica da SQLite), delta anche attraverso il riavvio", async () => {
    const dbPath = join(tmpdir(), `lanterna-restart-${randomUUID()}.db`);
    const uploadDir = join(tmpdir(), `lanterna-restart-uploads-${randomUUID()}`);
    cleanup.push(() => {
      for (const s of ["", "-wal", "-shm"]) rmSync(dbPath + s, { force: true });
      rmSync(uploadDir, { recursive: true, force: true });
    });
    ctx = await createTestApp({}, undefined, { dbPath, uploadDir });
    let port = await listen(ctx);
    const t: Table = await createTable(ctx);
    let gm = await connect(port, t.gm.cookie);
    let p1 = await connect(port, t.p1.cookie);
    await hello(gm, t.campaignId);
    await hello(p1, t.campaignId);
    await populate(gm, t);
    await command(p1, { type: "token.move", tokenId: "tok-p1", x: 175, y: 175 });
    await settle();
    const p1Before = lastView(p1);
    // Un'altra modifica che p1 non vedrà finché non si riconnette.
    await command(gm, { type: "token.move", tokenId: "tok-p2", x: 595, y: 595 });
    await command(gm, { type: "token.delete", tokenId: "tok-p1" });
    await command(gm, { type: "token.create", token: { ...p1Before.view.tokens.find((x) => x.id === "tok-p1")!, gmNotes: "" } });
    const stateBefore = structuredClone(ctx.app.realtime.stateOf(t.campaignId)!);
    const gmView = lastView(gm);

    for (const c of clients.splice(0)) c.ws.terminate();
    await ctx.close();

    ctx = await createTestApp({}, undefined, { dbPath, uploadDir });
    port = await listen(ctx);
    const after = ctx.app.realtime.stateOf(t.campaignId)!;
    expect(after.state).toEqual(stateBefore.state);
    expect(after.log.epoch).toBe(stateBefore.log.epoch);

    // Il GM era aggiornato: delta vuoto.
    gm = await connect(port, t.gm.cookie);
    const g = await hello(gm, t.campaignId, gmView.view.version, gmView.epoch);
    expect(g).toMatchObject({ type: "delta", events: [] });
    // p1 era indietro di tre versioni: delta dal registro salvato.
    p1 = await connect(port, t.p1.cookie);
    const d = (await hello(p1, t.campaignId, p1Before.view.version, p1Before.epoch)) as DeltaMessage;
    expect(d.type).toBe("delta");
    const applied = applyDelta(p1Before.view, p1Before.epoch, d);
    const fresh = (await hello(p1, t.campaignId)) as SnapshotMessage;
    expect(applied.ok && applied.view).toEqual(fresh.view);
    expect(fresh.view.tokens.map((x) => x.id)).toEqual(["tok-p2", "tok-p1"]); // z-order conservato

    // E si continua a giocare.
    expect((await command(p1, { type: "token.move", tokenId: "tok-p1", x: 245, y: 245 })).type).toBe("ack");
  });
});

describe("WebSocket: cambi di ruolo e appartenenza", () => {
  it("cambio di ruolo: le connessioni dell'utente vengono chiuse", async () => {
    const { t, p1, p2 } = await table();
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/admin/users/${t.p1.id}`,
      headers: { origin: ORIGIN, cookie: t.gm.cookie },
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(200);
    expect((await p1.waitClose()).code).toBe(CLOSE.permissionsChanged);
    // Gli altri ricevono uno snapshot con i membri aggiornati.
    const snap = await p2.nextOfType("snapshot");
    expect(snap.view.members.find((m) => m.userId === t.p1.id)?.role).toBe("admin");
    expect(p2.closed).toBeNull();
  });

  it("utente eliminato: connessioni chiuse e token senza proprietario", async () => {
    const { t, p1, p2 } = await table();
    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/admin/users/${t.p1.id}`,
      headers: { origin: ORIGIN, cookie: t.gm.cookie },
    });
    expect(res.statusCode).toBe(204);
    expect((await p1.waitClose()).code).toBe(CLOSE.permissionsChanged);
    const snap = await p2.nextOfType("snapshot");
    expect(snap.view.members.some((m) => m.userId === t.p1.id)).toBe(false);
    expect(snap.view.tokens.find((x) => x.id === "tok-p1")?.ownerUserId).toBeNull();
  });

  it("membro rimosso dalla campagna: disconnesso e non può rientrare", async () => {
    const { port, t, p1 } = await table();
    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/campaigns/${t.campaignId}/members/${t.p1.id}`,
      headers: { origin: ORIGIN, cookie: t.gm.cookie },
    });
    expect(res.statusCode).toBe(204);
    expect((await p1.waitClose()).code).toBe(CLOSE.permissionsChanged);
    const again = await connect(port, t.p1.cookie);
    expect(await hello(again, t.campaignId)).toMatchObject({ type: "error", code: "NOT_FOUND" });
  });

  it("logout: la sessione revocata chiude il socket al keep-alive successivo", async () => {
    ctx = await createTestApp({ WS_HEARTBEAT_MS: "100" });
    const port = await listen(ctx);
    const t = await createTable(ctx);
    const c = await connect(port, t.p1.cookie);
    await hello(c, t.campaignId);
    const out = await ctx.app.inject({ method: "POST", url: "/auth/sign-out", headers: { origin: ORIGIN, cookie: t.p1.cookie } });
    expect(out.statusCode).toBe(200);
    expect((await c.waitClose(2000)).code).toBe(CLOSE.sessionEnded);
  });

  it("scena attiva: il cambio arriva ai giocatori", async () => {
    const { gm, p2 } = await table();
    p2.skip();
    await command(gm, { type: "scene.activate", sceneId: null });
    const d = await p2.nextOfType("delta");
    expect(d.events).toEqual([{ type: "scene.activated", sceneId: null, scene: null, tokens: [] }]);
    await command(gm, { type: "scene.activate", sceneId: MAIN });
    const d2 = await p2.nextOfType("delta");
    expect(d2.events[0]).toMatchObject({ type: "scene.activated", sceneId: MAIN });
    expect(JSON.stringify(d2)).not.toContain(SECRET.hiddenName);
  });
});
