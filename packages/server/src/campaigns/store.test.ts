import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Command, ServerMessage } from "@lanterna/shared";
import { createTestApp, loginAs, type TestContext } from "../test/helpers.js";
import { MAIN, PREP, addMemberAs, createCampaignAs, scene, token } from "../test/campaign.js";
import type { Peer } from "../realtime/hub.js";
import { loadCampaign } from "./store.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

function fakePeer(userId: string): Peer & { inbox: ServerMessage[] } {
  const inbox: ServerMessage[] = [];
  return {
    id: randomUUID(),
    userId,
    sessionId: "s",
    viewAs: null,
    readOnly: false,
    actor: null,
    campaignId: null,
    lastSent: 0,
    inbox,
    send: (m) => inbox.push(m),
    close: () => {},
  };
}

/** Generatore pseudo-casuale deterministico (riproducibile). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("persistenza delle campagne", () => {
  it("dopo ogni comando lo stato salvato coincide con quello in memoria (ordine dei token compreso)", async () => {
    ctx = await createTestApp();
    const gm = await loginAs(ctx.app, "admin");
    const p1 = await loginAs(ctx.app, "player");
    const campaignId = await createCampaignAs(ctx, gm.cookie);
    await addMemberAs(ctx, gm.cookie, campaignId, p1.user.id);
    const hub = ctx.app.realtime;
    const peer = fakePeer(gm.user.id);
    hub.addPeer(peer);
    hub.hello(peer, { type: "hello", protocolVersion: 1, campaignId, lastVersion: null, epoch: null });

    const run = async (input: { type: "command"; command: Command } | { type: "undo" } | { type: "redo" }) => {
      await hub.submit(peer, { ...input, requestId: randomUUID() });
    };
    await run({ type: "command", command: { type: "scene.create", scene: scene(MAIN) } });
    await run({ type: "command", command: { type: "scene.create", scene: scene(PREP) } });
    await run({ type: "command", command: { type: "scene.activate", sceneId: MAIN } });

    const random = rng(42);
    const ids: string[] = [];
    for (let i = 0; i < 150; i++) {
      const r = random();
      const pick = ids[Math.floor(random() * ids.length)];
      let cmd: Command | null = null;
      if (r < 0.3 || !pick) {
        const id = `t${i}`;
        ids.push(id);
        cmd = {
          type: "token.create",
          token: token(id, {
            sceneId: random() < 0.7 ? MAIN : PREP,
            x: Math.floor(random() * 1400),
            y: Math.floor(random() * 1000),
            ownerUserId: random() < 0.3 ? p1.user.id : null,
            hidden: random() < 0.2,
          }),
        };
      } else if (r < 0.55) {
        cmd = { type: "token.move", tokenId: pick, x: Math.floor(random() * 1400), y: Math.floor(random() * 1000) };
      } else if (r < 0.65) {
        cmd = { type: "token.delete", tokenId: pick };
      } else if (r < 0.75) {
        cmd = { type: "token.update", tokenId: pick, patch: { hidden: random() < 0.5, rotation: Math.floor(random() * 360) } };
      } else if (r < 0.8) {
        cmd = { type: "scene.setGrid", sceneId: random() < 0.5 ? MAIN : PREP, grid: { cellSize: 50 + Math.floor(random() * 50) } };
      } else if (r < 0.85) {
        cmd = { type: "scene.activate", sceneId: random() < 0.5 ? MAIN : PREP };
      }
      if (cmd) await run({ type: "command", command: cmd });
      else if (r < 0.95) await run({ type: "undo" });
      else await run({ type: "redo" });
    }
    // Eliminazione di una scena e annullamento: i token tornano (in cima).
    await run({ type: "command", command: { type: "scene.delete", sceneId: PREP } });
    await run({ type: "undo" });

    const memory = hub.stateOf(campaignId)!;
    const saved = await loadCampaign(ctx.app.database.db, campaignId);
    expect(saved?.state).toEqual(memory.state);
    expect(saved?.epoch).toBe(memory.log.epoch);
    expect(saved?.log.map((e) => e.version)).toEqual(memory.log.entries.map((e) => e.version));
    expect(saved?.log).toEqual(memory.log.entries);
    expect(memory.state.version).toBeGreaterThan(100);
  });
});
