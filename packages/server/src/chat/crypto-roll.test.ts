import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@lanterna/shared";
import { createTestApp, type TestContext } from "../test/helpers.js";
import { createTable, hello } from "../test/campaign.js";
import { WsClient, listen } from "../test/ws.js";

// Conta le chiamate a `crypto.randomInt` fatte dal server (il modulo vero resta in uso).
const calls = vi.hoisted(() => ({ randomInt: [] as number[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomInt: (max: number) => {
      calls.randomInt.push(max);
      return actual.randomInt(max);
    },
  };
});

let ctx: TestContext;
let client: WsClient | undefined;

afterEach(async () => {
  client?.ws.terminate();
  await ctx?.close();
});

describe("app di produzione: tiri con crypto.randomInt", () => {
  it("ogni dado di un roll.request passa da crypto.randomInt", async () => {
    ctx = await createTestApp(); // nessun RNG iniettato: come main.ts
    const port = await listen(ctx);
    const t = await createTable(ctx);
    client = await WsClient.connect(port, { cookie: t.p1.cookie });
    await hello(client, t.campaignId);
    calls.randomInt.length = 0;
    const requestId = randomUUID();
    client.send({ type: "roll.request", requestId, formula: "3d6 + 1d20", visibility: "public" });
    const r = await client.next<Extract<ServerMessage, { type: "roll.result" }>>(
      (m) => m.type === "roll.result" && m.requestId === requestId,
    );
    expect(calls.randomInt).toEqual([6, 6, 6, 20]);
    expect(r.entry.total).toBeGreaterThanOrEqual(4);
    expect(r.entry.total).toBeLessThanOrEqual(38);
  });
});
