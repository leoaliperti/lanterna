// @vitest-environment node
/**
 * Integrazione: il vero client WebSocket (`RealtimeClient`) contro il vero server (`buildApp` con un
 * database SQLite temporaneo, cancellato a fine test). Un GM e un giocatore connessi insieme.
 * I test del server (packages/server) forniscono gli helper per avviare app, utenti e campagna.
 */
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DEFAULT_GRID, DEFAULT_SCALE, type Command, type Scene, type Token } from "@lanterna/shared";
import { ORIGIN, createTestApp, type TestContext } from "../../server/src/test/helpers";
import { createTable } from "../../server/src/test/campaign";
import { listen } from "../../server/src/test/ws";
import { RealtimeClient, type SocketLike } from "../src/realtime/RealtimeClient";

let ctx: TestContext | undefined;
const sockets: WebSocket[] = [];
const clients: RealtimeClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const s of sockets.splice(0)) s.terminate();
  await ctx?.close();
  ctx = undefined;
});

interface Player {
  client: RealtimeClient;
  traffic: string[];
  sockets: WebSocket[];
}

function connect(port: number, campaignId: string, cookie: string): Player {
  const traffic: string[] = [];
  const mine: WebSocket[] = [];
  const client = new RealtimeClient({
    campaignId,
    url: `ws://127.0.0.1:${port}/ws`,
    backoff: { baseMs: 20, maxMs: 60 },
    createSocket: (url) => {
      const ws = new WebSocket(url, { headers: { cookie, origin: ORIGIN } });
      ws.on("message", (d) => traffic.push(d.toString("utf8")));
      sockets.push(ws);
      mine.push(ws);
      return ws as unknown as SocketLike;
    }
  });
  clients.push(client);
  client.start();
  return { client, traffic, sockets: mine };
}

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const scene = (id: string): Scene => ({
  id,
  name: "Taverna",
  map: null,
  width: 1400,
  height: 1000,
  grid: { ...DEFAULT_GRID },
  scale: { ...DEFAULT_SCALE }
});

const token = (id: string, over: Partial<Token>): Token => ({
  id,
  sceneId: "scn",
  name: id,
  imageUrl: null,
  x: 105,
  y: 105,
  size: 1,
  rotation: 0,
  ownerUserId: null,
  kind: "pc",
  hidden: false,
  conditions: [],
  health: null,
  gmNotes: "",
  ...over
});

async function must(p: ReturnType<RealtimeClient["sendCommand"]>) {
  const r = await p;
  if (!r.ok) throw new Error(`comando rifiutato: ${r.code} ${r.message}`);
  return r;
}

