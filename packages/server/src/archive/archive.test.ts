import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  blankDoc,
  type CampaignState,
  type ChatLogEntry,
  type Command,
  type ImportPreview,
  type ImportResult,
  type LibraryItem,
  type SheetRecord,
  type SheetSummary,
  type UploadResponse,
} from "@lanterna/shared";
import { buildZip, emptyDocs, importForm, type Entry } from "../test/archive.js";
import { MAIN, command, createTable, hello, populate, scene, token } from "../test/campaign.js";
import { ORIGIN, createTestApp, loginAs, type TestContext } from "../test/helpers.js";
import { makePng, multipart } from "../test/images.js";
import { WsClient, listen } from "../test/ws.js";

/**
 * Esportazione e importazione di campagne (M10) sul server vero: permessi, round-trip, archivi malevoli
 * (zip slip, bombe, file enormi, JSON non validi, SVG camuffato), transazionalità e assenza di segreti.
 * Tutti i dati sono FITTIZI.
 */

let ctx: TestContext;
let clients: WsClient[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const c of clients) c.ws.terminate();
  clients = [];
  for (const close of closers.splice(0)) await close();
});

async function startApp(env: NodeJS.ProcessEnv = {}) {
  const c = await createTestApp(env);
  ctx = c;
  closers.push(() => c.close());
}

const exportZip = (cookie: string, campaignId: string, chat = false) =>
  ctx.app.inject({ method: "GET", url: `/campaigns/${campaignId}/export${chat ? "?chat=true" : ""}`, headers: { cookie } });

const importZip = (cookie: string, zip: Uint8Array, options?: unknown, preview = false) => {
  const f = importForm(zip, options);
  return ctx.app.inject({
    method: "POST",
    url: `/campaigns/import${preview ? "?preview=true" : ""}`,
    headers: { ...f.headers, origin: ORIGIN, cookie },
    payload: f.payload,
  });
};

async function upload(cookie: string, kind: "map" | "token", png: Buffer): Promise<UploadResponse> {
  const body = multipart(png);
  const res = await ctx.app.inject({ method: "POST", url: `/uploads/${kind}`, headers: { ...body.headers, origin: ORIGIN, cookie }, payload: body.payload });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as UploadResponse;
}

async function rest<T = unknown>(cookie: string, method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, origin: ORIGIN },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.body, json: () => res.json() as T, raw: res };
}

async function ok(gm: WsClient, c: Command | Record<string, unknown>) {
  const r = await command(gm, c);
  if (r.type !== "ack") throw new Error(`comando rifiutato: ${r.message}`);
}

