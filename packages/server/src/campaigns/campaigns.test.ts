import { afterEach, describe, expect, it } from "vitest";
import { ORIGIN, createTestApp, createUser, loginAs, type TestContext } from "../test/helpers.js";
import { addMemberAs, createCampaignAs } from "../test/campaign.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

interface Endpoint {
  name: string;
  method: "GET" | "POST" | "DELETE";
  url: (campaignId: string, userId: string) => string;
  payload?: (userId: string) => Record<string, unknown>;
  okStatus: number;
}

/** Rotte solo-admin: anonimo 401, giocatore 403, admin ok. */
const adminEndpoints: Endpoint[] = [
  { name: "elenco campagne", method: "GET", url: () => "/campaigns", okStatus: 200 },
  { name: "creazione campagna", method: "POST", url: () => "/campaigns", payload: () => ({ name: "Nuova" }), okStatus: 201 },
  { name: "elenco membri", method: "GET", url: (c) => `/campaigns/${c}/members`, okStatus: 200 },
  {
    name: "aggiunta membro",
    method: "POST",
    url: (c) => `/campaigns/${c}/members`,
    payload: (u) => ({ userId: u }),
    okStatus: 201,
  },
  { name: "rimozione membro", method: "DELETE", url: (c, u) => `/campaigns/${c}/members/${u}`, okStatus: 204 },
];

describe.each(adminEndpoints)("$method campagne ($name): ruoli verificati lato server", (ep) => {
  async function call(cookie: string | undefined, campaignId: string, userId: string, addFirst: boolean, gmCookie: string) {
    if (addFirst) await addMemberAs(ctx, gmCookie, campaignId, userId);
    return ctx.app.inject({
      method: ep.method,
      url: ep.url(campaignId, userId),
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      ...(ep.payload ? { payload: ep.payload(userId) } : {}),
    });
  }

  it("anonimo: 401, giocatore: 403 (anche se membro), admin: ok", async () => {
    ctx = await createTestApp();
    const gm = await loginAs(ctx.app, "admin");
    const player = await loginAs(ctx.app, "player");
    const campaignId = await createCampaignAs(ctx, gm.cookie);
    await addMemberAs(ctx, gm.cookie, campaignId, player.user.id);
    const target = await createUser(ctx.app, "player");
    const needsMember = ep.method === "DELETE";

    expect((await call(undefined, campaignId, target.id, needsMember, gm.cookie)).statusCode).toBe(401);
    expect((await call(player.cookie, campaignId, target.id, false, gm.cookie)).statusCode).toBe(403);
    expect((await call(gm.cookie, campaignId, target.id, false, gm.cookie)).statusCode).toBe(ep.okStatus);
  });
});

describe("campagne e membri", () => {
  it("GET /campaigns/mine: solo le campagne di cui si è membri", async () => {
    ctx = await createTestApp();
    const gm = await loginAs(ctx.app, "admin");
    const player = await loginAs(ctx.app, "player");
    const a = await createCampaignAs(ctx, gm.cookie, "Alfa");
    await createCampaignAs(ctx, gm.cookie, "Beta");
    await addMemberAs(ctx, gm.cookie, a, player.user.id);

    const mine = await ctx.app.inject({ method: "GET", url: "/campaigns/mine", headers: { cookie: player.cookie } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().campaigns.map((c: { name: string }) => c.name)).toEqual(["Alfa"]);
    const anon = await ctx.app.inject({ method: "GET", url: "/campaigns/mine" });
    expect(anon.statusCode).toBe(401);
    const all = await ctx.app.inject({ method: "GET", url: "/campaigns", headers: { cookie: gm.cookie } });
    expect(all.json().campaigns).toHaveLength(2);
  });

  it("validazione: nome vuoto, campi extra, membro doppio o inesistente, ultimo GM", async () => {
    ctx = await createTestApp();
    const gm = await loginAs(ctx.app, "admin");
    const headers = { origin: ORIGIN, cookie: gm.cookie };
    for (const payload of [{ name: "" }, { name: "   " }, { name: "x", extra: 1 }, { name: "x".repeat(65) }]) {
      const r = await ctx.app.inject({ method: "POST", url: "/campaigns", headers, payload });
      expect(r.statusCode).toBe(400);
    }
    const id = await createCampaignAs(ctx, gm.cookie);
    const p = await createUser(ctx.app, "player");
    await addMemberAs(ctx, gm.cookie, id, p.id);
    const dup = await ctx.app.inject({ method: "POST", url: `/campaigns/${id}/members`, headers, payload: { userId: p.id } });
    expect(dup.statusCode).toBe(409);
    const ghost = await ctx.app.inject({ method: "POST", url: `/campaigns/${id}/members`, headers, payload: { userId: "nessuno" } });
    expect(ghost.statusCode).toBe(404);
    const noCampaign = await ctx.app.inject({ method: "POST", url: "/campaigns/nessuna/members", headers, payload: { userId: p.id } });
    expect(noCampaign.statusCode).toBe(404);
    const last = await ctx.app.inject({ method: "DELETE", url: `/campaigns/${id}/members/${gm.user.id}`, headers });
    expect(last.statusCode).toBe(409);
    const members = await ctx.app.inject({ method: "GET", url: `/campaigns/${id}/members`, headers });
    expect(members.json().members).toEqual([
      { userId: gm.user.id, displayName: "admin", role: "admin" },
      { userId: p.id, displayName: "player", role: "player" },
    ]);
  });

  it("senza Origin le modifiche sono rifiutate (CSRF)", async () => {
    ctx = await createTestApp();
    const gm = await loginAs(ctx.app, "admin");
    const r = await ctx.app.inject({ method: "POST", url: "/campaigns", headers: { cookie: gm.cookie }, payload: { name: "x" } });
    expect(r.statusCode).toBe(403);
  });
});
