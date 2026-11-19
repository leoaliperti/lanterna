import { afterEach, describe, expect, it } from "vitest";
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

interface Endpoint {
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: (targetId: string) => string;
  payload?: Record<string, unknown>;
  okStatus: number;
}

const endpoints: Endpoint[] = [
  { name: "elenco utenti", method: "GET", url: () => "/admin/users", okStatus: 200 },
  {
    name: "creazione utente",
    method: "POST",
    url: () => "/admin/users",
    payload: { email: "nuovo@example.com", name: "Nuovo", password: PASSWORD, role: "player" },
    okStatus: 201,
  },
  {
    name: "cambio ruolo",
    method: "PATCH",
    url: (id) => `/admin/users/${id}`,
    payload: { role: "admin" },
    okStatus: 200,
  },
  { name: "eliminazione", method: "DELETE", url: (id) => `/admin/users/${id}`, okStatus: 204 },
  {
    name: "reset password",
    method: "POST",
    url: (id) => `/admin/users/${id}/password`,
    payload: { password: "nuova-password-456" },
    okStatus: 204,
  },
];

describe.each(endpoints)("$method /admin ($name): controllo dei ruoli lato server", (ep) => {
  async function call(cookie?: string) {
    const target = await createUser(ctx.app, "player");
    const res = await ctx.app.inject({
      method: ep.method,
      url: ep.url(target.id),
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      ...(ep.payload ? { payload: ep.payload } : {}),
    });
    return { res, target };
  }

  it("anonimo: 401", async () => {
    ctx = await createTestApp();
    const { res, target } = await call();
    expect(res.statusCode).toBe(401);
    expect(await ctx.app.users.findById(target.id)).toMatchObject({ role: "player" });
    expect(await ctx.app.users.findByEmail("nuovo@example.com")).toBeNull();
  });

  it("giocatore: 403", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "player");
    const { res, target } = await call(cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "Permesso negato" });
    expect(await ctx.app.users.findById(target.id)).toMatchObject({ role: "player" });
    expect(await ctx.app.users.findByEmail("nuovo@example.com")).toBeNull();
  });

  it("admin: ok", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    const { res } = await call(cookie);
    expect(res.statusCode).toBe(ep.okStatus);
  });

  it("giocatore con payload invalido: comunque 403 (il ruolo si controlla prima del corpo)", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "player");
    const target = await createUser(ctx.app, "player");
    const res = await ctx.app.inject({
      method: ep.method,
      url: ep.url(target.id),
      headers: { origin: ORIGIN, cookie },
      ...(ep.method === "GET" || ep.method === "DELETE" ? {} : { payload: { foo: 1 } }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("creazione utenti", () => {
  it("l'utente creato può fare login con il ruolo assegnato", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/users",
      headers: { origin: ORIGIN, cookie },
      payload: { email: "Mario@Example.com", name: "Mario", password: PASSWORD, role: "player" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ email: "mario@example.com", name: "Mario", role: "player" });
    expect(body).not.toHaveProperty("password");
    const login = await signIn(ctx.app, "mario@example.com");
    expect(login.statusCode).toBe(200);
    expect(login.json().user.role).toBe("player");
  });

  it("email duplicata: 409", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    await createUser(ctx.app, "player", "doppio@example.com");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/users",
      headers: { origin: ORIGIN, cookie },
      payload: { email: "DOPPIO@example.com", name: "x", password: PASSWORD, role: "player" },
    });
    expect(res.statusCode).toBe(409);
  });

  it.each([
    ["password troppo corta", { email: "a@example.com", name: "a", password: "corta", role: "player" }],
    ["ruolo inesistente", { email: "a@example.com", name: "a", password: PASSWORD, role: "superuser" }],
    ["email non valida", { email: "non-una-email", name: "a", password: PASSWORD, role: "player" }],
    ["campi extra", { email: "a@example.com", name: "a", password: PASSWORD, role: "player", emailVerified: false }],
    ["campi mancanti", { email: "a@example.com" }],
  ])("%s: 400", async (_label, payload) => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/users",
      headers: { origin: ORIGIN, cookie },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(await ctx.app.users.findByEmail("a@example.com")).toBeNull();
  });

  it("rate limit sulla creazione utenti: 429", async () => {
    ctx = await createTestApp({ RATE_LIMIT_CREATE_USER_MAX: "2" });
    const { cookie } = await loginAs(ctx.app, "admin");
    const create = (n: number) =>
      ctx.app.inject({
        method: "POST",
        url: "/admin/users",
        headers: { origin: ORIGIN, cookie },
        payload: { email: `u${n}@example.com`, name: `u${n}`, password: PASSWORD, role: "player" },
      });
    expect((await create(1)).statusCode).toBe(201);
    expect((await create(2)).statusCode).toBe(201);
    expect((await create(3)).statusCode).toBe(429);
    expect(await ctx.app.users.findByEmail("u3@example.com")).toBeNull();
  });
});

