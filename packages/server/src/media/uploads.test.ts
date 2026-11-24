import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ORIGIN, createTestApp, loginAs, type TestContext } from "../test/helpers.js";
import { makeJpeg, makePng, makeWebpVP8, makeWebpVP8L, makeWebpVP8X, multipart } from "../test/images.js";
import { sniffImage } from "./image.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

describe("sniffImage: tipo e dimensioni dai byte", () => {
  it.each([
    ["PNG", makePng(3, 2), "image/png", 3, 2],
    ["JPEG", makeJpeg(640, 480), "image/jpeg", 640, 480],
    ["WebP VP8X", makeWebpVP8X(5000, 3000), "image/webp", 5000, 3000],
    ["WebP VP8L", makeWebpVP8L(300, 200), "image/webp", 300, 200],
    ["WebP VP8", makeWebpVP8(1024, 768), "image/webp", 1024, 768],
  ])("%s", (_name, buf, mime, width, height) => {
    expect(sniffImage(buf)).toMatchObject({ mime, width, height });
  });

  it.each([
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["testo", Buffer.from("ciao, non sono un'immagine")],
    ["HTML", Buffer.from("<!doctype html><script>alert(1)</script>")],
    ["vuoto", Buffer.alloc(0)],
    ["solo firma PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["PNG senza IHDR", Buffer.concat([makePng(2, 2).subarray(0, 8), Buffer.from("0000tEXtciao0000000000000000000")])],
    ["GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00", "latin1")],
    ["JPEG troncato", makeJpeg(10, 10).subarray(0, 12)],
    ["PNG 0x0", makePng(0, 0, true)],
  ])("rifiuta %s", (_name, buf) => {
    expect(sniffImage(buf)).toBeNull();
  });
});

