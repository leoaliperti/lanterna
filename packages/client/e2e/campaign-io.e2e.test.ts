// @vitest-environment node
/**
 * Integrazione: esportazione/importazione di campagna e libreria di token, con il vero server su una porta
 * (HTTP reale, multipart reale) e client WebSocket reali. Verifica che la campagna importata sia subito
 * giocabile, che i segreti restino segreti anche dopo l'importazione e che un giocatore non possa
 * esportare, importare ne' scrivere nella libreria. Tutti i dati sono FITTIZI.
 */
import { afterEach, describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import type { Command, ImportPreview, ImportResult, LibraryItem, UploadResponse } from "@lanterna/shared";
import { ORIGIN, createTestApp, type TestContext } from "../../server/src/test/helpers";
import { createTable, scene, token, MAIN, PREP } from "../../server/src/test/campaign";
import { makePng, multipart } from "../../server/src/test/images";
import { listen } from "../../server/src/test/ws";
import { instanceCommand } from "../src/library/libraryLogic";
import { closeConnections, connect, until } from "./helpers";

let ctx: TestContext | undefined;

afterEach(async () => {
  closeConnections();
  await ctx?.close();
  ctx = undefined;
});

const SECRET = { hidden: "OrcoNascostoIOXYZ", notes: "NOTA-GM-IO-XYZ", prep: "ScenaSegretaIOXYZ" };

async function must(p: Promise<{ ok: boolean; code?: string; message?: string }>) {
  const r = await p;
  if (!r.ok) throw new Error(`comando rifiutato: ${r.code} ${r.message}`);
}

async function setup() {
  ctx = await createTestApp();
  const port = await listen(ctx);
  const t = await createTable(ctx);
  const base = `http://127.0.0.1:${port}`;
  const http = async (cookie: string, method: string, path: string, body?: unknown) => {
    const isForm = body instanceof FormData;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin: ORIGIN, ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: isForm ? body : JSON.stringify(body) } : {})
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, text: buf.toString("utf8"), json: <T,>() => JSON.parse(buf.toString("utf8")) as T };
  };
  const m = multipart(makePng(64, 48), "mappa.png", "image/png");
  const up = await ctx.app.inject({ method: "POST", url: "/uploads/map", headers: { ...m.headers, origin: ORIGIN, cookie: t.gm.cookie }, payload: m.payload });
  const map = up.json() as UploadResponse;
  const gm = connect(port, t.campaignId, t.gm.cookie);
  await until(() => gm.client.getState().status === "connected", "GM connesso");
  const cmds: Command[] = [
    { type: "scene.create", scene: scene(MAIN, { name: "Taverna", map: { assetId: map.assetId, url: map.url } }) },
    { type: "scene.create", scene: scene(PREP, { name: SECRET.prep }) },
    { type: "scene.activate", sceneId: MAIN },
    { type: "token.create", token: token("tok-p1", { ownerUserId: t.p1.id, kind: "pc", name: "Eroe1", gmNotes: SECRET.notes, health: { current: 9, max: 9, temp: 0 } }) },
    { type: "token.create", token: token("tok-hid", { name: SECRET.hidden, hidden: true, x: 245 }) }
  ];
  for (const c of cmds) await must(gm.client.sendCommand(c));
  return { port, t, http, gm, map };
}

const importForm = (zip: Buffer, options?: unknown) => {
  const form = new FormData();
  if (options !== undefined) form.append("options", JSON.stringify(options));
  form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), "campagna.zip");
  return form;
};

