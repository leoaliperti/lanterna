import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { UserRole } from "@lanterna/shared";
import type { Auth, AuthSession } from "./auth.js";

declare module "fastify" {
  interface FastifyInstance {
    auth: Auth;
  }
  interface FastifyRequest {
    /** Sessione valida, impostata da `requireSession` / `requireRole`. */
    session: AuthSession | null;
  }
}

export function toHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  return headers;
}

/** Ricava la sessione dagli header (cookie). `null` se assente, scaduta o revocata. */
export async function getSessionFromHeaders(
  auth: Auth,
  headers: IncomingHttpHeaders,
): Promise<AuthSession | null> {
  const result = await auth.api.getSession({ headers: toHeaders(headers) });
  if (!result) return null;
  const { user, session } = result;
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role as UserRole },
    session: { id: session.id, userId: session.userId, expiresAt: session.expiresAt },
  };
}

/**
 * Sessione di una richiesta HTTP di upgrade (WebSocket, M2).
 * Chi la usa deve controllare anche l'Origin con `isAllowedOrigin` per evitare il cross-site WebSocket hijacking.
 */
export function getSessionFromUpgradeRequest(
  auth: Auth,
  req: IncomingMessage,
): Promise<AuthSession | null> {
  return getSessionFromHeaders(auth, req.headers);
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ error: "Non autenticato" });
}

/**
 * Hook Fastify riusabile (da usare come `onRequest`, così il controllo avviene prima di leggere il corpo).
 */
export type AuthHook = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;

/** Richiede una sessione valida (401 altrimenti) e la mette in `request.session`. */
export const requireSession: AuthHook = async function (
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const session = await getSessionFromHeaders(request.server.auth, request.headers);
  if (!session) return unauthorized(reply);
  request.session = session;
};

/** Richiede una sessione (401) con uno dei ruoli indicati (403). */
export function requireRole(...roles: UserRole[]): AuthHook {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    const session = await getSessionFromHeaders(request.server.auth, request.headers);
    if (!session) return unauthorized(reply);
    if (!roles.includes(session.user.role)) {
      return reply.code(403).send({ error: "Permesso negato" });
    }
    request.session = session;
  };
}
