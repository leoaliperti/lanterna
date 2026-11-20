import type { FastifyInstance } from "fastify";
import { requireRole, requireSession } from "../auth/session.js";
import type { AppConfig } from "../config.js";
import { CONTENT_KINDS, ContentValidationError, parseContent, type ContentKind } from "./schema.js";
import {
  UnknownCampaignError,
  deleteContent,
  getContent,
  importContent,
  listContent,
  playerKinds,
  type Viewer,
} from "./store.js";

const idParam = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" } as const;

/**
 * Contenuti importati. Importazione e cancellazione: solo admin (`requireRole`, prima di leggere il
 * corpo). Lettura: qualsiasi utente autenticato, ma il giocatore vede solo i tipi consentiti
 * (`CONTENT_PLAYER_KINDS`, default `item,spell`; mostri e note mai) e, per i documenti legati a una
 * campagna, solo se ne è membro. Ciò che non può vedere risponde 404, come se non esistesse.
 */
export async function contentRoutes(app: FastifyInstance, config: AppConfig) {
  const onlyAdmin = requireRole("admin");
  const db = app.database.db;
  const kinds = playerKinds(config.contentPlayerKinds);
  const viewerOf = (request: { session: { user: { id: string; role: string } } | null }): Viewer => ({
    userId: request.session!.user.id,
    isAdmin: request.session!.user.role === "admin",
  });

  app.post(
    "/content/import",
    {
      onRequest: onlyAdmin,
      // Il limite globale (64 KiB) è per le rotte normali; qui serve spazio per i file di contenuti.
      bodyLimit: config.contentMaxBytes,
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      try {
        const parsed = parseContent(request.body);
        return await importContent(db, parsed);
      } catch (err) {
        if (err instanceof ContentValidationError) {
          return reply.code(400).send({ error: err.message, issues: err.issues });
        }
        if (err instanceof UnknownCampaignError) return reply.code(404).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get<{ Querystring: { kind?: ContentKind; q?: string; campaignId?: string; limit?: number; offset?: number } }>(
    "/content",
    {
      onRequest: requireSession,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: [...CONTENT_KINDS] },
            q: { type: "string", minLength: 1, maxLength: 100 },
            campaignId: idParam,
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, maximum: 1_000_000, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const { kind, q, campaignId, limit = 50, offset = 0 } = request.query;
      return listContent(db, viewerOf(request), kinds, {
        ...(kind ? { kind } : {}),
        ...(q ? { q } : {}),
        ...(campaignId ? { campaignId } : {}),
        limit,
        offset,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/content/:id",
    { onRequest: requireSession, schema: { params: { type: "object", required: ["id"], properties: { id: idParam } } } },
    async (request, reply) => {
      const doc = await getContent(db, viewerOf(request), kinds, request.params.id);
      if (!doc) return reply.code(404).send({ error: "Contenuto inesistente" });
      return doc;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/content/:id",
    { onRequest: onlyAdmin, schema: { params: { type: "object", required: ["id"], properties: { id: idParam } } } },
    async (request, reply) => {
      if (!(await deleteContent(db, request.params.id))) return reply.code(404).send({ error: "Contenuto inesistente" });
      return reply.code(204).send();
    },
  );
}