describe("esportazione e importazione: server reale", () => {
  it("la campagna importata e' giocabile: il giocatore mappato vede i suoi token, i segreti restano segreti", async () => {
    const { port, t, http, map } = await setup();

    const exp = await http(t.gm.cookie, "GET", `/campaigns/${t.campaignId}/export`);
    expect(exp.status).toBe(200);
    const files = unzipSync(new Uint8Array(exp.buf));
    expect(Object.keys(files)).toContain("manifest.json");
    expect(strFromU8(files["manifest.json"]!)).toContain("lanterna-campaign");

    // Anteprima, poi importazione con il giocatore 1 associato e il giocatore 2 no.
    const pv = await http(t.gm.cookie, "POST", "/campaigns/import?preview=true", importForm(exp.buf));
    expect(pv.status, pv.text).toBe(200);
    expect(pv.json<ImportPreview>().counts).toMatchObject({ scenes: 2, tokens: 2, assets: 1 });
    expect(pv.json<ImportPreview>().members.map((x) => x.role)).toEqual(["admin", "player", "player"]);

    const refOfP1 = pv.json<ImportPreview>().members.find((x) => x.role === "player")!.ref;
    const imp = await http(t.gm.cookie, "POST", "/campaigns/import", importForm(exp.buf, { name: "Copia", memberMap: { [refOfP1]: t.p1.id } }));
    expect(imp.status, imp.text).toBe(201);
    const { campaign } = imp.json<ImportResult>();
    expect(campaign.id).not.toBe(t.campaignId);

    // Il GM apre la nuova campagna: stato completo, mappa servita con il nuovo nome.
    const gm2 = connect(port, campaign.id, t.gm.cookie);
    await until(() => !!gm2.client.getState().view, "GM sulla copia");
    const gv = gm2.client.getState().view!;
    expect(gv.name).toBe("Copia");
    expect(gv.tokens.map((x) => x.name).sort()).toEqual(["Eroe1", SECRET.hidden].sort());
    const newMap = gv.scenes.find((s) => s.map)!.map!;
    expect(newMap.url).not.toBe(map.url);
    expect((await http(t.gm.cookie, "GET", newMap.url)).status).toBe(200);

    // Il giocatore associato vede e possiede il suo token, ma non l'orco nascosto, le note del GM, ne' la scena segreta.
    const p1 = connect(port, campaign.id, t.p1.cookie);
    await until(() => !!p1.client.getState().view, "giocatore 1 sulla copia");
    const pview = p1.client.getState().view!;
    expect(pview.tokens.map((x) => x.name)).toEqual(["Eroe1"]);
    expect(pview.tokens[0]!.ownerUserId).toBe(t.p1.id);
    const traffic = p1.traffic.join("\n");
    for (const secret of [SECRET.hidden, SECRET.notes, SECRET.prep]) expect(traffic).not.toContain(secret);

    // Il giocatore non associato non e' membro della copia: nessun accesso.
    const mine = await http(t.p2.cookie, "GET", "/campaigns/mine");
    expect(mine.json<{ campaigns: { id: string }[] }>().campaigns.map((c) => c.id)).not.toContain(campaign.id);
    const p2 = connect(port, campaign.id, t.p2.cookie);
    await new Promise((r) => setTimeout(r, 300));
    expect(p2.client.getState().view).toBeNull();
    expect(p2.traffic.join("\n")).not.toContain(SECRET.hidden);
  }, 60_000);

  it("un giocatore riceve 403 su esportazione e importazione (e nulla viene creato)", async () => {
    const { t, http } = await setup();
    const zip = Buffer.from((await http(t.gm.cookie, "GET", `/campaigns/${t.campaignId}/export`)).buf);
    expect((await http(t.p1.cookie, "GET", `/campaigns/${t.campaignId}/export`)).status).toBe(403);
    expect((await http(t.p1.cookie, "POST", "/campaigns/import", importForm(zip))).status).toBe(403);
    expect((await http(t.p1.cookie, "POST", "/campaigns/import?preview=true", importForm(zip))).status).toBe(403);
    expect((await http(t.gm.cookie, "GET", "/campaigns")).json<{ campaigns: unknown[] }>().campaigns).toHaveLength(1);
  }, 30_000);

  it("un archivio rovinato in transito viene rifiutato con un messaggio chiaro", async () => {
    const { t, http } = await setup();
    const zip = Buffer.from((await http(t.gm.cookie, "GET", `/campaigns/${t.campaignId}/export`)).buf);
    const truncated = zip.subarray(0, Math.floor(zip.length * 0.6));
    const bad = await http(t.gm.cookie, "POST", "/campaigns/import", importForm(truncated));
    expect(bad.status).toBe(400);
    expect(bad.json<{ error: string }>().error).toMatch(/archivio|zip|incompleto|troncato|non valido/i);
    expect((await http(t.gm.cookie, "GET", "/campaigns")).json<{ campaigns: unknown[] }>().campaigns).toHaveLength(1);
  }, 30_000);
});

describe("libreria: server reale", () => {
  it("il GM salva un token nella libreria e ne crea un'istanza; il giocatore non scrive e di default non legge", async () => {
    const { port, t, http, gm } = await setup();
    const p1 = connect(port, t.campaignId, t.p1.cookie);
    await until(() => !!p1.client.getState().view, "giocatore connesso");

    const created = await http(t.gm.cookie, "POST", "/library", {
      name: "Goblin modello", kind: "monster", scope: "campaign", campaignId: t.campaignId, size: 1, imageUrl: null,
      stats: { hpMax: 7, armorClass: 15, speed: 30 }, tags: ["goblin"]
    });
    expect(created.status, created.text).toBe(201);
    const item = created.json<LibraryItem>();

    expect((await http(t.p1.cookie, "POST", "/library", { name: "x" })).status).toBe(403);
    expect((await http(t.p1.cookie, "DELETE", `/library/${item.id}`)).status).toBe(403);
    const asPlayer = await http(t.p1.cookie, "GET", `/library?campaignId=${t.campaignId}`);
    expect(asPlayer.json()).toEqual({ items: [], total: 0 });
    expect(asPlayer.text).not.toContain("Goblin modello");

    // Ricerca come fa il pannello, poi l'istanza con il comando token.create esistente.
    const found = await http(t.gm.cookie, "GET", `/library?campaignId=${t.campaignId}&q=gob`);
    const [hit] = found.json<{ items: LibraryItem[] }>().items;
    expect(hit!.id).toBe(item.id);
    const view = gm.client.getState().view!;
    const sc = view.scenes.find((s) => s.id === MAIN)!;
    await must(gm.client.sendCommand(instanceCommand(hit!, sc, view.tokens.filter((x) => x.sceneId === MAIN), crypto.randomUUID())));
    await until(() => p1.client.getState().view!.tokens.some((x) => x.name === "Goblin modello"), "istanza visibile al giocatore");
    const spawned = p1.client.getState().view!.tokens.find((x) => x.name === "Goblin modello")!;
    expect(spawned).toMatchObject({ kind: "monster", size: 1 });
    // I PF del mostro non arrivano al giocatore (filtro del server, come per ogni token).
    expect(spawned.health).toBeNull();
    // Un secondo clic crea un altro token con id diverso.
    await must(gm.client.sendCommand(instanceCommand(hit!, sc, gm.client.getState().view!.tokens, crypto.randomUUID())));
    await until(() => gm.client.getState().view!.tokens.filter((x) => x.name === "Goblin modello").length === 2, "seconda istanza");
  }, 30_000);
});
