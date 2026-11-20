import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blankDoc, monsterDocFromContent, type SheetRecord, type SheetSummary } from "@lanterna/shared";
import { MAIN, command, createTable, hello, scene, token, type Table } from "../test/campaign.js";
import { ORIGIN, createTestApp, loginAs, type TestContext } from "../test/helpers.js";
import { WsClient, listen } from "../test/ws.js";
import { MAX_SHEETS_PER_PLAYER } from "./routes.js";

let ctx: TestContext;
let t: Table;
beforeEach(async () => {
  ctx = await createTestApp();
  t = await createTable(ctx);
});
afterEach(async () => {
  await ctx.close();
});

const SECRET_MONSTER = "StatblockSegretoXYZ";
const SECRET_TEXT = "TESTO-STATBLOCK-SEGRETO-XYZ";

type Who = "gm" | "p1" | "p2" | "anon" | "outsider";

async function call(who: Who, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, extraCookie?: string) {
  const cookie = who === "anon" ? "" : (extraCookie ?? (who === "outsider" ? "" : t[who].cookie));
  return ctx.app.inject({
    method,
    url: `/campaigns/${t.campaignId}/sheets${url}`,
    headers: { origin: ORIGIN, cookie },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

async function createAs(who: "gm" | "p1" | "p2", kind: "pc" | "monster", name: string, extra: Record<string, unknown> = {}, doc = blankDoc(name, kind)) {
  const res = await call(who, "POST", "", { kind, doc, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<SheetRecord>();
}

/** GM crea: eroe di p1, eroe di p2, mostro con testo segreto. */
async function seed() {
  const hero1 = await createAs("gm", "pc", "Eroe Uno", { ownerUserId: t.p1.id });
  const hero2 = await createAs("gm", "pc", "Eroe Due", { ownerUserId: t.p2.id });
  const doc = monsterDocFromContent(SECRET_MONSTER, { hp: 30, ac: 12, text: SECRET_TEXT });
  const monster = await createAs("gm", "monster", SECRET_MONSTER, {}, doc);
  return { hero1, hero2, monster };
}

describe("matrice ruolo x azione", () => {
  it("anonimo: 401 su ogni rotta", async () => {
    const { hero1 } = await seed();
    for (const [method, url, body] of [
      ["GET", "", undefined],
      ["POST", "", { kind: "pc", doc: blankDoc("x") }],
      ["GET", `/${hero1.id}`, undefined],
      ["PUT", `/${hero1.id}`, { version: 1 }],
      ["DELETE", `/${hero1.id}`, undefined],
    ] as const) {
      const res = await call("anon", method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("GM: legge e scrive tutto, anche i mostri; elimina", async () => {
    const { hero1, monster } = await seed();
    const list = (await call("gm", "GET", "")).json<{ sheets: SheetSummary[] }>().sheets;
    expect(list.map((s) => s.name).sort()).toEqual(["Eroe Due", "Eroe Uno", SECRET_MONSTER].sort());
    expect((await call("gm", "GET", `/${monster.id}`)).statusCode).toBe(200);
    const doc = { ...hero1.doc, sheet: { ...hero1.doc.sheet, name: "Eroe Rinominato" } };
    const put = await call("gm", "PUT", `/${hero1.id}`, { version: hero1.version, doc });
    expect(put.statusCode).toBe(200);
    expect(put.json<SheetRecord>().version).toBe(hero1.version + 1);
    expect(put.json<SheetRecord>().name).toBe("Eroe Rinominato");
    expect((await call("gm", "DELETE", `/${monster.id}`)).statusCode).toBe(204);
    expect((await call("gm", "GET", `/${monster.id}`)).statusCode).toBe(404);
  });

  it("giocatore: vede solo la propria scheda; le altre e i mostri rispondono 404", async () => {
    const { hero1, hero2, monster } = await seed();
    const list = (await call("p1", "GET", "")).json<{ sheets: SheetSummary[] }>().sheets;
    expect(list.map((s) => s.id)).toEqual([hero1.id]);
    expect((await call("p1", "GET", `/${hero1.id}`)).statusCode).toBe(200);
    for (const id of [hero2.id, monster.id, "id-inesistente"]) {
      const res = await call("p1", "GET", `/${id}`);
      expect(res.statusCode, id).toBe(404);
      // Stessa risposta per scheda altrui, statblock e scheda inesistente: nessuna fuga di esistenza.
      expect(res.json()).toEqual({ error: "Scheda inesistente" });
    }
  });

  it("giocatore: modifica la propria, ma non quelle altrui né lo statblock (404), e non elimina (403)", async () => {
    const { hero1, hero2, monster } = await seed();
    const doc = { ...hero1.doc, extras: { ...hero1.doc.extras, notes: "le mie note" } };
    const ok = await call("p1", "PUT", `/${hero1.id}`, { version: hero1.version, doc });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<SheetRecord>().doc.extras.notes).toBe("le mie note");
    for (const id of [hero2.id, monster.id]) {
      expect((await call("p1", "PUT", `/${id}`, { version: 1, doc: blankDoc("hack") })).statusCode).toBe(404);
      expect((await call("p1", "DELETE", `/${id}`)).statusCode).toBe(404);
    }
    expect((await call("p1", "DELETE", `/${hero1.id}`)).statusCode).toBe(403);
    expect((await call("gm", "GET", `/${hero2.id}`)).json<SheetRecord>().name).toBe("Eroe Due");
  });

  it("giocatore: non cambia proprietario né token, non crea mostri né schede per altri", async () => {
    const { hero1 } = await seed();
    expect((await call("p1", "PUT", `/${hero1.id}`, { version: hero1.version, ownerUserId: t.p2.id })).statusCode).toBe(403);
    expect((await call("p1", "PUT", `/${hero1.id}`, { version: hero1.version, ownerUserId: null })).statusCode).toBe(403);
    expect((await call("p1", "PUT", `/${hero1.id}`, { version: hero1.version, tokenId: "tok-p1" })).statusCode).toBe(403);
    expect((await call("p1", "POST", "", { kind: "monster", doc: blankDoc("m", "monster") })).statusCode).toBe(403);
    expect((await call("p1", "POST", "", { kind: "pc", doc: blankDoc("x"), ownerUserId: t.p2.id })).statusCode).toBe(403);
    expect((await call("p1", "POST", "", { kind: "pc", doc: blankDoc("x"), tokenId: "tok-p1" })).statusCode).toBe(403);
    expect((await call("gm", "GET", `/${hero1.id}`)).json<SheetRecord>().ownerUserId).toBe(t.p1.id);
  });

  it("giocatore: crea una scheda propria (proprietario forzato) entro il limite", async () => {
    const mine = await createAs("p2", "pc", "Mia");
    expect(mine.ownerUserId).toBe(t.p2.id);
    expect((await call("p1", "GET", `/${mine.id}`)).statusCode).toBe(404);
    expect((await call("p2", "POST", "", { kind: "pc", doc: blankDoc("Mia 2"), ownerUserId: t.p2.id })).statusCode).toBe(201);
    for (let i = 0; i < MAX_SHEETS_PER_PLAYER - 2; i++) await createAs("p2", "pc", `n${i}`);
    expect((await call("p2", "POST", "", { kind: "pc", doc: blankDoc("troppe") })).statusCode).toBe(409);
  });

  it("non membro e giocatore di un'altra campagna: 404 sulla campagna", async () => {
    await seed();
    const stranger = await loginAs(ctx.app, "player");
    for (const [method, url] of [["GET", ""], ["POST", ""]] as const) {
      const res = await call("outsider", method, url, method === "POST" ? { kind: "pc", doc: blankDoc("x") } : undefined, stranger.cookie);
      expect(res.statusCode, method).toBe(404);
    }
  });

  it("GM: proprietario solo giocatori membri; mostri senza proprietario", async () => {
    const stranger = await loginAs(ctx.app, "player");
    const bad = await call("gm", "POST", "", { kind: "pc", doc: blankDoc("x"), ownerUserId: stranger.user.id });
    expect(bad.statusCode).toBe(400);
    const bad2 = await call("gm", "POST", "", { kind: "monster", doc: blankDoc("m", "monster"), ownerUserId: t.p1.id });
    expect(bad2.statusCode).toBe(400);
    const bad3 = await call("gm", "POST", "", { kind: "pc", doc: blankDoc("x"), ownerUserId: t.gm.id });
    expect(bad3.statusCode).toBe(400);
  });
});

describe("validazione e concorrenza", () => {
  it("rifiuta dati non validi a ogni scrittura (400) senza toccare lo stato", async () => {
    const { hero1 } = await seed();
    const bad = [
      { ...hero1.doc, sheet: { ...hero1.doc.sheet, abilities: { ...hero1.doc.sheet.abilities, str: 99 } } },
      { ...hero1.doc, extra: 1 },
      { ...hero1.doc, sheet: { ...hero1.doc.sheet, classes: [{ id: "x", level: 25, hitDie: 8 }] } },
    ];
    for (const doc of bad) {
      expect((await call("p1", "PUT", `/${hero1.id}`, { version: hero1.version, doc })).statusCode).toBe(400);
      expect((await call("gm", "POST", "", { kind: "pc", doc })).statusCode).toBe(400);
    }
    expect((await call("gm", "PUT", `/${hero1.id}`, { version: hero1.version, doc: hero1.doc, extra: 1 })).statusCode).toBe(400);
    expect((await call("gm", "GET", `/${hero1.id}`)).json<SheetRecord>().version).toBe(hero1.version);
  });

  it("scrittura obsoleta: CONFLICT e nessuna modifica", async () => {
    const { hero1 } = await seed();
    const a = { ...hero1.doc, extras: { ...hero1.doc.extras, notes: "A" } };
    const b = { ...hero1.doc, extras: { ...hero1.doc.extras, notes: "B" } };
    expect((await call("p1", "PUT", `/${hero1.id}`, { version: hero1.version, doc: a })).statusCode).toBe(200);
    const stale = await call("gm", "PUT", `/${hero1.id}`, { version: hero1.version, doc: b });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "CONFLICT", currentVersion: hero1.version + 1 });
    expect((await call("gm", "GET", `/${hero1.id}`)).json<SheetRecord>().doc.extras.notes).toBe("A");
  });

  it("due scritture concorrenti con la stessa versione: una sola vince", async () => {
    const { hero1 } = await seed();
    const mk = (n: string) => call("gm", "PUT", `/${hero1.id}`, { version: hero1.version, doc: { ...hero1.doc, extras: { ...hero1.doc.extras, notes: n } } });
    const codes = (await Promise.all([mk("1"), mk("2")])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
  });

  it("dati corrotti nel database: la lettura fallisce, non passa", async () => {
    const { hero1 } = await seed();
    await ctx.app.database.client.execute({ sql: "update character_sheet set data = ? where id = ?", args: ['{"sheet":{}}', hero1.id] });
    expect((await call("gm", "GET", `/${hero1.id}`)).statusCode).toBe(500);
  });
});

describe("nessuna fuga dello statblock ai giocatori", () => {
  it("nelle risposte REST del giocatore non compaiono nome, testo né id del mostro", async () => {
    const { hero1, monster } = await seed();
    const seen: string[] = [];
    for (const url of ["", `/${hero1.id}`, `/${monster.id}`]) seen.push((await call("p1", "GET", url)).body);
    seen.push((await call("p1", "PUT", `/${monster.id}`, { version: 1, doc: blankDoc("x") })).body);
    const all = seen.join("\n");
    for (const s of [SECRET_MONSTER, SECRET_TEXT, monster.id]) expect(all).not.toContain(s);
  });

  it("anche i contenuti 'monster' restano riservati al GM (REST /content)", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/content/import",
      headers: { origin: ORIGIN, cookie: t.gm.cookie },
      payload: { items: [{ kind: "monster", name: SECRET_MONSTER, data: { hp: 5, text: SECRET_TEXT } }] },
    });
    expect(res.statusCode).toBe(200);
    const list = await ctx.app.inject({ method: "GET", url: "/content?kind=monster", headers: { cookie: t.p1.cookie } });
    expect(list.body).not.toContain(SECRET_MONSTER);
    const gmList = await ctx.app.inject({ method: "GET", url: "/content?kind=monster", headers: { cookie: t.gm.cookie } });
    expect(gmList.body).toContain(SECRET_MONSTER);
  });
});

describe("collegamento scheda-token", () => {
  let gmWs: WsClient;
  beforeEach(async () => {
    const port = await listen(ctx);
    gmWs = await WsClient.connect(port, { cookie: t.gm.cookie });
    await hello(gmWs, t.campaignId);
    for (const c of [
      { type: "scene.create", scene: scene(MAIN) },
      { type: "scene.activate", sceneId: MAIN },
      { type: "token.create", token: token("tok-hidden", { hidden: true, name: "TokenNascostoXYZ" }) },
      { type: "token.create", token: token("tok-b") },
    ] as const) {
      expect((await command(gmWs, c)).type).toBe("ack");
    }
  });
  afterEach(() => gmWs.ws.terminate());

  it("il GM collega, il legame resta al GM e un token ha una sola scheda", async () => {
    const { hero1, hero2 } = await seed();
    const link = await call("gm", "PUT", `/${hero1.id}`, { version: hero1.version, tokenId: "tok-hidden" });
    expect(link.statusCode).toBe(200);
    expect(link.json<SheetRecord>().tokenId).toBe("tok-hidden");
    // Il giocatore proprietario non riceve mai il tokenId (il token è nascosto).
    const own = await call("p1", "GET", `/${hero1.id}`);
    expect(own.statusCode).toBe(200);
    expect(own.body).not.toContain("tok-hidden");
    expect(own.json()).not.toHaveProperty("tokenId");
    expect((await call("p1", "GET", "")).body).not.toContain("tok-hidden");
    // Token già usato / inesistente
    expect((await call("gm", "PUT", `/${hero2.id}`, { version: hero2.version, tokenId: "tok-hidden" })).statusCode).toBe(400);
    expect((await call("gm", "PUT", `/${hero2.id}`, { version: hero2.version, tokenId: "tok-nope" })).statusCode).toBe(400);
    // Scollegare
    const un = await call("gm", "PUT", `/${hero1.id}`, { version: link.json<SheetRecord>().version, tokenId: null });
    expect(un.json<SheetRecord>().tokenId).toBeNull();
  });
});

describe("persistenza", () => {
  it("l'elenco riporta PF e condizioni derivati dalla scheda", async () => {
    const doc = blankDoc("Ferito");
    const hurt = { ...doc, sheet: { ...doc.sheet, hp: { ...doc.sheet.hp, current: 3 }, conditions: ["poisoned" as const] } };
    await createAs("gm", "pc", "Ferito", { ownerUserId: t.p1.id }, hurt);
    const s = (await call("p1", "GET", "")).json<{ sheets: SheetSummary[] }>().sheets[0]!;
    expect(s.hp).toEqual({ current: 3, max: 8, temp: 0 });
    expect(s.conditions).toEqual(["poisoned"]);
  });
});