describe("elenco utenti", () => {
  it("non espone hash o dati di sessione", async () => {
    ctx = await createTestApp();
    const { user, cookie } = await loginAs(ctx.app, "admin");
    await createUser(ctx.app, "player", "p@example.com");
    const res = await ctx.app.inject({ method: "GET", url: "/admin/users", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { users } = res.json();
    expect(users).toHaveLength(2);
    expect(users.map((u: { email: string }) => u.email)).toContain(user.email);
    for (const u of users) expect(Object.keys(u).sort()).toEqual(["createdAt", "email", "id", "name", "role"]);
    expect(res.body).not.toContain("scrypt");
  });
});

describe("cambio ruolo e ultimo admin", () => {
  it("l'unico admin non può declassarsi: 409", async () => {
    ctx = await createTestApp();
    const { user, cookie } = await loginAs(ctx.app, "admin");
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/admin/users/${user.id}`,
      headers: { origin: ORIGIN, cookie },
      payload: { role: "player" },
    });
    expect(res.statusCode).toBe(409);
    expect(await ctx.app.users.findById(user.id)).toMatchObject({ role: "admin" });
  });

  it("con due admin uno può essere declassato, ma non anche l'altro", async () => {
    ctx = await createTestApp();
    const { user: me, cookie } = await loginAs(ctx.app, "admin");
    const other = await createUser(ctx.app, "admin");
    const demote = (id: string) =>
      ctx.app.inject({
        method: "PATCH",
        url: `/admin/users/${id}`,
        headers: { origin: ORIGIN, cookie },
        payload: { role: "player" },
      });
    const first = await demote(other.id);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: other.id, role: "player" });
    expect((await demote(me.id)).statusCode).toBe(409);
  });

  it("il declassamento ha effetto subito sulle sessioni esistenti", async () => {
    ctx = await createTestApp();
    const { cookie: adminCookie } = await loginAs(ctx.app, "admin");
    const { user: other, cookie: otherCookie } = await loginAs(ctx.app, "admin");
    const before = await ctx.app.inject({ method: "GET", url: "/admin/users", headers: { cookie: otherCookie } });
    expect(before.statusCode).toBe(200);
    await ctx.app.inject({
      method: "PATCH",
      url: `/admin/users/${other.id}`,
      headers: { origin: ORIGIN, cookie: adminCookie },
      payload: { role: "player" },
    });
    const after = await ctx.app.inject({ method: "GET", url: "/admin/users", headers: { cookie: otherCookie } });
    expect(after.statusCode).toBe(403);
  });

  it("utente inesistente: 404", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/admin/users/non-esiste",
      headers: { origin: ORIGIN, cookie },
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("eliminazione e ultimo admin", () => {
  it("l'unico admin non può eliminarsi: 409", async () => {
    ctx = await createTestApp();
    const { user, cookie } = await loginAs(ctx.app, "admin");
    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/admin/users/${user.id}`,
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(await ctx.app.users.findById(user.id)).not.toBeNull();
  });

  it("con due admin se ne può eliminare uno, non l'ultimo", async () => {
    ctx = await createTestApp();
    const { user: me, cookie } = await loginAs(ctx.app, "admin");
    const other = await createUser(ctx.app, "admin");
    const del = (id: string) =>
      ctx.app.inject({ method: "DELETE", url: `/admin/users/${id}`, headers: { origin: ORIGIN, cookie } });
    expect((await del(other.id)).statusCode).toBe(204);
    expect((await del(me.id)).statusCode).toBe(409);
  });

  it("l'utente eliminato perde la sessione e non può più entrare", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    const { user: player, cookie: playerCookie } = await loginAs(ctx.app, "player");
    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/admin/users/${player.id}`,
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.statusCode).toBe(204);
    const s = await ctx.app.inject({ method: "GET", url: "/auth/get-session", headers: { cookie: playerCookie } });
    expect(s.json()).toBeNull();
    expect((await signIn(ctx.app, player.email)).statusCode).toBe(401);
  });

  it("utente inesistente: 404", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    const res = await ctx.app.inject({
      method: "DELETE",
      url: "/admin/users/non-esiste",
      headers: { origin: ORIGIN, cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("reset password", () => {
  it("la nuova password funziona, la vecchia no, le sessioni vengono chiuse", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    const { user: player, cookie: playerCookie } = await loginAs(ctx.app, "player");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/admin/users/${player.id}/password`,
      headers: { origin: ORIGIN, cookie },
      payload: { password: "nuova-password-456" },
    });
    expect(res.statusCode).toBe(204);
    const s = await ctx.app.inject({ method: "GET", url: "/auth/get-session", headers: { cookie: playerCookie } });
    expect(s.json()).toBeNull();
    expect((await signIn(ctx.app, player.email)).statusCode).toBe(401);
    expect((await signIn(ctx.app, player.email, "nuova-password-456")).statusCode).toBe(200);
  });

  it("password troppo corta: 400", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    const player = await createUser(ctx.app, "player");
    const res = await ctx.app.inject({
      method: "POST",
      url: `/admin/users/${player.id}/password`,
      headers: { origin: ORIGIN, cookie },
      payload: { password: "corta" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("utente inesistente: 404", async () => {
    ctx = await createTestApp();
    const { cookie } = await loginAs(ctx.app, "admin");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/users/non-esiste/password",
      headers: { origin: ORIGIN, cookie },
      payload: { password: "nuova-password-456" },
    });
    expect(res.statusCode).toBe(404);
  });
});
