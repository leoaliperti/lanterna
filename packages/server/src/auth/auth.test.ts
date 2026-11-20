import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { session } from "../db/schema.js";
import {
  ORIGIN,
  PASSWORD,
  createTestApp,
  createUser,
  loginAs,
  signIn,
  type TestContext,
} from "../test/helpers.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

describe("registrazione pubblica", () => {
  it("POST /auth/sign-up/email non esiste (404) e non crea utenti", async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/sign-up/email",
      headers: { origin: ORIGIN },
      payload: { email: "intruso@example.com", password: PASSWORD, name: "intruso" },
    });
    expect(res.statusCode).toBe(404);
    expect(await ctx.app.users.findByEmail("intruso@example.com")).toBeNull();
  });

  it("anche chiamando Better Auth direttamente il sign-up è disabilitato", async () => {
    ctx = await createTestApp();
    await expect(
      ctx.app.auth.api.signUpEmail({
        body: { email: "intruso@example.com", password: PASSWORD, name: "intruso" },
      }),
    ).rejects.toThrow();
    expect(await ctx.app.users.findByEmail("intruso@example.com")).toBeNull();
  });

  it.each(["/auth/update-user", "/auth/delete-user", "/auth/request-password-reset", "/auth/list-sessions"])(
    "le altre rotte di Better Auth non sono esposte: %s",
    async (url) => {
      ctx = await createTestApp();
      const { cookie } = await loginAs(ctx.app, "player");
      const res = await ctx.app.inject({
        method: "POST",
        url,
        headers: { origin: ORIGIN, cookie },
        payload: { name: "x", role: "admin" },
      });
      expect(res.statusCode).toBe(404);
    },
  );
});

describe("login", () => {
  it("credenziali giuste: 200 e cookie HttpOnly, SameSite=Lax", async () => {
    ctx = await createTestApp();
    const user = await createUser(ctx.app, "player", "Giocatore@Example.com");
    const res = await signIn(ctx.app, "giocatore@example.com");
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: user.id, role: "player" });
    const raw = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    const sessionCookie = raw.find((c) => c.includes("session_token"));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).not.toMatch(/Secure/i);
  });

  it("password errata ed email inesistente danno la stessa risposta 401", async () => {
    ctx = await createTestApp();
    const user = await createUser(ctx.app, "player");
    const wrongPassword = await signIn(ctx.app, user.email, "password-sbagliata-000");
    const unknownUser = await signIn(ctx.app, "nessuno@example.com", "password-sbagliata-000");
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.body).toBe(unknownUser.body);
    expect(wrongPassword.headers["set-cookie"]).toBeUndefined();
  });

  it("in produzione il cookie è Secure", async () => {
    ctx = await createTestApp({ NODE_ENV: "production", ALLOW_INSECURE_HTTP: "true", API_PREFIX: "", SERVE_CLIENT: "false" });
    const user = await createUser(ctx.app, "player");
    const res = await signIn(ctx.app, user.email);
    expect(res.statusCode).toBe(200);
    const raw = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    const sessionCookie = raw.find((c) => c.includes("session_token"));
    expect(sessionCookie).toMatch(/^__Secure-/);
    expect(sessionCookie).toMatch(/; Secure/i);
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
  });
});

