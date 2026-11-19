import type { FastifyReply, FastifyRequest } from "fastify";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Vero se l'header Origin (o, in mancanza, Referer) appartiene a un'origine ammessa. */
export function isAllowedOrigin(
  headers: { origin?: string | undefined; referer?: string | undefined },
  allowed: ReadonlySet<string>,
): boolean {
  const origin = originOf(headers.origin) ?? originOf(headers.referer);
  return origin !== null && allowed.has(origin);
}

/**
 * Protezione CSRF: ogni richiesta che modifica lo stato deve arrivare da un'origine ammessa.
 * Un browser manda sempre Origin sulle POST/PATCH/DELETE; senza Origin né Referer si rifiuta.
 */
export function originGuard(allowed: ReadonlySet<string>) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (SAFE_METHODS.has(request.method)) return;
    if (!isAllowedOrigin(request.headers, allowed)) {
      return reply.code(403).send({ error: "Origine non ammessa" });
    }
  };
}
