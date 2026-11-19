import Fastify, { type FastifyInstance } from "fastify";
import type { HealthResponse } from "@lanterna/shared";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async (): Promise<HealthResponse> => ({ status: "ok" }));

  return app;
}