describe("sessione", () => {
  it("get-session restituisce utente e ruolo; senza cookie nessuna sessione", async () => {
    ctx = await createTestApp();
    const { user, cookie } = await loginAs(ctx.app, "admin");
    const withCookie = await ctx.app.inject({ method: "GET", url: "/auth/get-session", headers: { cookie } });
    expect(withCookie.statusCode).toBe(200);
    expect(withCookie.json().user).toMatchObject({ id: user.id, role: "admin" });

    const anonymous = await ctx.app.inject({ method: "GET", url: "/auth/get-session" });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toBeNull();
  });

  it("sign-out invalida la sessione", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    const out = await ctx.app.inject({
      method: "POST",
      url: "/auth/sign-out",
      headers: { origin: ORIGIN, cookie },
      payload: {},
    });
    expect(out.statusCode).toBe(200);
    const res = await ctx.app.inject({ method: "GET", url: "/admin/users", headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it("una sessione scaduta non vale più: 401", async () => {
    ctx = await createTestApp();
    const { user, cookie } = await loginAs(ctx.app, "admin");
    const before = await ctx.app.inject({ method: "GET", url: "/admin/users", headers: { cookie } });
    expect(before.statusCode).toBe(200);

    await ctx.app.database.db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(session.userId, user.id));

    const after = await ctx.app.inject({ method: "GET", url: "/admin/users", headers: { cookie } });
    expect(after.statusCode).toBe(401);
    const s = await ctx.app.inject({ method: "GET", url: "/auth/get-session", headers: { cookie } });
    expect(s.json()).toBeNull();
  });

  it("cookie contraffatto: 401", async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { cookie: "lanterna.session_token=falso.firma" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("cambio password personale", () => {
  it("anonimo 401", async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { origin: ORIGIN },
      payload: { currentPassword: PASSWORD, newPassword: "nuova-password-456" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("il giocatore cambia la propria password", async () => {
    ctx = await createTestApp();
    const { user, cookie } = await loginAs(ctx.app, "player");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { origin: ORIGIN, cookie },
      payload: { currentPassword: PASSWORD, newPassword: "nuova-password-456" },
    });
    expect(res.statusCode).toBe(200);
    expect((await signIn(ctx.app, user.email)).statusCode).toBe(401);
    expect((await signIn(ctx.app, user.email, "nuova-password-456")).statusCode).toBe(200);
  });

  it("rifiuta una password troppo corta", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "player");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { origin: ORIGIN, cookie },
      payload: { currentPassword: PASSWORD, newPassword: "corta" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("rate limit del login", () => {
  it("dopo N tentativi dallo stesso IP risponde 429, un altro IP no", async () => {
    ctx = await createTestApp({ RATE_LIMIT_LOGIN_MAX: "3" });
    const user = await createUser(ctx.app, "player");
    for (let i = 0; i < 3; i++) {
      expect((await signIn(ctx.app, user.email, "sbagliata-sbagliata", "10.0.0.1")).statusCode).toBe(401);
    }
    // Anche con la password giusta: il limite vale per IP.
    expect((await signIn(ctx.app, user.email, PASSWORD, "10.0.0.1")).statusCode).toBe(429);
    expect((await signIn(ctx.app, user.email, PASSWORD, "10.0.0.2")).statusCode).toBe(200);
  });

  it("senza proxy fidato X-Forwarded-For è ignorato", async () => {
    ctx = await createTestApp({ RATE_LIMIT_LOGIN_MAX: "2" });
    const user = await createUser(ctx.app, "player");
    const attempt = (fwd: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/auth/sign-in/email",
        remoteAddress: "10.0.0.1",
        headers: { origin: ORIGIN, "x-forwarded-for": fwd },
        payload: { email: user.email, password: "sbagliata-sbagliata" },
      });
    expect((await attempt("1.1.1.1")).statusCode).toBe(401);
    expect((await attempt("2.2.2.2")).statusCode).toBe(401);
    expect((await attempt("3.3.3.3")).statusCode).toBe(429);
  });

  it("dietro un proxy fidato (Cloudflare Tunnel) conta l'IP del client in X-Forwarded-For", async () => {
    ctx = await createTestApp({ RATE_LIMIT_LOGIN_MAX: "1", TRUST_PROXY: "loopback" });
    const user = await createUser(ctx.app, "player");
    const attempt = (fwd: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/auth/sign-in/email",
        remoteAddress: "127.0.0.1",
        headers: { origin: ORIGIN, "x-forwarded-for": fwd },
        payload: { email: user.email, password: PASSWORD },
      });
    expect((await attempt("203.0.113.1")).statusCode).toBe(200);
    expect((await attempt("203.0.113.1")).statusCode).toBe(429);
    expect((await attempt("203.0.113.2")).statusCode).toBe(200);
  });
});

describe("controllo Origin (CSRF)", () => {
  it("POST senza Origin né Referer: 403", async () => {
    ctx = await createTestApp();
    const user = await createUser(ctx.app, "player");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/sign-in/email",
      payload: { email: user.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST da un'origine estranea: 403", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/users",
      headers: { origin: "https://cattivo.example", cookie },
      payload: { email: "x@example.com", name: "x", password: PASSWORD, role: "player" },
    });
    expect(res.statusCode).toBe(403);
    expect(await ctx.app.users.findByEmail("x@example.com")).toBeNull();
  });

  it("l'origine del client Vite in sviluppo è ammessa", async () => {
    ctx = await createTestApp();
    const user = await createUser(ctx.app, "player");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/sign-in/email",
      headers: { origin: "http://localhost:5173" },
      payload: { email: user.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });

  it("il Referer della stessa origine basta se manca Origin", async () => {
    ctx = await createTestApp();
    const user = await createUser(ctx.app, "player");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/sign-in/email",
      headers: { referer: `${ORIGIN}/login` },
      payload: { email: user.email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("header di sicurezza", () => {
  it("sono presenti anche su /health", async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });
});

describe("sessione da richiesta di upgrade (WebSocket)", () => {
  it("ricava utente e ruolo dagli header", async () => {
    ctx = await createTestApp();
    const { getSessionFromUpgradeRequest } = await import("./session.js");
    const { user, cookie } = await loginAs(ctx.app, "player");
    const fakeReq = { headers: { cookie, origin: ORIGIN, upgrade: "websocket" } } as never;
    const result = await getSessionFromUpgradeRequest(ctx.app.auth, fakeReq);
    expect(result?.user).toMatchObject({ id: user.id, role: "player" });
    const anon = await getSessionFromUpgradeRequest(ctx.app.auth, { headers: {} } as never);
    expect(anon).toBeNull();
  });
});
