import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addMemberAs, createCampaignAs } from "../test/campaign.js";
import { ORIGIN, createTestApp, loginAs, type TestContext } from "../test/helpers.js";
import { listJsonFiles, readContentFile } from "./files.js";
import { ContentValidationError, parseContent } from "./schema.js";

let ctx: TestContext;
const dirs: string[] = [];
afterEach(async () => {
  await ctx?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Contenuti FITTIZI inventati per i test: nessun testo di manuali. */
const sample = (extra: Record<string, unknown> = {}) => ({
  format: "lanterna-content",
  version: 1,
  source: "Raccolta di prova",
  items: [
    { kind: "item", name: "Lanterna cieca", data: { weight: 2, text: "Una lanterna con una sola apertura." } },
    { kind: "spell", name: "Scintilla di prova", data: { level: 0, text: "Una scintilla inventata." } },
    { kind: "monster", name: "Gufo di nebbia", data: { hp: 7, secret: "SEGRETO-DEL-GM" } },
    { kind: "note", name: "Appunto", data: { text: "Solo per il GM" } },
  ],
  ...extra,
});

describe("validazione (Zod)", () => {
  it("accetta un file valido e un array nudo; la source di ripiego viene dal nome del file", () => {
    const p = parseContent(sample());
    expect(p.items).toHaveLength(4);
    expect(p.items[0]!.source).toBe("Raccolta di prova");
    const bare = parseContent([{ kind: "altro", name: "x", data: {} }], "mio-file");
    expect(bare.items[0]!.source).toBe("mio-file");
  });

  it.each([
    ["tipo sconosciuto", { items: [{ kind: "arma", name: "x", data: {} }] }],
    ["nome vuoto", { items: [{ kind: "item", name: "  ", data: {} }] }],
    ["data non oggetto", { items: [{ kind: "item", name: "x", data: "testo" }] }],
    ["campo extra", { items: [{ kind: "item", name: "x", data: {}, extra: 1 }] }],
    ["campo extra nel file", { ...sample(), altro: 1 }],
    ["nessun documento", { items: [] }],
    ["HTML nei dati", { items: [{ kind: "item", name: "x", data: { text: "<script>alert(1)</script>" } }] }],
    ["HTML annidato", { items: [{ kind: "item", name: "x", data: { a: [{ b: "<img src=x onerror=1>" }] } }] }],
    ["HTML nel nome", { items: [{ kind: "item", name: "<b>x</b>", data: {} }] }],
    ["URL javascript", { items: [{ kind: "item", name: "x", data: { link: "javascript:alert(1)" } }] }],
    ["__proto__", { items: [{ kind: "item", name: "x", data: JSON.parse('{"__proto__": {"a": 1}}') }] }],
    ["troppo annidato", { items: [{ kind: "item", name: "x", data: JSON.parse("{\"a\":".repeat(15) + "1" + "}".repeat(15)) }] }],
    ["dati enormi", { items: [{ kind: "item", name: "x", data: { t: Array.from({ length: 40 }, () => "y".repeat(2000)) } }] }],
    ["campagna con caratteri strani", { ...sample(), campaignId: "../x" }],
  ])("rifiuta: %s", (_name, input) => {
    expect(() => parseContent(input)).toThrow(ContentValidationError);
  });

  it("una disuguaglianza non è HTML", () => {
    expect(() => parseContent({ items: [{ kind: "item", name: "x", data: { text: "CA < 10 e PF > 5, 3 < 4" } }] })).not.toThrow();
  });
});

describe("file e cartelle", () => {
  it("legge file e cartelle ricorsivamente, ignora i non-JSON; JSON non valido => errore", async () => {
    const d = mkdtempSync(join(tmpdir(), "lanterna-content-"));
    dirs.push(d);
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "a.json"), JSON.stringify(sample()));
    writeFileSync(join(d, "sub", "b.json"), JSON.stringify([{ kind: "altro", name: "z", data: {} }]));
    writeFileSync(join(d, "leggimi.txt"), "no");
    expect((await listJsonFiles(d)).map((f) => f.slice(d.length))).toEqual(["/a.json", "/sub/b.json"]);
    expect((await readContentFile(join(d, "sub", "b.json"), 1e6)).items[0]!.source).toBe("b");
    writeFileSync(join(d, "rotto.json"), "{non json");
    await expect(readContentFile(join(d, "rotto.json"), 1e6)).rejects.toThrow(/JSON non valido/);
    await expect(readContentFile(join(d, "a.json"), 10)).rejects.toThrow(/oltre/);
  });
});