describe("client reale contro server reale", () => {
  it("GM e giocatore: snapshot filtrato, delta, permessi, riconnessione con delta e annulla", async () => {
    ctx = await createTestApp();
    const port = await listen(ctx);
    const t = await createTable(ctx);
    const gm = connect(port, t.campaignId, t.gm.cookie);
    const p1 = connect(port, t.campaignId, t.p1.cookie);
    await until(() => gm.client.getState().status === "connected" && p1.client.getState().status === "connected", "connessione");

    // Il GM prepara il tavolo.
    const cmds: Command[] = [
      { type: "scene.create", scene: scene("scn") },
      { type: "scene.activate", sceneId: "scn" },
      { type: "token.create", token: token("eroe", { name: "Eroe", ownerUserId: t.p1.id, health: { current: 10, max: 31, temp: 0 }, gmNotes: "NOTA-SEGRETA" }) },
      { type: "token.create", token: token("altro", { name: "Altro", x: 245, health: { current: 5, max: 77, temp: 0 } }) },
      { type: "token.create", token: token("ombra", { name: "OmbraNascosta", hidden: true, x: 385 }) }
    ];
    for (const c of cmds) await must(gm.client.sendCommand(c));

    const gmView = () => gm.client.getState().view!;
    const pView = () => p1.client.getState().view!;
    await until(() => pView().tokens.length === 2, "il giocatore riceve i token visibili");

    // GM: vede tutto. Giocatore: solo cio' che il server gli invia.
    expect(gmView().tokens.map((x) => x.id)).toEqual(["eroe", "altro", "ombra"]);
    expect(gmView().tokens[0]!.gmNotes).toBe("NOTA-SEGRETA");
    expect(pView().tokens.map((x) => x.id)).toEqual(["eroe", "altro"]);
    expect(pView().tokens[0]!.health).toEqual({ current: 10, max: 31, temp: 0 });
    expect(pView().tokens[1]!.health).toBeNull();
    const seen = p1.traffic.join("\n");
    for (const secret of ["OmbraNascosta", "NOTA-SEGRETA", "\"max\":77"]) expect(seen).not.toContain(secret);

    // Il giocatore sposta il proprio token: ack, e il GM lo vede (via delta).
    const before = gmView().version;
    await must(p1.client.sendCommand({ type: "token.move", tokenId: "eroe", x: 315, y: 175, snap: false }));
    await until(() => gmView().tokens[0]!.x === 315, "il GM vede lo spostamento");
    expect(gmView().version).toBeGreaterThan(before);

    // Permessi: token altrui, campo riservato, token nascosto, comando da GM.
    const other = await p1.client.sendCommand({ type: "token.move", tokenId: "altro", x: 10, y: 10 });
    expect(other).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const gmOnly = await p1.client.sendCommand({ type: "token.update", tokenId: "eroe", patch: { size: 3 } });
    expect(gmOnly).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const hidden = await p1.client.sendCommand({ type: "token.move", tokenId: "ombra", x: 10, y: 10 });
    expect(hidden).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const dup = await gm.client.sendCommand({ type: "token.create", token: token("eroe", {}) });
    expect(dup).toMatchObject({ ok: false, code: "CONFLICT" });
    const bad = await gm.client.sendCommand({ type: "token.move", tokenId: "eroe", x: 99999, y: 1 });
    expect(bad).toMatchObject({ ok: false, code: "INVALID" });
    expect(await p1.client.sendCommand({ type: "scene.delete", sceneId: "scn" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(pView().tokens[0]!.x).toBe(315); // niente e' cambiato

    // Riconnessione: il GM cade, il giocatore agisce, il GM torna e si riallinea.
    const gmSocket = gm.sockets[0]!;
    gmSocket.terminate();
    await until(() => gm.client.getState().status !== "connected", "il GM risulta disconnesso");
    await must(p1.client.sendCommand({ type: "token.update", tokenId: "eroe", patch: { conditions: [{ id: "prone", name: "Prono" }] } }));
    await until(() => gm.client.getState().status === "connected", "riconnessione del GM");
    expect(gm.sockets.length).toBeGreaterThan(1);
    await until(() => gmView().tokens[0]!.conditions.length === 1, "il GM recupera la modifica persa");
    expect(gmView().version).toBe(pView().version);

    // Annulla: il giocatore annulla la propria ultima azione (condizioni), il GM vede il ritorno.
    await must(p1.client.undo());
    await until(() => gmView().tokens[0]!.conditions.length === 0, "annullamento visibile al GM");
    // Un secondo annulla riporta indietro lo spostamento. Poi la cronologia del giocatore e' vuota:
    // le azioni del GM (creazione di scena e token) non sono sue e il server non le annulla.
    await must(p1.client.undo());
    await until(() => gmView().tokens[0]!.x === 105, "anche lo spostamento torna indietro");
    expect(await p1.client.undo()).toMatchObject({ ok: false });
    expect(gmView().tokens.map((x) => x.id)).toEqual(["eroe", "altro", "ombra"]);
  }, 30_000);

  it("un buco di versione (stato locale vecchio) si ripara con uno snapshot", async () => {
    ctx = await createTestApp();
    const port = await listen(ctx);
    const t = await createTable(ctx);
    const gm = connect(port, t.campaignId, t.gm.cookie);
    await until(() => gm.client.getState().status === "connected", "connessione");
    await must(gm.client.sendCommand({ type: "scene.create", scene: scene("scn") }));
    await must(gm.client.sendCommand({ type: "scene.activate", sceneId: "scn" }));
    await until(() => gm.client.getState().view?.scenes.length === 1, "stato locale");
    // Simula un client rimasto indietro: epoca sconosciuta al server => deve arrivare uno snapshot completo.
    const state = gm.client.getState();
    (gm.client as unknown as { state: typeof state }).state = { ...state, epoch: "epoca-vecchia" };
    gm.sockets[0]!.terminate();
    await until(() => gm.client.getState().status !== "connected", "caduta");
    await until(() => gm.client.getState().status === "connected" && gm.client.getState().epoch !== "epoca-vecchia", "snapshot dopo la riconnessione");
    expect(gm.client.getState().view?.scenes.map((s) => s.id)).toEqual(["scn"]);
  }, 30_000);

  it("sessione non valida: il server rifiuta l'upgrade e il client non resta in un ciclo infinito", async () => {
    ctx = await createTestApp();
    const port = await listen(ctx);
    const t = await createTable(ctx);
    let checks = 0;
    const client = new RealtimeClient({
      campaignId: t.campaignId,
      url: `ws://127.0.0.1:${port}/ws`,
      backoff: { baseMs: 5, maxMs: 10 },
      createSocket: (url) => {
        const ws = new WebSocket(url, { headers: { cookie: "lanterna.session_token=falso", origin: ORIGIN } });
        sockets.push(ws);
        return ws as unknown as SocketLike;
      },
      verifySession: async () => {
        checks += 1;
        return false; // il vero verifySession chiama get-session: qui la sessione e' scaduta
      }
    });
    clients.push(client);
    client.start();
    await until(() => client.getState().failure === "session", "abbandono per sessione scaduta");
    expect(checks).toBe(1);
  }, 30_000);
});
