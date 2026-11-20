import { afterEach, describe, expect, it } from "vitest";
import type { LibraryItem, LibraryItemPublic, ListLibraryResponse, UploadResponse } from "@lanterna/shared";
import { createCampaignAs, createTable, type Table } from "../test/campaign.js";
import { ORIGIN, createTestApp, type TestContext } from "../test/helpers.js";
import { makePng, multipart } from "../test/images.js";

/**
 * Libreria di token e oggetti (M10): CRUD solo admin (403 al giocatore), lettura del giocatore limitata ai
 * tipi consentiti (default nessuno) e senza statistiche, ricerca e filtri. Dati FITTIZI.
 */

let ctx: TestContext;
let t: Table;
afterEach(async () => {
  await ctx?.close();
});

const STAT = { hpMax: 4321, armorClass: 77, speed: 55 };

async function start(env: NodeJS.ProcessEnv = {}) {
  ctx = await createTestApp(env);
  t = await createTable(ctx);
}

type Who = "gm" | "p1" | "p2" | "anon";
async function call<T = unknown>(who: Who, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { origin: ORIGIN, ...(who === "anon" ? {} : { cookie: t[who].cookie }) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.body, json: () => res.json() as T };
}

const body = (over: Record<string, unknown> = {}) => ({
  name: "Goblin",
  kind: "monster",
  scope: "campaign",
  campaignId: t.campaignId,
  size: 1,
  imageUrl: null,
  stats: STAT,
  tags: ["goblin"],
  ...over,
});

const create = async (over: Record<string, unknown> = {}) => {
  const r = await call<LibraryItem>("gm", "POST", "/library", body(over));
  expect(r.status, r.body).toBe(201);
  return r.json();
};

describe("libreria: ruoli verificati lato server", () => {
  it("anonimo 401, giocatore 403 su ogni scrittura (anche membro), admin ok", async () => {
    await start();
    const item = await create();
    const writes: [string, string, unknown?][] = [
      ["POST", "/library", body()],
      ["PATCH", `/library/${item.id}`, { name: "Hack" }],
      ["DELETE", `/library/${item.id}`],
    ];
    for (const [method, url, payload] of writes) {
      expect((await call("anon", method as "POST", url, payload)).status, `${method} ${url} anonimo`).toBe(401);
      expect((await call("p1", method as "POST", url, payload)).status, `${method} ${url} giocatore`).toBe(403);
    }
    for (const who of ["anon"] as const) {
      expect((await call(who, "GET", `/library?campaignId=${t.campaignId}`)).status).toBe(401);
      expect((await call(who, "GET", `/library/${item.id}`)).status).toBe(401);
    }
    // L'elemento non è stato toccato dai tentativi.
    expect((await call<LibraryItem>("gm", "GET", `/library/${item.id}`)).json().name).toBe("Goblin");
    expect((await call("gm", "PATCH", `/library/${item.id}`, { name: "Goblin capo" })).status).toBe(200);
    expect((await call("gm", "DELETE", `/library/${item.id}`)).status).toBe(204);
    expect((await call("gm", "GET", `/library/${item.id}`)).status).toBe(404);
  });
});

describe("libreria: CRUD e validazione", () => {
  it("crea, legge, modifica e cerca per nome, tag e tipo", async () => {
    await start();
    const goblin = await create({ name: "Goblin", tags: ["umanoide", "piccolo"] });
    const tavolo = await create({ name: "Tavolo di legno", kind: "object", tags: ["arredo"], stats: { hpMax: null, armorClass: null, speed: null } });
    await create({ name: "Eroe", kind: "pc", scope: "global", campaignId: undefined, tags: [] });
    const list = async (q: string) => (await call<ListLibraryResponse<LibraryItem>>("gm", "GET", `/library?campaignId=${t.campaignId}${q}`)).json();
    expect((await list("")).total).toBe(3);
    expect((await list("&q=gob")).items.map((i) => i.name)).toEqual(["Goblin"]);
    expect((await list("&q=ARREDO")).items.map((i) => i.id)).toEqual([tavolo.id]);
    expect((await list("&kind=object")).items.map((i) => i.name)).toEqual(["Tavolo di legno"]);
    expect((await list("&limit=1&offset=1")).items).toHaveLength(1);
    expect((await list("&q=%25")).total).toBe(0); // il carattere jolly non è un jolly
    // Senza campagna: solo la libreria globale.
    expect((await call<ListLibraryResponse<LibraryItem>>("gm", "GET", "/library")).json().items.map((i) => i.name)).toEqual(["Eroe"]);
    const r = await call<LibraryItem>("gm", "PATCH", `/library/${goblin.id}`, { name: "Goblin capo", stats: { hpMax: 9, armorClass: 14, speed: 30 }, tags: ["capo"] });
    expect(r.json()).toMatchObject({ name: "Goblin capo", stats: { hpMax: 9 }, tags: ["capo"], size: 1, scope: "campaign" });
  });

  it("rifiuta dati non validi, campi in più, ambito incoerente, immagini inesistenti, campagna inesistente", async () => {
    await start();
    const bad: Record<string, unknown>[] = [
      { name: "" },
      { kind: "drago" },
      { size: 0 },
      { size: 99 },
      { stats: { hpMax: -1, armorClass: null, speed: null } },
      { stats: { hpMax: 1, armorClass: null } },
      { tags: Array.from({ length: 9 }, (_, i) => `t${i}`) },
      { tags: ["a", "A"] },
      { imageUrl: "javascript:alert(1)" },
      { imageUrl: "/assets/non-un-uuid.png" },
      { extra: 1 },
      { scope: "global" }, // con campaignId
      { campaignId: undefined }, // campaign senza campaignId
    ];
    for (const over of bad) {
      const r = await call("gm", "POST", "/library", body(over));
      expect(r.status, JSON.stringify(over)).toBe(400);
    }
    expect((await call("gm", "POST", "/library", body({ imageUrl: "/assets/00000000-0000-4000-8000-000000000000.png" }))).status).toBe(400);
    expect((await call("gm", "POST", "/library", body({ campaignId: "inesistente" }))).status).toBe(404);
    const item = await create();
    for (const patch of [{}, { scope: "global" }, { campaignId: "x" }, { kind: "x" }]) {
      expect((await call("gm", "PATCH", `/library/${item.id}`, patch)).status, JSON.stringify(patch)).toBe(400);
    }
    expect((await call("gm", "PATCH", "/library/inesistente", { name: "x" })).status).toBe(404);
    expect((await call("gm", "DELETE", "/library/inesistente")).status).toBe(404);
    expect((await call("gm", "GET", "/library?campaignId=inesistente")).status).toBe(404);
    expect((await call("gm", "GET", "/library?limit=9999")).status).toBe(400);
  });

  it("un'immagine caricata è accettata e la campagna eliminata porta via i suoi elementi", async () => {
    await start();
    const f = multipart(makePng(16, 16));
    const up = await ctx.app.inject({ method: "POST", url: "/uploads/token", headers: { ...f.headers, origin: ORIGIN, cookie: t.gm.cookie }, payload: f.payload });
    const img = up.json() as UploadResponse;
    const item = await create({ imageUrl: img.url });
    expect(item.imageUrl).toBe(img.url);
    await ctx.app.database.client.execute({ sql: "delete from campaign where id = ?", args: [t.campaignId] });
    expect((await call("gm", "GET", `/library/${item.id}`)).status).toBe(404);
  });
});