/** Campagna ricca: scene con mappa, token con immagine, nebbia, muri, combattimento, gruppo, schede, contenuti, libreria, chat. */
async function richCampaign() {
  await startApp();
  const t = await createTable(ctx);
  const port = await listen(ctx);
  const gm = await WsClient.connect(port, { cookie: t.gm.cookie });
  const p1 = await WsClient.connect(port, { cookie: t.p1.cookie });
  clients.push(gm, p1);
  await hello(gm, t.campaignId);
  await hello(p1, t.campaignId);
  await populate(gm, t);
  const map = await upload(t.gm.cookie, "map", makePng(64, 48));
  const tokenImg = await upload(t.gm.cookie, "token", makePng(16, 16));
  for (const c of [
    { type: "scene.update", sceneId: MAIN, patch: { map: { assetId: map.assetId, url: map.url } } },
    { type: "token.create", token: token("tok-img", { name: "Con immagine", imageUrl: tokenImg.url, x: 525 }) },
    { type: "fog.enable", sceneId: MAIN, initial: "covered" },
    { type: "fog.reveal", sceneId: MAIN, shape: { kind: "rect", x: 0, y: 0, width: 700, height: 300 }, target: { kind: "all" } },
    { type: "fog.reveal", sceneId: MAIN, shape: { kind: "rect", x: 700, y: 0, width: 300, height: 300 }, target: { kind: "players", userIds: [t.p1.id] } },
    { type: "wall.add", wall: { id: "wall-1", sceneId: MAIN, x1: 20, y1: 20, x2: 20, y2: 180, door: true, open: false } },
    { type: "combat.add", sceneId: MAIN, participant: { id: "pa", tokenId: "tok-p1", name: null, initiative: 18, hidden: false, hideInitiative: false } },
    { type: "combat.add", sceneId: MAIN, participant: { id: "pb", tokenId: "tok-p2", name: null, initiative: 9, hidden: false, hideInitiative: true } },
    { type: "combat.start", sceneId: MAIN },
    { type: "group.create", group: { id: "g1", name: "Gruppo uno", tokenIds: ["tok-p1", "tok-p2"] } },
  ] as Command[]) {
    await ok(gm, c);
  }
  // Chat e tiri (il tiro del GM è segreto, il whisper è del giocatore al GM).
  gm.send({ type: "chat.send", requestId: randomUUID(), text: "Benvenuti alla locanda" });
  await gm.nextOfType("chat.message");
  gm.send({ type: "roll.request", requestId: randomUUID(), formula: "2d6+3", visibility: "gm" });
  await gm.nextOfType("roll.result");
  p1.send({ type: "chat.send", requestId: randomUUID(), text: "Psst, al GM", whisperTo: t.gm.id });
  await p1.nextOfType("chat.message");
  // Schede, contenuti, libreria.
  const sheet = await rest<SheetRecord>(t.gm.cookie, "POST", `/campaigns/${t.campaignId}/sheets`, { kind: "pc", doc: blankDoc("Eroe Uno"), ownerUserId: t.p1.id, tokenId: "tok-p1" });
  expect(sheet.status, sheet.body).toBe(201);
  expect((await rest(t.gm.cookie, "POST", `/campaigns/${t.campaignId}/sheets`, { kind: "monster", doc: blankDoc("Mostro Due", "monster") })).status).toBe(201);
  const imp = await rest(t.gm.cookie, "POST", "/content/import", { campaignId: t.campaignId, items: [{ kind: "item", name: "Spada di prova", data: { peso: 3 } }] });
  expect(imp.status, imp.body).toBe(200);
  const lib = await rest<LibraryItem>(t.gm.cookie, "POST", "/library", {
    name: "Goblin modello", kind: "monster", scope: "campaign", campaignId: t.campaignId, size: 1, imageUrl: tokenImg.url,
    stats: { hpMax: 7, armorClass: 15, speed: 30 }, tags: ["goblin", "base"],
  });
  expect(lib.status, lib.body).toBe(201);
  return { t, port, gm, p1, map, tokenImg };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Stato con gli id sostituiti da segnaposto per posizione: due stati "uguali a meno degli id" danno la stessa stringa. */
function canon(state: CampaignState): string {
  let s = JSON.stringify({ ...state, campaignId: "C", version: 0 });
  const named: [string, string][] = [
    ...state.scenes.map((x, i): [string, string] => [x.id, `<S${i}>`]),
    ...state.tokens.map((x, i): [string, string] => [x.id, `<T${i}>`]),
    ...(state.walls ?? []).map((x, i): [string, string] => [x.id, `<W${i}>`]),
    ...(state.groups ?? []).map((x, i): [string, string] => [x.id, `<G${i}>`]),
  ];
  named.sort((a, b) => b[0].length - a[0].length);
  for (const [id, ph] of named) s = s.split(`"${id}"`).join(`"${ph}"`);
  const seen = new Map<string, string>();
  return s.replace(UUID, (u) => seen.get(u) ?? (seen.set(u, `<U${seen.size}>`), seen.get(u)!));
}

describe("esportazione", () => {
  it("contiene manifesto versionato, documenti e immagini, e nessun dato degli account né segreti", async () => {
    const { t } = await richCampaign();
    const res = await exportZip(t.gm.cookie, t.campaignId, true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment; filename="lanterna-campagna-di-prova-\d{8}\.zip"$/);
    const files = unzipSync(new Uint8Array(res.rawPayload));
    const names = Object.keys(files);
    expect(names).toEqual(expect.arrayContaining(["manifest.json", "campaign.json", "members.json", "scenes.json", "tokens.json", "fog.json", "walls.json", "combats.json", "groups.json", "sheets.json", "content.json", "library.json", "chat.json", "assets.json"]));
    expect(names.filter((n) => n.startsWith("assets/") && n !== "assets.json")).toHaveLength(2);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as Record<string, unknown> & { counts: Record<string, number> };
    expect(manifest.format).toBe("lanterna-campaign");
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.includesChat).toBe(true);
    expect(typeof manifest.appVersion).toBe("string");
    expect(Number.isNaN(Date.parse(String(manifest.exportedAt)))).toBe(false);
    expect(manifest.counts).toMatchObject({ scenes: 2, tokens: 5, walls: 1, fogs: 1, combats: 1, groups: 1, sheets: 2, content: 1, library: 1, assets: 2 });

    // Membri: solo nome e ruolo con un riferimento opaco.
    const members = JSON.parse(strFromU8(files["members.json"]!)) as Record<string, unknown>[];
    expect(members).toEqual([
      { ref: "m1", name: "admin", role: "admin" },
      { ref: "m2", name: "player", role: "player" },
      { ref: "m3", name: "player", role: "player" },
    ]);

    // Nessun id utente, email, hash, sessione o segreto in NESSUN file (immagini escluse).
    const all = Object.entries(files)
      .filter(([n]) => n.endsWith(".json"))
      .map(([, d]) => strFromU8(d))
      .join("\n");
    const forbidden: string[] = [ctx.config.authSecret, t.gm.id, t.p1.id, t.p2.id, "scrypt", "BETTER_AUTH", "password", "sessionToken", t.gm.cookie.split("=")[1]!.slice(0, 20)];
    for (const u of [t.gm, t.p1, t.p2]) forbidden.push((await ctx.app.users.findById(u.id))!.email);
    for (const f of forbidden) expect(all, f).not.toContain(f);
    // Il percorso del server non compare.
    expect(all).not.toContain(ctx.config.uploadDir);
  });

  it("senza ?chat la cronologia non è inclusa", async () => {
    const { t } = await richCampaign();
    const files = unzipSync(new Uint8Array((await exportZip(t.gm.cookie, t.campaignId)).rawPayload));
    expect(files["chat.json"]).toBeUndefined();
    expect((JSON.parse(strFromU8(files["manifest.json"]!)) as { includesChat: boolean }).includesChat).toBe(false);
  });

  it("solo admin: anonimo 401, giocatore 403 (anche con campagna inesistente), admin su campagna inesistente 404", async () => {
    await startApp();
    const t = await createTable(ctx);
    const zip = buildZip(emptyDocs());
    const f = importForm(zip);
    const anon = (method: "GET" | "POST", url: string) =>
      ctx.app.inject({ method, url, headers: method === "POST" ? { ...f.headers, origin: ORIGIN } : {}, ...(method === "POST" ? { payload: f.payload } : {}) });
    expect((await anon("GET", `/campaigns/${t.campaignId}/export`)).statusCode).toBe(401);
    expect((await anon("POST", "/campaigns/import")).statusCode).toBe(401);
    expect((await exportZip(t.p1.cookie, t.campaignId)).statusCode).toBe(403);
    expect((await exportZip(t.p1.cookie, "inesistente")).statusCode).toBe(403);
    const before = (await rest<{ campaigns: unknown[] }>(t.gm.cookie, "GET", "/campaigns")).json().campaigns.length;
    expect((await importZip(t.p1.cookie, zip)).statusCode).toBe(403);
    expect((await importZip(t.p1.cookie, zip, undefined, true)).statusCode).toBe(403);
    expect((await exportZip(t.gm.cookie, "inesistente")).statusCode).toBe(404);
    expect((await rest<{ campaigns: unknown[] }>(t.gm.cookie, "GET", "/campaigns")).json().campaigns.length).toBe(before);
  });

  it("rifiuta una campagna oltre il limite di dimensione, prima di inviare byte", async () => {
    await startApp({ ARCHIVE_MAX_BYTES: "2000" });
    const t = await createTable(ctx);
    const port = await listen(ctx);
    const gm = await WsClient.connect(port, { cookie: t.gm.cookie });
    clients.push(gm);
    await hello(gm, t.campaignId);
    await populate(gm, t);
    const big = await upload(t.gm.cookie, "map", makePng(200, 200));
    await ok(gm, { type: "scene.update", sceneId: MAIN, patch: { map: { assetId: big.assetId, url: big.url } } });
    const res = await exportZip(t.gm.cookie, t.campaignId);
    expect(res.statusCode).toBe(413);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});

describe("importazione: round-trip", () => {
  it("esporta, importa e ottiene una campagna uguale (a meno degli id), nuova, con epoca nuova e file con nomi nuovi", async () => {
    const { t, port, map } = await richCampaign();
    const original = ctx.app.realtime.stateOf(t.campaignId)!;
    const zip = (await exportZip(t.gm.cookie, t.campaignId, true)).rawPayload;

    // Anteprima: niente viene creato.
    const preview = await importZip(t.gm.cookie, zip, undefined, true);
    expect(preview.statusCode, preview.body).toBe(200);
    const pv = preview.json() as ImportPreview;
    expect(pv.members.map((m) => m.name)).toEqual(["admin", "player", "player"]);
    expect(pv.counts).toMatchObject({ scenes: 2, tokens: 5, assets: 2, sheets: 2, library: 1, content: 1 });
    expect(pv.includesChat).toBe(true);
    expect((await rest<{ campaigns: unknown[] }>(t.gm.cookie, "GET", "/campaigns")).json().campaigns).toHaveLength(1);
    expect(readdirSync(ctx.config.uploadDir).filter((n) => n.startsWith(".import-"))).toEqual([]);

    const res = await importZip(t.gm.cookie, zip, { name: "Copia importata", memberMap: { m2: t.p1.id, m3: t.p2.id }, includeChat: true });
    expect(res.statusCode, res.body).toBe(201);
    const result = res.json() as ImportResult;
    const newId = result.campaign.id;
    expect(newId).not.toBe(t.campaignId);
    expect(result.campaign.name).toBe("Copia importata");
    expect(result.counts).toMatchObject({ scenes: 2, tokens: 5, chat: 3, assets: 2 });
    expect(readdirSync(ctx.config.uploadDir).filter((n) => n.startsWith(".import-"))).toEqual([]);

    // L'originale non è toccato; la nuova ha stato uguale a meno degli id.
    expect(ctx.app.realtime.stateOf(t.campaignId)!.state).toEqual(original.state);
    const imported = ctx.app.realtime.stateOf(newId)!;
    expect(imported.state.version).toBe(0);
    expect(imported.log.epoch).not.toBe(original.log.epoch);
    expect(canon({ ...imported.state, name: original.state.name })).toBe(canon(original.state));
    // Id tutti nuovi.
    const oldIds = new Set([...original.state.scenes.map((s) => s.id), ...original.state.tokens.map((x) => x.id), "wall-1", "g1"]);
    for (const id of [...imported.state.scenes.map((s) => s.id), ...imported.state.tokens.map((x) => x.id), ...(imported.state.walls ?? []).map((w) => w.id), ...(imported.state.groups ?? []).map((g) => g.id)]) {
      expect(oldIds.has(id)).toBe(false);
    }

    // Immagini: stessi byte, nome UUID nuovo.
    const newScene = imported.state.scenes.find((s) => s.map)!;
    expect(newScene.map!.url).not.toBe(map.url);
    expect(newScene.map!.url).toMatch(/^\/assets\/[0-9a-f-]{36}\.png$/);
    const a = await rest(t.gm.cookie, "GET", map.url);
    const b = await rest(t.gm.cookie, "GET", newScene.map!.url);
    expect(b.status).toBe(200);
    expect(Buffer.compare(b.raw.rawPayload, a.raw.rawPayload)).toBe(0);
    expect(existsSync(`${ctx.config.uploadDir}/${newScene.map!.assetId}.png`)).toBe(true);

    // Schede, contenuti, libreria e chat.
    const sheets = async (id: string) => {
      const list = (await rest<{ sheets: SheetSummary[] }>(t.gm.cookie, "GET", `/campaigns/${id}/sheets`)).json().sheets;
      return Promise.all(list.map(async (s) => (await rest<SheetRecord>(t.gm.cookie, "GET", `/campaigns/${id}/sheets/${s.id}`)).json()));
    };
    const [so, sn] = [await sheets(t.campaignId), await sheets(newId)];
    const strip = (r: SheetRecord) => ({ kind: r.kind, name: r.name, owner: r.ownerUserId, doc: r.doc, linked: r.tokenId != null });
    expect(sn.map(strip)).toEqual(so.map(strip));
    expect(sn.find((s) => s.kind === "pc")!.tokenId).toBe(imported.state.tokens.find((x) => x.name === "Eroe1")!.id);

    const content = async (id: string) => (await rest<{ items: { name: string; kind: string }[] }>(t.gm.cookie, "GET", `/content?campaignId=${id}`)).json().items.map((i) => [i.kind, i.name]);
    expect(await content(newId)).toEqual(await content(t.campaignId));
    expect(await content(newId)).toEqual([["item", "Spada di prova"]]);

    const lib = async (id: string) => (await rest<{ items: LibraryItem[] }>(t.gm.cookie, "GET", `/library?campaignId=${id}`)).json().items;
    const [lo, ln] = [await lib(t.campaignId), await lib(newId)];
    expect(ln.map(({ name, kind, size, stats, tags }) => ({ name, kind, size, stats, tags }))).toEqual(lo.map(({ name, kind, size, stats, tags }) => ({ name, kind, size, stats, tags })));
    expect(ln[0]!.imageUrl).not.toBe(lo[0]!.imageUrl);
    expect((await rest(t.gm.cookie, "GET", ln[0]!.imageUrl!)).status).toBe(200);

    const log = async (id: string) => (await rest<{ entries: ChatLogEntry[] }>(t.gm.cookie, "GET", `/campaigns/${id}/log`)).json().entries.map((e) => ({ ...e, id: undefined }));
    expect(await log(newId)).toEqual(await log(t.campaignId));
    expect((await log(newId)).some((e) => e.kind === "roll" && e.visibility === "gm")).toBe(true);

    // La nuova campagna è subito usabile: uno snapshot con epoca nuova; il giocatore mappato la vede.
    const gm2 = await WsClient.connect(port, { cookie: t.gm.cookie });
    const p2 = await WsClient.connect(port, { cookie: t.p2.cookie });
    clients.push(gm2, p2);
    const snap = (await hello(gm2, newId)) as { type: string; epoch: string; version: number };
    expect(snap).toMatchObject({ type: "snapshot", version: 0 });
    expect(snap.epoch).toBe(imported.log.epoch);
    expect((await hello(p2, newId)).type).toBe("snapshot");
    expect((await rest<{ campaigns: { id: string }[] }>(t.p2.cookie, "GET", "/campaigns/mine")).json().campaigns.map((c) => c.id)).toContain(newId);
    // Sul tavolo originale i client collegati non hanno ricevuto nulla di nuovo.
    expect(ctx.app.realtime.stateOf(t.campaignId)!.state.version).toBe(original.state.version);
  }, 30_000);

  it("giocatore non associato: perde proprietà e nebbia personale, il resto resta; il GM dell'archivio è chi importa", async () => {
    const { t } = await richCampaign();
    const zip = (await exportZip(t.gm.cookie, t.campaignId)).rawPayload;
    const res = await importZip(t.gm.cookie, zip, { memberMap: { m2: t.p1.id, m3: null } });
    expect(res.statusCode, res.body).toBe(201);
    const st = ctx.app.realtime.stateOf((res.json() as ImportResult).campaign.id)!.state;
    expect(st.members.map((m) => m.userId)).toEqual([t.gm.id, t.p1.id]);
    expect(st.tokens.find((x) => x.name === "Eroe1")!.ownerUserId).toBe(t.p1.id);
    expect(st.tokens.find((x) => x.name === "Eroe2")!.ownerUserId).toBeNull();
    expect((res.json() as ImportResult).warnings.join(" ")).toContain("non è associato");
  });

  it("mappatura non valida: membro sconosciuto, GM, utente inesistente, admin, doppione (nessuna campagna creata)", async () => {
    const { t } = await richCampaign();
    const zip = (await exportZip(t.gm.cookie, t.campaignId)).rawPayload;
    const other = await loginAs(ctx.app, "admin");
    const cases: unknown[] = [
      { memberMap: { m9: t.p1.id } },
      { memberMap: { m1: t.p1.id } },
      { memberMap: { m2: "utente-che-non-esiste" } },
      { memberMap: { m2: other.user.id } },
      { memberMap: { m2: t.p1.id, m3: t.p1.id } },
      { memberMap: { m2: "../x" } },
      { name: "" },
      { extra: 1 },
      "{non json",
    ];
    for (const options of cases) {
      const res = await importZip(t.gm.cookie, zip, options);
      expect(res.statusCode, JSON.stringify(options)).toBe(400);
    }
    expect((await rest<{ campaigns: unknown[] }>(t.gm.cookie, "GET", "/campaigns")).json().campaigns).toHaveLength(1);
  });
});

describe("importazione: archivi malevoli", () => {
  /** Un'app per ogni configurazione, riusata dentro il test (creare utenti con scrypt è lento). */
  const sandboxes = new Map<string, ReturnType<typeof makeSandbox> extends Promise<infer S> ? S : never>();
  async function makeSandbox(env: NodeJS.ProcessEnv) {
    const c = await createTestApp(env);
    const t = await createTable(c);
    return {
      c,
      t,
      campaigns: async () => (await rest<{ campaigns: unknown[] }>(t.gm.cookie, "GET", "/campaigns")).json().campaigns.length,
      assets: async () => Number(((await c.app.database.client.execute("select count(*) as n from asset")).rows[0] as unknown as { n: number }).n),
      files: () => readdirSync(c.config.uploadDir),
    };
  }
  async function setupEmpty(env: NodeJS.ProcessEnv = {}) {
    const key = JSON.stringify(env);
    if (!sandboxes.has(key)) {
      const s = await makeSandbox(env);
      sandboxes.set(key, s);
      closers.push(async () => {
        sandboxes.delete(key);
        await s.c.close();
      });
    }
    const s = sandboxes.get(key)!;
    ctx = s.c;
    return s;
  }

  /** L'importazione fallisce con `status`, non lascia nulla: né campagne, né file, né righe, né cartelle di parcheggio. */
  async function rejects(env: NodeJS.ProcessEnv, zip: Uint8Array, status: number, expectError?: RegExp) {
    const { t, campaigns, assets, files } = await setupEmpty(env);
    const before = { c: await campaigns(), a: await assets(), f: files().sort() };
    const res = await importZip(t.gm.cookie, zip);
    expect(res.statusCode, res.body).toBe(status);
    if (expectError) expect(res.body).toMatch(expectError);
    expect(await campaigns()).toBe(before.c);
    expect(await assets()).toBe(before.a);
    expect(files().sort()).toEqual(before.f);
    // L'anteprima rifiuta allo stesso modo.
    expect((await importZip(t.gm.cookie, zip, undefined, true)).statusCode).toBe(status);
  }

  const png = makePng(8, 8);
  const goodAsset = () => {
    const id = randomUUID();
    return { id, meta: { id, kind: "map", mime: "image/png", ext: "png", width: 8, height: 8, bytes: png.length } };
  };

  it("archivio minimo valido: crea una campagna vuota", async () => {
    const { t, campaigns } = await setupEmpty();
    const res = await importZip(t.gm.cookie, buildZip(emptyDocs()));
    expect(res.statusCode, res.body).toBe(201);
    expect(await campaigns()).toBe(2);
  });

  it("zip slip e percorsi non ammessi", async () => {
    for (const name of ["../evil.txt", "..\\evil.txt", "/etc/passwd", "assets/../../evil.png", "assets/x.png", "extra.json", "a/b/../../c.json", "C:\\evil.json", "scenes.json\0.png"]) {
      const files: Record<string, Entry> = { ...emptyDocs(), [name]: "x" };
      await rejects({}, buildZip(files), 400, /non ammessa|non valido/);
    }
    // Il file non è mai stato scritto fuori dalle cartelle gestite.
    expect(existsSync("/etc/evil.txt")).toBe(false);
  });

  it("non è uno zip, file vuoto, troncato", async () => {
    await rejects({}, Buffer.from("questo non è uno zip, è solo testo"), 400);
    await rejects({}, Buffer.alloc(0), 400);
    const good = buildZip(emptyDocs());
    await rejects({}, good.subarray(0, Math.floor(good.length / 2)), 400);
  });

  it("manifesto: mancante, non valido, versione più nuova, hash o dimensione che non tornano, file non elencato o mancante", async () => {
    await rejects({}, buildZip(emptyDocs(), { noManifest: true }), 400, /manifest/);
    await rejects({}, buildZip(emptyDocs(), { manifest: { format: "altro" } }), 400);
    await rejects({}, buildZip(emptyDocs(), { manifest: { formatVersion: 99 } }), 422, /più recente/);
    await rejects({}, buildZip(emptyDocs(), { manifest: { protocolVersion: 99 } }), 422);
    await rejects({}, buildZip(emptyDocs(), { manifest: { campaignName: "x", extra: 1 } }), 400);
    await rejects({}, buildZip(emptyDocs(), { unlisted: ["scenes.json"] }), 400, /manifesto/);
    const docs = emptyDocs();
    const zip = buildZip({ ...docs, "scenes.json": "[ ]" }, { manifest: { files: [] } });
    await rejects({}, zip, 400);
    // File elencato ma assente.
    const base = emptyDocs();
    delete base["walls.json"];
    await rejects({}, buildZip(base), 400, /manca/);
    // Hash alterato.
    const tampered = buildZip(emptyDocs(), { manifest: { files: Object.keys(emptyDocs()).map((p) => ({ path: p, bytes: 0, sha256: "0".repeat(64) })) } });
    await rejects({}, tampered, 400, /non corrisponde/);
  });

  it("JSON non valido o fuori schema", async () => {
    await rejects({}, buildZip({ ...emptyDocs(), "tokens.json": "{non json" }), 400, /JSON/);
    await rejects({}, buildZip({ ...emptyDocs(), "scenes.json": [{ id: "s", name: "x", width: "grande" }] }), 400, /scenes\.json/);
    await rejects({}, buildZip({ ...emptyDocs(), "scenes.json": [{ ...scene("s1"), extra: true }] }), 400);
    await rejects({}, buildZip({ ...emptyDocs(), "scenes.json": { non: "un array" } }), 400);
    await rejects({}, buildZip({ ...emptyDocs(), "members.json": [{ ref: "../x", name: "A", role: "player" }] }), 400);
    await rejects({}, buildZip({ ...emptyDocs(), "campaign.json": { name: "", activeSceneId: null } }), 400);
    await rejects({}, buildZip({ ...emptyDocs(), "sheets.json": [{ kind: "pc", ownerRef: null, tokenId: null, doc: { sheet: {} } }] }), 400, /sheets\.json/);
    // Contenuti: niente HTML né chiavi pericolose.
    const item = { kind: "item", name: "X", source: "", data: { testo: "<script>alert(1)</script>" } };
    await rejects({}, buildZip({ ...emptyDocs(), "content.json": [item] }), 400, /content\.json/);
    await rejects({}, buildZip({ ...emptyDocs(), "content.json": [{ ...item, data: JSON.parse('{"__proto__": {"x": 1}}') }] }), 400);
    await rejects({}, buildZip({ ...emptyDocs(), "content.json": [{ ...item, data: { testo: "ok" } }, { ...item, kind: "arma" }] }), 400);
  });

  it("riferimenti pendenti: token senza scena, nebbia senza scena, membro sconosciuto", async () => {
    await rejects({}, buildZip({ ...emptyDocs(), "tokens.json": [token("t1", { sceneId: "nessuna" })] }), 400, /incoerente/);
    const s = scene("s1");
    await rejects({}, buildZip({ ...emptyDocs(), "scenes.json": [s], "tokens.json": [token("t1", { sceneId: "s1", ownerUserId: "m7" })] }), 400, /incoerente/);
    await rejects({}, buildZip({ ...emptyDocs(), "scenes.json": [s], "tokens.json": [token("t1", { sceneId: "s1", x: 99999 })] }), 400);
  });

  it("file enormi: bomba di decompressione, dimensione dichiarata falsa, totale e numero di voci oltre i limiti", async () => {
    // 40 MiB di zeri = pochi KiB compressi, ma oltre il limite del documento (1 MiB): fermato mentre si decomprime.
    const bomb = buildZip({ ...emptyDocs(), "scenes.json": new Uint8Array(40 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(200 * 1024);
    await rejects({ ARCHIVE_MAX_JSON_BYTES: String(1024 * 1024) }, bomb, 413, /troppo grande|limite/);
    // Dimensione dichiarata falsa (1 byte) nell'intestazione locale: conta ciò che si decomprime davvero.
    const lying = Buffer.from(bomb);
    const sig = lying.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(sig).toBeGreaterThanOrEqual(0);
    lying.writeUInt32LE(1, sig + 22); // uncompressed size nell'intestazione del primo file
    await rejects({ ARCHIVE_MAX_JSON_BYTES: String(1024 * 1024) }, lying, 413);
    // Totale decompresso.
    const many = buildZip({ ...emptyDocs(), "scenes.json": new TextEncoder().encode("[" + " ".repeat(600_000) + "]"), "tokens.json": new TextEncoder().encode("[" + " ".repeat(600_000) + "]") });
    await rejects({ ARCHIVE_MAX_UNPACKED_BYTES: String(1024 * 1024) }, many, 413, /decompresso/);
    // Troppe voci.
    const entries: Record<string, Entry> = { ...emptyDocs() };
    await rejects({ ARCHIVE_MAX_ENTRIES: "5" }, buildZip(entries), 413, /Troppe voci/);
    // Archivio caricato troppo grande.
    const noisy = buildZip({ ...emptyDocs(), "scenes.json": Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)) }, { level: 0 });
    await rejects({ ARCHIVE_MAX_BYTES: "1000" }, noisy, 413, /supera/);
  });

  it("immagini: SVG camuffato da PNG, formato che non corrisponde, dimensioni false, troppo grandi in pixel", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
    const withAsset = (data: Buffer, ext: string, metaOver: Record<string, unknown> = {}) => {
      const a = goodAsset();
      return buildZip({ ...emptyDocs(), "assets.json": [{ ...a.meta, ext, ...metaOver }], [`assets/${a.id}.${ext}`]: data });
    };
    await rejects({}, withAsset(svg, "png"), 415, /PNG, JPEG o WebP/);
    // Un SVG con "magic bytes" PNG finti in testa non è un PNG valido (manca IHDR): rifiutato.
    await rejects({}, withAsset(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), svg]), "png"), 415);
    await rejects({}, withAsset(png, "jpg"), 415, /estensione/);
    await rejects({}, withAsset(png, "png", { width: 9999 }), 415, /dichiarato/);
    await rejects({}, withAsset(png, "png", { bytes: 1 }), 415);
    await rejects({ UPLOAD_MAX_SIDE: "4" }, withAsset(png, "png"), 413, /pixel/);
    await rejects({ UPLOAD_MAX_BYTES: String(png.length - 1) }, withAsset(png, "png"), 413);
    // Immagine presente ma non elencata in assets.json, e viceversa.
    const a = goodAsset();
    await rejects({}, buildZip({ ...emptyDocs(), [`assets/${a.id}.png`]: png }), 400, /assets\.json/);
    await rejects({}, buildZip({ ...emptyDocs(), "assets.json": [a.meta] }), 400);
    // Nome che non è un UUID.
    await rejects({}, buildZip({ ...emptyDocs(), "assets/mappa.png": png }), 400);
  });

  it("un archivio con immagine valida si importa, il suo URL è rimappato e il file ha nome nuovo", async () => {
    const { t, files } = await setupEmpty();
    const a = goodAsset();
    const s = scene("s1", { map: { assetId: a.id, url: `/assets/${a.id}.png` } });
    const zip = buildZip({
      ...emptyDocs(),
      "scenes.json": [s],
      "tokens.json": [token("t1", { sceneId: "s1", imageUrl: `/assets/${a.id}.png` })],
      "assets.json": [a.meta],
      [`assets/${a.id}.png`]: png,
    });
    const res = await importZip(t.gm.cookie, zip);
    expect(res.statusCode, res.body).toBe(201);
    const st = ctx.app.realtime.stateOf((res.json() as ImportResult).campaign.id)!.state;
    expect(st.scenes[0]!.map!.assetId).not.toBe(a.id);
    expect(st.tokens[0]!.imageUrl).toBe(st.scenes[0]!.map!.url);
    expect(files().filter((n) => n.endsWith(".png"))).toEqual([`${st.scenes[0]!.map!.assetId}.png`]);
  });

  it("transazionale: se il salvataggio fallisce a metà non resta nulla (né righe né file)", async () => {
    const { t, campaigns, assets, files } = await setupEmpty();
    const a = goodAsset();
    const zip = buildZip({
      ...emptyDocs(),
      "scenes.json": [scene("s1", { map: { assetId: a.id, url: `/assets/${a.id}.png` } })],
      "assets.json": [a.meta],
      [`assets/${a.id}.png`]: png,
      "library.json": [{ name: "Modello", kind: "object", size: 1, imageUrl: null, stats: { hpMax: null, armorClass: null, speed: null }, tags: [] }],
    });
    // Una tabella che manca fa fallire l'inserimento della libreria DOPO campagna, scene e immagini.
    await ctx.app.database.client.execute("drop table library_item");
    const before = { c: await campaigns(), a: await assets(), f: files().sort() };
    const res = await importZip(t.gm.cookie, zip);
    expect(res.statusCode).toBe(500);
    expect(await campaigns()).toBe(before.c);
    expect(await assets()).toBe(before.a);
    expect(files().sort()).toEqual(before.f);
    expect(ctx.app.realtime.stateOf((await rest<{ campaigns: { id: string }[] }>(t.gm.cookie, "GET", "/campaigns")).json().campaigns.at(-1)!.id)).toBeDefined();
  });

  it("richiesta non multipart o con campi in più: errore chiaro", async () => {
    const { t } = await setupEmpty();
    const bad = await ctx.app.inject({ method: "POST", url: "/campaigns/import", headers: { cookie: t.gm.cookie, origin: ORIGIN, "content-type": "application/json" }, payload: "{}" });
    expect(bad.statusCode).toBe(415);
    const boundary = "xx";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="altro"\r\n\r\nv\r\n--${boundary}--\r\n`;
    const res = await ctx.app.inject({ method: "POST", url: "/campaigns/import", headers: { cookie: t.gm.cookie, origin: ORIGIN, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(res.statusCode).toBe(400);
    const noFile = `--${boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n{}\r\n--${boundary}--\r\n`;
    expect((await ctx.app.inject({ method: "POST", url: "/campaigns/import", headers: { cookie: t.gm.cookie, origin: ORIGIN, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: noFile })).statusCode).toBe(400);
  });

  it("senza Origin ammesso la richiesta è rifiutata (come ogni POST)", async () => {
    const { t } = await setupEmpty();
    const f = importForm(buildZip(emptyDocs()));
    const res = await ctx.app.inject({ method: "POST", url: "/campaigns/import", headers: { ...f.headers, cookie: t.gm.cookie, origin: "https://altro.example" }, payload: f.payload });
    expect(res.statusCode).toBe(403);
  });
});
