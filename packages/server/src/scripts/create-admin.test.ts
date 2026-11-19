import { afterEach, describe, expect, it } from "vitest";
import { PASSWORD, createTestApp, createUser, signIn, type TestContext } from "../test/helpers.js";
import { ensureAdmin } from "./ensure-admin.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

describe("ensureAdmin (script create-admin)", () => {
  it("crea l'admin, che può fare login", async () => {
    ctx = await createTestApp();
    const result = await ensureAdmin(ctx.app.users, { email: "gm@example.com", name: "GM", password: PASSWORD });
    expect(result.status).toBe("created");
    const login = await signIn(ctx.app, "gm@example.com");
    expect(login.statusCode).toBe(200);
    expect(login.json().user.role).toBe("admin");
  });

  it("è idempotente: la seconda volta non cambia nulla (nemmeno la password)", async () => {
    ctx = await createTestApp();
    await ensureAdmin(ctx.app.users, { email: "gm@example.com", name: "GM", password: PASSWORD });
    const again = await ensureAdmin(ctx.app.users, {
      email: "GM@example.com",
      name: "Altro",
      password: "un-altra-password-999",
    });
    expect(again.status).toBe("exists");
    expect((await ctx.app.users.list()).length).toBe(1);
    expect((await signIn(ctx.app, "gm@example.com")).statusCode).toBe(200);
  });

  it("non promuove in silenzio un giocatore esistente", async () => {
    ctx = await createTestApp();
    await createUser(ctx.app, "player", "p@example.com");
    await expect(
      ensureAdmin(ctx.app.users, { email: "p@example.com", name: "p", password: PASSWORD }),
    ).rejects.toThrow(/giocatore/);
    expect(await ctx.app.users.findByEmail("p@example.com")).toMatchObject({ role: "player" });
  });

  it("applica la policy della password", async () => {
    ctx = await createTestApp();
    await expect(
      ensureAdmin(ctx.app.users, { email: "gm@example.com", name: "GM", password: "corta" }),
    ).rejects.toThrow(/caratteri/);
  });
});
