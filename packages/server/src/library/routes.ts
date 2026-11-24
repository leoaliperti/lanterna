import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CreateLibraryItemSchema,
  LIBRARY_LIMITS,
  UpdateLibraryItemSchema,
  TokenKindSchema,
  type LibraryItem,
  type ListLibraryResponse,
  type TokenKind,
} from "@lanterna/shared";
import { requireRole, requireSession } from "../auth/session.js";
import { campaignExists } from "../campaigns/store.js";
import type { AppConfig } from "../config.js";
import { asset, content } from "../db/schema.js";
import { parseAssetUrl } from "../media/assetUrl.js";
import { isMember } from "../sheets/store.js";
import { countInScope, deleteItem, getItem, insertItem, listLibrary, toPublic, updateItem } from "./store.js";

const id = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" } as const;
const itemParams = { type: "object", required: ["id"], properties: { id } } as const;
const writeLimit = { rateLimit: { max: 120, timeWindow: 60_000 } };

function invalid(reply: FastifyReply, issues: { path: PropertyKey[]; message: string }[]) {
  return reply.code(400).send({
    error: "Dati non validi",
    issues: issues.slice(0, 10).map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  });
}

/**
 * Libreria di token e oggetti riutilizzabili (M10).
 *
 * - Creare, modificare, eliminare: solo admin (`requireRole`, prima di leggere il corpo).
 * - Leggere: l'admin tutto; il giocatore solo gli elementi dei tipi di `LIBRARY_PLAYER_KINDS` (default
 *   nessuno) della propria campagna o globali, SENZA statistiche. Campagna non propria = 404.
 * - Un elemento non è un token: per metterlo in scena il client usa `token.create`.
 */
export async function libraryRoutes(app: FastifyInstance, config: AppConfig) {
  const db = app.database.db;
  const onlyAdmin = requireRole("admin");
  const playerKinds = config.libraryPlayerKinds.filter((k): k is TokenKind => TokenKindSchema.safeParse(k).success);

  /** `null` se l'immagine è accettabile, altrimenti il motivo. Un file caricato deve esistere. */
  /** La scheda collegata a un elemento è un mostro importato (documento di `content`). */
  async function checkContent(id: string | null | undefined): Promise<string | null> {
    if (!id) return null;
    const row = await db.query.content.findFirst({ where: eq(content.id, id), columns: { id: true, kind: true } });
    if (!row) return "scheda inesistente";
    return row.kind === "monster" ? null : "la scheda collegata deve essere un mostro";
  }

  async function checkImage(url: string | null): Promise<string | null> {
    if (url === null) return null;
    const parsed = parseAssetUrl(url);
    if (!parsed) return url.startsWith("/assets/") ? "immagine non valida" : null;
    const row = await db.query.asset.findFirst({ where: eq(asset.id, parsed.id), columns: { id: true, ext: true } });
    return row && row.ext === parsed.ext ? null : "immagine inesistente";
  }

  app.get<{ Querystring: { campaignId?: string; kind?: string; q?: string; limit?: number; offset?: number } }>(
    "/library",
    {
      onRequest: requireSession,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            campaignId: id,
            kind: { type: "string", enum: ["pc", "monster", "object"] },
            q: { type: "string", maxLength: LIBRARY_LIMITS.maxQueryLength },
            limit: { type: "integer", minimum: 1, maximum: LIBRARY_LIMITS.maxPageSize, default: 50 },
            offset: { type: "integer", minimum: 0, maximum: 100_000, default: 0 },
          },
        },
      },
    },
    async (request, reply): Promise<ListLibraryResponse | void> => {
      const user = request.session!.user;
      const isAdmin = user.role === "admin";
      const { campaignId, kind, q, limit = 50, offset = 0 } = request.query;
      if (isAdmin) {
        if (campaignId && !(await campaignExists(db, campaignId))) return reply.code(404).send({ error: "Campagna inesistente" });
      } else {
        // Il giocatore deve indicare una campagna di cui è membro; altrimenti la stessa risposta di "inesistente".
        if (!campaignId || !(await isMember(db, campaignId, user.id))) return reply.code(404).send({ error: "Campagna inesistente" });
      }
      const page = await listLibrary(db, { userId: user.id, isAdmin }, playerKinds, {
        campaignId,
        kind: kind as TokenKind | undefined,
        q: q?.trim() || undefined,
        limit,
        offset,
      });
      return { items: isAdmin ? page.items : page.items.map(toPublic), total: page.total };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/library/:id",
    { onRequest: requireSession, schema: { params: itemParams } },
    async (request, reply) => {
      const user = request.session!.user;
      const item = await getItem(db, request.params.id);
      if (!item) return reply.code(404).send({ error: "Elemento inesistente" });
      if (user.role === "admin") return item;
      // Giocatore: stesse regole dell'elenco; ogni rifiuto è lo stesso 404.
      const allowed =
        playerKinds.includes(item.kind) && (item.campaignId === null || (await isMember(db, item.campaignId, user.id)));
      if (!allowed) return reply.code(404).send({ error: "Elemento inesistente" });
      return toPublic(item);
    },
  );

  app.post(
    "/library",
    { onRequest: onlyAdmin, config: writeLimit },
    async (request, reply) => {
      const parsed = CreateLibraryItemSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      const input = parsed.data;
      if (input.scope === "campaign" && !(await campaignExists(db, input.campaignId!))) {
        return reply.code(404).send({ error: "Campagna inesistente" });
      }
      const bad = (await checkImage(input.imageUrl)) ?? (await checkContent(input.contentId));
      if (bad) return reply.code(400).send({ error: `Dati non validi: ${bad}` });
      if ((await countInScope(db, input.scope === "campaign" ? input.campaignId! : null)) >= LIBRARY_LIMITS.maxItemsPerScope) {
        return reply.code(409).send({ error: "Libreria piena" });
      }
      const item: LibraryItem = await insertItem(db, input);
      return reply.code(201).send(item);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/library/:id",
    { onRequest: onlyAdmin, config: writeLimit, schema: { params: itemParams } },
    async (request, reply) => {
      const parsed = UpdateLibraryItemSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      if (parsed.data.imageUrl !== undefined) {
        const bad = await checkImage(parsed.data.imageUrl);
        if (bad) return reply.code(400).send({ error: `Dati non validi: ${bad}` });
      }
      if (parsed.data.contentId) {
        const bad = await checkContent(parsed.data.contentId);
        if (bad) return reply.code(400).send({ error: `Dati non validi: ${bad}` });
      }
      const item = await updateItem(db, request.params.id, parsed.data);
      if (!item) return reply.code(404).send({ error: "Elemento inesistente" });
      return item;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/library/:id",
    { onRequest: onlyAdmin, config: writeLimit, schema: { params: itemParams } },
    async (request, reply) => {
      if (!(await deleteItem(db, request.params.id))) return reply.code(404).send({ error: "Elemento inesistente" });
      return reply.code(204).send();
    },
  );
}
