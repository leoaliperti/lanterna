import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cookiesOf, createTestApp, createUser, ORIGIN, PASSWORD, type TestContext } from "./test/helpers.js";
import { listen, WsClient } from "./test/ws.js";
import { isApiPath, pageCsp } from "./web.js";

let ctx: TestContext | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Un finto client compilato (nessun contenuto reale): index.html + un asset con hash + un file senza hash. */
function fakeClient(): string {
  const dir = mkdtempSync(join(tmpdir(), "lanterna-client-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Lanterna</title><div id=root></div>");
  writeFileSync(join(dir, "assets", "index-B4BtRv5a.js"), "console.log(1);\n".repeat(200));
  writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dir, ".segreto"), "no");
  return dir;
}

async function prodApp(extra: NodeJS.ProcessEnv = {}) {
  return createTestApp({
    NODE_ENV: "production",
    ALLOW_INSECURE_HTTP: "true",
    BETTER_AUTH_URL: ORIGIN,
    CLIENT_DIR: fakeClient(),
    ...extra,
  });
}

describe("client compilato servito dal server", () => {
  it("/ e le rotte dell'SPA danno index.html, sempre rivalidato, con CSP e header di sicurezza", async () => {
    ctx = await prodApp();
    for (const url of ["/", "/campagne/42", "/login?x=1"]) {
      const res = await ctx.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain("<title>Lanterna</title>");
      const csp = String(res.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).toContain("connect-src 'self' ws://localhost:3000");
      expect(csp).not.toMatch(/unsafe-eval|https?:\/\/(?!localhost)/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBeDefined();
    }
  });

  it("gli asset con hash sono immutable, gli altri file no", async () => {
    ctx = await prodApp();
    const js = await ctx.app.inject({ method: "GET", url: "/assets/index-B4BtRv5a.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const icon = await ctx.app.inject({ method: "GET", url: "/favicon.svg" });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["cache-control"]).toBe("no-cache");
  });

  it("file mancanti con estensione e file nascosti: 404, non l'SPA", async () => {
    ctx = await prodApp();
    for (const url of ["/assets/vecchio-AAAAAAAA.js", "/.segreto", "/assets/../.segreto", "/%2e%2e/%2e%2e/etc/passwd.txt"]) {
      const res = await ctx.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain("<title>");
    }
  });

  it("comprime le risposte grandi", async () => {
    ctx = await prodApp();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/assets/index-B4BtRv5a.js",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("l'API sta sotto /api, con CSP restrittiva; /api/ignoto è un 404 JSON", async () => {
    ctx = await prodApp();
    const health = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(health.json()).toEqual({ status: "ok" });
    expect(health.headers["content-security-policy"]).toMatch(/^default-src 'none'/);
    const missing = await ctx.app.inject({ method: "GET", url: "/api/non-esiste" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toMatch(/json/);
    // Le POST senza Origin restano rifiutate.
    const post = await ctx.app.inject({ method: "POST", url: "/api/auth/sign-in/email", payload: {} });
    expect(post.statusCode).toBe(403);
  });

  it("login, sessione e rotte admin funzionano con il prefisso", async () => {
    ctx = await prodApp();
    const admin = await createUser(ctx.app, "admin");
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: ORIGIN },
      payload: { email: admin.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookiesOf(login);
    const session = await ctx.app.inject({ method: "GET", url: "/api/auth/get-session", headers: { cookie } });
    expect(session.json().user).toMatchObject({ id: admin.id, role: "admin" });
    const users = await ctx.app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie } });
    expect(users.statusCode).toBe(200);
    const anon = await ctx.app.inject({ method: "GET", url: "/api/admin/users" });
    expect(anon.statusCode).toBe(401);
    // Senza il prefisso non esiste una seconda porta d'ingresso.
    const bare = await ctx.app.inject({ method: "GET", url: "/admin/users", headers: { cookie } });
    expect(bare.headers["content-type"]).toMatch(/text\/html/);
    expect(bare.body).not.toContain(admin.email);
  });

  it("WebSocket su /api/ws; /ws non risponde", async () => {
    ctx = await prodApp();
    const admin = await createUser(ctx.app, "admin");
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: ORIGIN },
      payload: { email: admin.email, password: PASSWORD },
    });
    const cookie = cookiesOf(login);
    const port = await listen(ctx);
    const ws = await WsClient.connect(port, { cookie, path: "/api/ws" });
    ws.ws.close();
    await expect(WsClient.connect(port, { cookie, path: "/ws" })).rejects.toThrow();
    await expect(WsClient.connect(port, { path: "/api/ws" })).rejects.toThrow(/401/);
  });

  it("senza client compilato il server non parte con un errore chiaro", async () => {
    await expect(prodApp({ CLIENT_DIR: join(tmpdir(), "lanterna-non-esiste") })).rejects.toThrow(/npm run build/);
  });

  it("in sviluppo non serve il client e l'API resta alla radice", async () => {
    ctx = await createTestApp();
    expect((await ctx.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
  });
});

describe("pageCsp e isApiPath", () => {
  it("unsafe-eval solo se richiesto; wss con https", () => {
    expect(pageCsp({ baseURL: "https://l.example", cspUnsafeEval: false })).toContain("wss://l.example");
    expect(pageCsp({ baseURL: "https://l.example", cspUnsafeEval: false })).not.toContain("unsafe-eval");
    expect(pageCsp({ baseURL: "https://l.example", cspUnsafeEval: true })).toContain("script-src 'self' 'unsafe-eval'");
  });
  it("riconosce i percorsi dell'API", () => {
    expect(isApiPath("/api", "/api")).toBe(true);
    expect(isApiPath("/api/x", "/api")).toBe(true);
    expect(isApiPath("/apix", "/api")).toBe(false);
  });
});
