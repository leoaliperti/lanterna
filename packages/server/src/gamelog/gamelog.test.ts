import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, loginAs, type TestContext } from "../test/helpers.js";
import { createCampaignAs } from "../test/campaign.js";
import { GAME_LOG_KEEP, listGameLog, writeGameLog } from "./store.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

describe("registro di gioco", () => {
  it("le voci si leggono dalla più recente, a pagine, e si conservano solo le ultime", async () => {
    ctx = await createTestApp();
    const gm = await loginAs(ctx.app, "admin");
    const campaignId = await createCampaignAs(ctx, gm.cookie);
    const db = ctx.app.database.db;

    await writeGameLog(db, campaignId, 1, "Lia", ["Token «Goblin» aggiunto"]);
    await writeGameLog(db, campaignId, 2, "Lia", ["PF 7 → 3"]);
    await writeGameLog(db, campaignId, 3, "Sam", []); // nessuna frase: nessuna voce
    const page = await listGameLog(db, campaignId, null);
    expect(page.map((e) => e.version)).toEqual([2, 1]);
    expect(page[0]!.lines).toEqual(["PF 7 → 3"]);
    expect(await listGameLog(db, campaignId, 2)).toHaveLength(1);

    // Oltre la soglia le voci più vecchie spariscono.
    await writeGameLog(db, campaignId, 2 + GAME_LOG_KEEP + 1, "Lia", ["recente"]);
    const after = await listGameLog(db, campaignId, null, 500);
    expect(after.some((e) => e.version === 1)).toBe(false);
  });

  it("il GM legge il registro, il giocatore no (403) e una campagna inesistente dà 404", async () => {
    ctx = await createTestApp();
    const gm = await loginAs(ctx.app, "admin");
    const player = await loginAs(ctx.app, "player");
    const campaignId = await createCampaignAs(ctx, gm.cookie);
    const ok = await ctx.app.inject({ method: "GET", url: `/campaigns/${campaignId}/game-log`, headers: { cookie: gm.cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ entries: [] });
    const denied = await ctx.app.inject({ method: "GET", url: `/campaigns/${campaignId}/game-log`, headers: { cookie: player.cookie } });
    expect(denied.statusCode).toBe(403);
    const missing = await ctx.app.inject({ method: "GET", url: "/campaigns/nope/game-log", headers: { cookie: gm.cookie } });
    expect(missing.statusCode).toBe(404);
  });
});