describe("REST /content", () => {
  async function admin() {
    return loginAs(ctx.app, "admin");
  }
  const post = (cookie: string | undefined, payload: unknown) =>
    ctx.app.inject({
      method: "POST",
      url: "/content/import",
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      payload: payload as object,
    });
  const get = (url: string, cookie?: string) =>
    ctx.app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });

  it("import/cancellazione: anonimo 401, giocatore 403, admin ok", async () => {
    ctx = await createTestApp();
    const gm = await admin();
    const player = await loginAs(ctx.app, "player");
    expect((await post(undefined, sample())).statusCode).toBe(401);
    expect((await post(player.cookie, sample())).statusCode).toBe(403);
    const ok = await post(gm.cookie, sample());
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ created: 4, updated: 0, total: 4 });

    const id = (await get("/content?kind=item", gm.cookie)).json().items[0].id as string;
    const del = (cookie?: string) =>
      ctx.app.inject({ method: "DELETE", url: `/content/${id}`, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
    expect((await del()).statusCode).toBe(401);
    expect((await del(player.cookie)).statusCode).toBe(403);
    expect((await get(`/content/${id}`, gm.cookie)).statusCode).toBe(200);
    expect((await del(gm.cookie)).statusCode).toBe(204);
    expect((await del(gm.cookie)).statusCode).toBe(404);
    expect((await get(`/content/${id}`, gm.cookie)).statusCode).toBe(404);
  });

  it("la lettura richiede una sessione", async () => {
    ctx = await createTestApp();
    expect((await get("/content")).statusCode).toBe(401);
    expect((await get("/content/abc")).statusCode).toBe(401);
  });

  it("l'importazione è idempotente e tutto-o-niente", async () => {
    ctx = await createTestApp();
    const gm = await admin();
    expect((await post(gm.cookie, sample())).json().created).toBe(4);
    const again = await post(gm.cookie, sample());
    expect(again.json()).toEqual({ created: 0, updated: 4, total: 4 });
    expect((await get("/content", gm.cookie)).json().total).toBe(4);

    const bad = sample();
    bad.items.push({ kind: "item", name: "Cattivo", data: { text: "<script>x</script>", weight: 1 } });
    const res = await post(gm.cookie, bad);
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.join(" ")).toMatch(/HTML/);
    expect((await get("/content", gm.cookie)).json().total).toBe(4);
    expect((await post(gm.cookie, { ...sample(), campaignId: "inesistente" })).statusCode).toBe(404);
  });

  it("limite di dimensione del corpo", async () => {
    ctx = await createTestApp({ CONTENT_MAX_BYTES: "2000" });
    const gm = await admin();
    const big = { items: [{ kind: "altro", name: "x", data: { t: "y".repeat(5000) } }] };
    expect((await post(gm.cookie, big)).statusCode).toBe(413);
  });

  it("il giocatore legge solo item/spell; mostri e note mai, nemmeno per id", async () => {
    ctx = await createTestApp();
    const gm = await admin();
    const player = await loginAs(ctx.app, "player");
    await post(gm.cookie, sample());

    const list = (await get("/content", player.cookie)).json();
    expect(list.items.map((i: { name: string }) => i.name).sort()).toEqual(["Lanterna cieca", "Scintilla di prova"]);
    expect(list.total).toBe(2);
    const monsters = await get("/content?kind=monster", player.cookie);
    expect(monsters.json().items).toEqual([]);
    expect(monsters.body).not.toContain("Gufo");

    const all = (await get("/content", gm.cookie)).json().items as { id: string; kind: string }[];
    const monsterId = all.find((i) => i.kind === "monster")!.id;
    const noteId = all.find((i) => i.kind === "note")!.id;
    for (const id of [monsterId, noteId]) {
      const res = await get(`/content/${id}`, player.cookie);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("SEGRETO-DEL-GM");
    }
    expect((await get(`/content/${monsterId}`, gm.cookie)).json().data.secret).toBe("SEGRETO-DEL-GM");
  });

  it("CONTENT_PLAYER_KINDS non può aprire mostri e note ai giocatori", async () => {
    ctx = await createTestApp({ CONTENT_PLAYER_KINDS: "item,monster,note" });
    const gm = await admin();
    const player = await loginAs(ctx.app, "player");
    await post(gm.cookie, sample());
    const names = (await get("/content", player.cookie)).json().items.map((i: { name: string }) => i.name);
    expect(names).toEqual(["Lanterna cieca"]);
  });

  it("i documenti di una campagna li vedono solo i suoi membri", async () => {
    ctx = await createTestApp();
    const gm = await admin();
    const member = await loginAs(ctx.app, "player");
    const outsider = await loginAs(ctx.app, "player");
    const campaignId = await createCampaignAs(ctx, gm.cookie);
    await addMemberAs(ctx, gm.cookie, campaignId, member.user.id);
    await post(gm.cookie, {
      source: "Casa mia",
      campaignId,
      items: [{ kind: "item", name: "Chiave della cantina", data: { text: "Inventata" } }],
    });
    const find = async (cookie: string) => (await get("/content?q=chiave", cookie)).json().items.length;
    expect(await find(member.cookie)).toBe(1);
    expect(await find(outsider.cookie)).toBe(0);
    expect(await find(gm.cookie)).toBe(1);
  });

  it("ricerca testuale su nome e dati, case-insensitive, con caratteri speciali inerti", async () => {
    ctx = await createTestApp();
    const gm = await admin();
    await post(gm.cookie, sample());
    const names = async (q: string) =>
      (await get(`/content?q=${encodeURIComponent(q)}`, gm.cookie)).json().items.map((i: { name: string }) => i.name);
    expect(await names("LANTERNA")).toEqual(["Lanterna cieca"]);
    expect(await names("inventata")).toEqual(["Scintilla di prova"]);
    expect(await names("%")).toEqual([]);
    expect(await names("_")).toEqual([]);
    expect(await names("'; DROP TABLE content; --")).toEqual([]);
    expect((await get("/content", gm.cookie)).json().total).toBe(4);
    expect((await get("/content?kind=arma", gm.cookie)).statusCode).toBe(400);
    const page = (await get("/content?limit=2&offset=2", gm.cookie)).json();
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(4);
  });

  it("le risposte sono JSON con nosniff e CSP restrittiva", async () => {
    ctx = await createTestApp();
    const gm = await admin();
    const res = await get("/content", gm.cookie);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'none'/);
  });
});
