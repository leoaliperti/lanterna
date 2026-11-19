import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, type TestContext } from "./test/helpers.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

describe("GET /health", () => {
  it("risponde 200 con status ok", async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
