import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth/session.js";
import { campaignExists } from "../campaigns/store.js";
import type { Db } from "../db/client.js";
import { GAME_LOG_PAGE, listGameLog } from "./store.js";

const id = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" } as const;

/**
 * Registro di gioco: solo il GM (admin). Un giocatore riceve 403, un anonimo 401; una campagna inesistente 404.
 * Pagine dalla più recente: `?before=<versione>` per quella precedente.
 */
export async function gameLogRoutes(app: FastifyInstance, db: Db) {
  const onlyGm = requireRole("admin");

  app.get<{ Params: { id: string }; Querystring: { before?: number; limit?: number } }>(
    "/campaigns/:id/game-log",
    {
      onRequest: onlyGm,
      schema: {
        params: { type: "object", required: ["id"], properties: { id } },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            before: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: GAME_LOG_PAGE },
          },
        },
      },
    },
    async (request, reply) => {
      const campaignId = request.params.id;
      if (!(await campaignExists(db, campaignId))) return reply.code(404).send({ error: "Campagna inesistente" });
      const entries = await listGameLog(db, campaignId, request.query.before ?? null, request.query.limit ?? GAME_LOG_PAGE);
      reply.header("Cache-Control", "no-store");
      return { entries };
    },
  );
}
