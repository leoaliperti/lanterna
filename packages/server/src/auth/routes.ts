import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { AUTH_BASE_PATH, CLIENT_IP_HEADER } from "./auth.js";
import { toHeaders } from "./session.js";

/**
 * Rotte di Better Auth esposte via HTTP. Tutto il resto (in particolare `sign-up`) non è registrato
 * e risponde 404: le rotte sono un elenco chiuso, non un passa-tutto `/auth/*`.
 */
export async function authRoutes(app: FastifyInstance, config: AppConfig) {
  const loginLimit = {
    rateLimit: { max: config.rateLimit.login.max, timeWindow: config.rateLimit.login.timeWindowMs },
  };

  async function forward(request: FastifyRequest, reply: FastifyReply) {
    const headers = toHeaders(request.headers);
    // L'IP lo decide Fastify (trustProxy), non un header arbitrario del client.
    headers.set(CLIENT_IP_HEADER, request.ip);
    headers.delete("content-length");
    let body: string | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = JSON.stringify(request.body ?? {});
      headers.set("content-type", "application/json");
    }
    // URL costruito dal baseURL configurato, non dall'header Host.
    const url = new URL(request.url, app.auth.options.baseURL as string);
    const response = await app.auth.handler(new Request(url, { method: request.method, headers, body }));

    reply.code(response.status);
    for (const [key, value] of response.headers) {
      if (key === "set-cookie" || key === "content-length") continue;
      reply.header(key, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) reply.header("set-cookie", cookies);
    const text = await response.text();
    return reply.send(text.length > 0 ? text : undefined);
  }

  app.post(`${AUTH_BASE_PATH}/sign-in/email`, { config: loginLimit }, forward);
  app.post(`${AUTH_BASE_PATH}/change-password`, { config: loginLimit }, forward);
  app.post(`${AUTH_BASE_PATH}/sign-out`, forward);
  app.get(`${AUTH_BASE_PATH}/get-session`, forward);
}
