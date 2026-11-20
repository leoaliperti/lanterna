// @vitest-environment node
/**
 * Finestre multiple (M9) end-to-end: veri `RealtimeClient` contro il vero server.
 * - due finestre dello stesso GM (stesso cookie) restano sincronizzate solo tramite il server;
 * - la finestra "vista giocatore" (`?viewAs=`) ha esattamente la vista del giocatore, in sola lettura;
 * - le tessere della mappa si chiedono con la stessa identita'.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "@lanterna/shared";
import type { UploadResponse } from "@lanterna/shared";
import { ORIGIN, createTestApp, type TestContext } from "../../server/src/test/helpers";
import { makePng, multipart } from "../../server/src/test/images";
import { MAIN, SECRET, createTable, populate, token } from "../../server/src/test/campaign";
import { WsClient, listen } from "../../server/src/test/ws";
import { hello } from "../../server/src/test/campaign";
import { toMapFog } from "../src/table/adapter";
import { closeConnections, connect, until } from "./helpers";

let ctx: TestContext | undefined;
const raw: WsClient[] = [];

afterEach(async () => {
  closeConnections();
  for (const c of raw.splice(0)) c.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  ctx = await createTestApp();
  const port = await listen(ctx);
  const t = await createTable(ctx);
  // Il GM prepara il tavolo con un client grezzo (helper del server).
  const prep = await WsClient.connect(port, { cookie: t.gm.cookie });
  raw.push(prep);
  await hello(prep, t.campaignId);
  await populate(prep, t);
  return { port, t };
}

const connected = (p: { client: { getState(): { status: string; view: unknown } } }) => p.client.getState().status === "connected" && p.client.getState().view !== null;

describe("finestre multiple: sincronizzazione via WebSocket", () => {
  it("un token mosso nella finestra della mappa compare nel tavolo e nella vista giocatore", async () => {
    const { port, t } = await setup();
    const table = connect(port, t.campaignId, t.gm.cookie);
    const mapWindow = connect(port, t.campaignId, t.gm.cookie);
    const playerView = connect(port, t.campaignId, t.gm.cookie, `?viewAs=${t.p1.id}`);
    await until(() => [table, mapWindow, playerView].every(connected), "tre finestre connesse");

    const r = await mapWindow.client.sendCommand({ type: "token.move", tokenId: "tok-p1", x: 315, y: 245, snap: false });
    expect(r.ok).toBe(true);
    const at = (p: typeof table) => p.client.getState().view?.tokens.find((x) => x.id === "tok-p1");
    await until(() => at(table)?.x === 315 && at(playerView)?.x === 315, "spostamento nelle altre finestre");
    expect(at(table)?.y).toBe(245);
  });

  it("il GM puo' guardare un'altra scena in una finestra senza cambiare quella dei giocatori", async () => {
    const { port, t } = await setup();
    const scene = connect(port, t.campaignId, t.gm.cookie);
    const player = connect(port, t.campaignId, t.p1.cookie);
    await until(() => connected(scene) && connected(player), "connessione");
    // La finestra #/view/scene/<id> legge la scena dalla vista del GM: nessun comando.
    expect(scene.client.getState().view?.scenes.map((s) => s.id).sort()).toEqual([MAIN, "scn-prep"].sort());
    expect(player.client.getState().view?.activeSceneId).toBe(MAIN);
    expect(scene.traffic.join("\n")).not.toContain('"type":"ack"');
  });
});

describe("vista giocatore (viewAs) con il client reale", () => {
  it("stessa vista del giocatore, nessun segreto del GM, comandi e chat rifiutati", async () => {
    const { port, t } = await setup();
    const p1 = connect(port, t.campaignId, t.p1.cookie);
    const asP1 = connect(port, t.campaignId, t.gm.cookie, `?viewAs=${t.p1.id}`);
    const gm = connect(port, t.campaignId, t.gm.cookie);
    await until(() => [p1, asP1, gm].every(connected), "connessione");

    const cmds: Command[] = [
      { type: "token.update", tokenId: "tok-p2", patch: { health: { current: 3, max: SECRET.p2HpMax, temp: 0 } } },
      { type: "token.create", token: token("tok-new", { name: "NuovoNascostoE2E-XYZ", hidden: true }) },
      { type: "token.move", tokenId: "tok-p2", x: 455, y: 245, snap: false }
    ];
    for (const c of cmds) expect((await gm.client.sendCommand(c)).ok).toBe(true);
    await until(() => p1.client.getState().view?.version === gm.client.getState().view?.version, "p1 aggiornato");
    await until(() => asP1.client.getState().view?.version === gm.client.getState().view?.version, "vista aggiornata");

    expect(asP1.client.getState().view).toEqual(p1.client.getState().view);
    expect(asP1.client.getState().view?.viewer).toEqual({ userId: t.p1.id, role: "player" });
    const traffic = asP1.traffic.join("\n");
    for (const s of [SECRET.hiddenName, SECRET.notes, SECRET.prepSceneName, SECRET.prepTokenName, "NuovoNascostoE2E-XYZ"]) {
      expect(traffic, s).not.toContain(s);
    }

    const move = await asP1.client.sendCommand({ type: "token.move", tokenId: "tok-p1", x: 35, y: 35 });
    expect(move).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await asP1.client.undo()).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await asP1.client.sendChat("scritto come il giocatore")).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await asP1.client.sendRoll({ formula: "1d20", visibility: "public" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(p1.traffic.join("\n")).not.toContain("scritto come il giocatore");
  });

  it("un giocatore non puo' aprire la vista di un altro; se il giocatore esce la vista si ferma", async () => {
    const { port, t } = await setup();
    const sneaky = connect(port, t.campaignId, t.p1.cookie, `?viewAs=${t.p2.id}`);
    await new Promise((r) => setTimeout(r, 300));
    expect(sneaky.client.getState().view).toBeNull();
    expect(sneaky.traffic).toEqual([]); // 403 prima dell'handshake: nessun byte

    const asP2 = connect(port, t.campaignId, t.gm.cookie, `?viewAs=${t.p2.id}`);
    await until(() => connected(asP2), "vista connessa");
    const res = await ctx!.app.inject({
      method: "DELETE",
      url: `/campaigns/${t.campaignId}/members/${t.p2.id}`,
      headers: { origin: "http://localhost:3000", cookie: t.gm.cookie }
    });
    expect(res.statusCode).toBe(204);
    await until(() => asP2.client.getState().failure === "forbidden", "vista fermata");
  });

  it("le tessere della mappa si chiedono con la stessa identita' (?viewAs) e coincidono con quelle del giocatore", async () => {
    const { port, t } = await setup();
    const gm = connect(port, t.campaignId, t.gm.cookie);
    await until(() => connected(gm), "GM");
    const body = multipart(makePng(1400, 1000), "mappa.png", "image/png");
    const up = await ctx!.app.inject({ method: "POST", url: "/uploads/map", headers: { ...body.headers, origin: ORIGIN, cookie: t.gm.cookie }, payload: body.payload });
    const map = up.json() as UploadResponse;
    const cmds: Command[] = [
      { type: "scene.update", sceneId: MAIN, patch: { map: { assetId: map.assetId, url: map.url } } },
      { type: "fog.enable", sceneId: MAIN, initial: "covered" },
      { type: "fog.reveal", sceneId: MAIN, shape: { kind: "rect", x: 0, y: 0, width: 280, height: 210 }, target: { kind: "players", userIds: [t.p1.id] } }
    ];
    for (const c of cmds) expect((await gm.client.sendCommand(c)).ok).toBe(true);

    const asP1 = connect(port, t.campaignId, t.gm.cookie, `?viewAs=${t.p1.id}`);
    await until(() => !!asP1.client.getState().view?.fogs?.length, "vista con nebbia");
    const view = asP1.client.getState().view!;
    const scene = view.scenes.find((s) => s.id === MAIN)!;
    expect(scene.map).toBeNull(); // come per il giocatore: niente URL della mappa intera
    const fog = toMapFog(view, scene, { viewAs: null, showVeil: true, tilesAs: t.p1.id })!;
    expect(fog.opaque).toBe(true);
    expect(fog.tiles.map((x) => x.id)).toEqual(["0,0"]);
    const url = fog.tiles[0]!.url;
    expect(url).toContain(`viewAs=${t.p1.id}`);
    // In produzione il prefisso /api lo toglie il proxy; qui il server di prova e' senza prefisso.
    const asGm = await ctx!.app.inject({ method: "GET", url: url.replace(/^\/api/, ""), headers: { cookie: t.gm.cookie } });
    const own = await ctx!.app.inject({ method: "GET", url: `/campaigns/${t.campaignId}/scenes/${MAIN}/tiles/0/0`, headers: { cookie: t.p1.cookie } });
    expect(asGm.statusCode).toBe(200);
    expect(Buffer.compare(asGm.rawPayload, own.rawPayload)).toBe(0);
  });
});