describe("libreria: giocatori", () => {
  it("di default nessun elemento è leggibile dai giocatori; con LIBRARY_PLAYER_KINDS solo quei tipi, senza statistiche", async () => {
    await start();
    const barile = await create({ name: "Barile", kind: "object", tags: ["arredo"] });
    // Default: nessuno.
    const none = await call<ListLibraryResponse<LibraryItemPublic>>("p1", "GET", `/library?campaignId=${t.campaignId}`);
    expect(none.status).toBe(200);
    expect(none.json()).toEqual({ items: [], total: 0 });
    expect((await call("p1", "GET", `/library/${barile.id}`)).status).toBe(404);
    await ctx.close();

    // Con "object": solo gli oggetti.
    await start({ LIBRARY_PLAYER_KINDS: "object,pc" });
    const g = await create({ name: "GoblinSegretoXYZ", kind: "monster" });
    const b = await create({ name: "Barile", kind: "object", tags: ["arredo"] });
    const e = await create({ name: "Eroe globale", kind: "pc", scope: "global", campaignId: undefined });
    const res = await call<ListLibraryResponse<LibraryItemPublic>>("p1", "GET", `/library?campaignId=${t.campaignId}`);
    expect(res.json().items.map((i) => i.id).sort()).toEqual([b.id, e.id].sort());
    // Mai statistiche né note: il corpo grezzo non contiene i valori distintivi.
    for (const text of [res.body, (await call("p1", "GET", `/library/${b.id}`)).body]) {
      expect(text).not.toContain("hpMax");
      expect(text).not.toContain("4321");
      expect(text).not.toContain("armorClass");
      expect(text).not.toContain("GoblinSegretoXYZ");
      expect(text).not.toContain(t.campaignId);
    }
    expect(Object.keys(res.json().items[0]!).sort()).toEqual(["id", "kind", "name", "scope", "size", "tags", "imageUrl"].sort());
    // Il mostro: 404, come se non esistesse.
    const hidden = await call("p1", "GET", `/library/${g.id}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body).toBe((await call("p1", "GET", "/library/inesistente")).body);
    expect((await call("p1", "GET", `/library?campaignId=${t.campaignId}&kind=monster`)).json()).toEqual({ items: [], total: 0 });
    expect((await call<ListLibraryResponse<LibraryItemPublic>>("p1", "GET", `/library?campaignId=${t.campaignId}&q=arredo`)).json().total).toBe(1);
  });

  it("chi non è membro non legge nulla: campagna altrui e richiesta senza campagna danno 404; gli elementi di un'altra campagna restano invisibili", async () => {
    await start({ LIBRARY_PLAYER_KINDS: "object" });
    const other = await createCampaignAs(ctx, t.gm.cookie, "Altra campagna");
    const mine = await create({ name: "Mio", kind: "object" });
    const theirs = await create({ name: "Altrui", kind: "object", campaignId: other });
    const list = (await call<ListLibraryResponse<LibraryItemPublic>>("p1", "GET", `/library?campaignId=${t.campaignId}`)).json();
    expect(list.items.map((i) => i.id)).toEqual([mine.id]);
    // p1 non è membro dell'altra campagna.
    expect((await call("p1", "GET", `/library?campaignId=${other}`)).status).toBe(404);
    expect((await call("p1", "GET", `/library/${theirs.id}`)).status).toBe(404);
    expect((await call("p1", "GET", "/library")).status).toBe(404);
    expect((await call("p1", "GET", "/library?campaignId=inesistente")).status).toBe(404);
  });
});