async function upload(cookie: string | undefined, body: ReturnType<typeof multipart>, kind = "map", origin: string | null = ORIGIN) {
  return ctx.app.inject({
    method: "POST",
    url: `/uploads/${kind}`,
    headers: { ...body.headers, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
    payload: body.payload,
  });
}

describe("POST /uploads/:kind e GET /assets/:name", () => {
  it("admin carica un PNG; un giocatore autenticato lo scarica con intestazioni sicure", async () => {
    ctx = await createTestApp();
    const gm = await loginAs(ctx.app, "admin");
    const player = await loginAs(ctx.app, "player");
    const png = makePng(4, 3);
    // Nome ed estensione del client ignorati: conta il contenuto.
    const res = await upload(gm.cookie, multipart(png, "../../evil.svg", "image/svg+xml"));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ kind: "map", mime: "image/png", width: 4, height: 3, bytes: png.length });
    expect(body.url).toMatch(/^\/assets\/[0-9a-f-]{36}\.png$/);
    expect(body.assetId).toBe(body.url.slice(8, 44));
    expect(existsSync(join(ctx.config.uploadDir, `${body.assetId}.png`))).toBe(true);

    const got = await ctx.app.inject({ method: "GET", url: body.url, headers: { cookie: player.cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["content-disposition"]).toBe(`inline; filename="${body.assetId}.png"`);
    expect(got.rawPayload.equals(png)).toBe(true);

    const anon = await ctx.app.inject({ method: "GET", url: body.url });
    expect(anon.statusCode).toBe(401);

    const token = await upload(gm.cookie, multipart(makeWebpVP8X(256, 256), "t.webp", "image/webp"), "token");
    expect(token.statusCode).toBe(201);
    expect(token.json()).toMatchObject({ kind: "token", mime: "image/webp", width: 256, height: 256 });
    const jpg = await upload(gm.cookie, multipart(makeJpeg(800, 600), "m.jpg", "image/jpeg"));
    expect(jpg.json()).toMatchObject({ mime: "image/jpeg", url: expect.stringMatching(/\.jpg$/) });
  });

  it("solo admin: anonimo 401, giocatore 403, senza Origin 403", async () => {
    ctx = await createTestApp();
    const gm = await loginAs(ctx.app, "admin");
    const player = await loginAs(ctx.app, "player");
    for (const kind of ["map", "token"]) {
      expect((await upload(undefined, multipart(makePng(2, 2)), kind)).statusCode).toBe(401);
      expect((await upload(player.cookie, multipart(makePng(2, 2)), kind)).statusCode).toBe(403);
      expect((await upload(gm.cookie, multipart(makePng(2, 2)), kind, null)).statusCode).toBe(403);
    }
    expect(readdirSync(ctx.config.uploadDir).filter((f) => f !== "forms")).toEqual([]);
  });

  it("rifiuta SVG, falso PNG, file non immagine, multipart assente", async () => {
    ctx = await createTestApp();
    const gm = await loginAs(ctx.app, "admin");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await upload(gm.cookie, multipart(svg, "a.svg", "image/svg+xml"))).statusCode).toBe(415);
    expect((await upload(gm.cookie, multipart(svg, "a.png", "image/png"))).statusCode).toBe(415);
    const fakePng = Buffer.from("<html><script>alert(1)</script></html>");
    expect((await upload(gm.cookie, multipart(fakePng, "mappa.png", "image/png"))).statusCode).toBe(415);
    const sigOnly = Buffer.concat([makePng(1, 1).subarray(0, 8), Buffer.from("<script>alert(1)</script>".repeat(4))]);
    expect((await upload(gm.cookie, multipart(sigOnly, "mappa.png", "image/png"))).statusCode).toBe(415);
    const json = await ctx.app.inject({
      method: "POST",
      url: "/uploads/map",
      headers: { origin: ORIGIN, cookie: gm.cookie },
      payload: { file: "x" },
    });
    expect(json.statusCode).toBe(415);
    expect(readdirSync(ctx.config.uploadDir).filter((f) => f !== "forms")).toEqual([]);
  });

  it("rifiuta file troppo grandi in byte e in pixel", async () => {
    ctx = await createTestApp({ UPLOAD_MAX_BYTES: "2048", UPLOAD_MAX_SIDE: "16384", UPLOAD_MAX_PIXELS: "1000000" });
    const gm = await loginAs(ctx.app, "admin");
    const big = Buffer.concat([makePng(10, 10), Buffer.alloc(4096)]);
    expect((await upload(gm.cookie, multipart(big))).statusCode).toBe(413);
    expect((await upload(gm.cookie, multipart(makePng(20_000, 10, true)))).statusCode).toBe(413);
    expect((await upload(gm.cookie, multipart(makePng(1001, 1000, true)))).statusCode).toBe(413);
    expect((await upload(gm.cookie, multipart(makeWebpVP8X(16_385, 1)))).statusCode).toBe(413);
    expect((await upload(gm.cookie, multipart(makePng(1000, 1000, true)))).statusCode).toBe(201);
    expect(readdirSync(ctx.config.uploadDir).filter((f) => f !== "forms").filter((f) => !f.startsWith("."))).toHaveLength(1);
  });

  it("path traversal e nomi non validi: 404, mai file fuori dalla cartella", async () => {
    ctx = await createTestApp();
    const player = await loginAs(ctx.app, "player");
    const headers = { cookie: player.cookie };
    for (const url of [
      "/assets/..%2F..%2Fpackage.json",
      "/assets/..%2f..%2f..%2fetc%2fpasswd",
      "/assets/%2e%2e%2f%2e%2e%2fpackage.json",
      "/assets/../package.json",
      "/assets/....//....//package.json",
      "/assets/00000000-0000-0000-0000-000000000000.png",
      "/assets/00000000-0000-0000-0000-000000000000.svg",
      "/assets/.env",
      "/assets/%00",
    ]) {
      const r = await ctx.app.inject({ method: "GET", url, headers });
      expect(r.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(r.body).not.toContain("lanterna");
      expect(r.body).not.toContain("root:");
    }
  });
});
