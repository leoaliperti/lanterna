import type { FastifyInstance, FastifyReply } from "fastify";
import {
  deriveDoc,
  sheetDocSchema,
  type CreateSheetRequest,
  type ListSheetsResponse,
  type SheetDoc,
  type SheetRecord,
  type UpdateSheetRequest,
} from "@lanterna/shared";
import { requireSession } from "../auth/session.js";
import { campaignExists, loadMembers } from "../campaigns/store.js";
import type { Hub } from "../realtime/hub.js";
import {
  canView,
  countOwned,
  deleteSheet,
  getRow,
  insertSheet,
  isMember,
  listSheets,
  recordOf,
  tokenLinkedTo,
  updateSheet,
  type Viewer,
} from "./store.js";

const id = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" } as const;
const nullableId = { anyOf: [id, { type: "null" }] } as const;
const campaignParams = { type: "object", required: ["id"], properties: { id } } as const;
const sheetParams = { type: "object", required: ["id", "sheetId"], properties: { id, sheetId: id } } as const;

/** Schede per giocatore (compresa quella creata da sé) in una campagna: tetto contro gli abusi. */
export const MAX_SHEETS_PER_PLAYER = 20;

/** Una scheda sta in un corpo più grande del limite di 64 KiB delle altre rotte (inventari, incantesimi, note). */
const SHEET_BODY_LIMIT = 512 * 1024;
const writeLimit = { rateLimit: { max: 120, timeWindow: 60_000 } };

type Parsed = { ok: true; doc: SheetDoc } | { ok: false; issues: { path: string; message: string }[] };

/** Valida il documento con lo schema condiviso e verifica che il motore lo sappia derivare. */
function parseDoc(input: unknown): Parsed {
  const r = sheetDocSchema.safeParse(input);
  if (!r.success) {
    return { ok: false, issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  try {
    deriveDoc(r.data);
  } catch (err) {
    return { ok: false, issues: [{ path: "", message: err instanceof Error ? err.message : "Scheda non calcolabile" }] };
  }
  return { ok: true, doc: r.data };
}

/**
 * Schede personaggio e statblock (M8), sotto `/campaigns/:id/sheets`.
 *
 * Permessi (sempre lato server):
 * - GM (admin): legge e scrive tutto; crea `pc` e `monster`; assegna proprietario e token; elimina.
 * - Giocatore membro: vede e modifica SOLO le proprie schede `pc` (`ownerUserId` = lui). Può crearne di proprie
 *   (sempre `pc`, proprietario forzato a sé, max `MAX_SHEETS_PER_PLAYER`). Non cambia proprietario né legame con
 *   il token (403), non elimina (403). Statblock dei mostri e schede altrui rispondono 404, come se non esistessero:
 *   nemmeno l'esistenza è rivelata. Non membro: 404 sulla campagna.
 * - Il legame con il token non viene mai inviato ai giocatori (il token potrebbe essere nascosto).
 */
export async function sheetRoutes(app: FastifyInstance, hub: Hub) {
  const db = app.database.db;

  /** Chi è e se può entrare nella campagna; altrimenti risponde 404 (campagna inesistente). */
  async function enter(request: { session: { user: { id: string; role: string } } | null }, reply: FastifyReply, campaignId: string): Promise<Viewer | null> {
    const user = request.session!.user;
    const isGm = user.role === "admin";
    const ok = isGm ? await campaignExists(db, campaignId) : await isMember(db, campaignId, user.id);
    if (!ok) {
      void reply.code(404).send({ error: "Campagna inesistente" });
      return null;
    }
    return { userId: user.id, isGm };
  }

  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "Scheda inesistente" });
  const forbidden = (reply: FastifyReply, message: string) => reply.code(403).send({ error: message, code: "FORBIDDEN" });
  const invalid = (reply: FastifyReply, issues: { path: string; message: string }[]) =>
    reply.code(400).send({ error: "Scheda non valida", code: "INVALID", issues });

  /** Proprietario ammesso: membro della campagna con ruolo giocatore. */
  async function ownerOk(campaignId: string, userId: string): Promise<boolean> {
    const members = await loadMembers(db, campaignId);
    return members.some((m) => m.userId === userId && m.role === "player");
  }

  /** Il token deve esistere nella campagna e non essere già legato a un'altra scheda. */
  async function tokenProblem(campaignId: string, tokenId: string, exceptSheetId?: string): Promise<string | null> {
    if (!hub.stateOf(campaignId)?.state.tokens.some((t) => t.id === tokenId)) return "Token inesistente";
    const other = await tokenLinkedTo(db, campaignId, tokenId);
    if (other && other !== exceptSheetId) return "Il token è già collegato a un'altra scheda";
    return null;
  }

  app.get<{ Params: { id: string } }>(
    "/campaigns/:id/sheets",
    { onRequest: requireSession, schema: { params: campaignParams } },
    async (request, reply): Promise<ListSheetsResponse | void> => {
      const viewer = await enter(request, reply, request.params.id);
      if (!viewer) return;
      reply.header("Cache-Control", "no-store");
      return { sheets: await listSheets(db, request.params.id, viewer) };
    },
  );

  app.get<{ Params: { id: string; sheetId: string } }>(
    "/campaigns/:id/sheets/:sheetId",
    { onRequest: requireSession, schema: { params: sheetParams } },
    async (request, reply): Promise<SheetRecord | void> => {
      const viewer = await enter(request, reply, request.params.id);
      if (!viewer) return;
      const row = await getRow(db, request.params.id, request.params.sheetId);
      if (!row || !canView(row, viewer)) return notFound(reply);
      reply.header("Cache-Control", "no-store");
      return recordOf(row, viewer);
    },
  );

  app.post<{ Params: { id: string }; Body: CreateSheetRequest }>(
    "/campaigns/:id/sheets",
    {
      onRequest: requireSession,
      bodyLimit: SHEET_BODY_LIMIT,
      config: writeLimit,
      schema: {
        params: campaignParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "doc"],
          properties: { kind: { type: "string", enum: ["pc", "monster"] }, doc: { type: "object" }, ownerUserId: nullableId, tokenId: nullableId },
        },
      },
    },
    async (request, reply) => {
      const campaignId = request.params.id;
      const viewer = await enter(request, reply, campaignId);
      if (!viewer) return;
      const body = request.body;
      if (!viewer.isGm) {
        if (body.kind !== "pc") return forbidden(reply, "Solo il GM crea statblock di mostri");
        if (body.ownerUserId !== undefined && body.ownerUserId !== viewer.userId) {
          return forbidden(reply, "Una scheda si crea solo a proprio nome");
        }
        if (body.tokenId !== undefined) return forbidden(reply, "Solo il GM collega una scheda a un token");
        if ((await countOwned(db, campaignId, viewer.userId)) >= MAX_SHEETS_PER_PLAYER) {
          return reply.code(409).send({ error: "Hai raggiunto il numero massimo di schede", code: "CONFLICT" });
        }
      }
      const parsed = parseDoc(body.doc);
      if (!parsed.ok) return invalid(reply, parsed.issues);

      const ownerUserId = viewer.isGm ? (body.ownerUserId ?? null) : viewer.userId;
      if (body.kind === "monster" && ownerUserId) return invalid(reply, [{ path: "ownerUserId", message: "Un mostro non ha un proprietario" }]);
      if (ownerUserId && viewer.isGm && !(await ownerOk(campaignId, ownerUserId))) {
        return invalid(reply, [{ path: "ownerUserId", message: "Il proprietario deve essere un giocatore della campagna" }]);
      }
      const tokenId = viewer.isGm ? (body.tokenId ?? null) : null;
      if (tokenId) {
        const problem = await tokenProblem(campaignId, tokenId);
        if (problem) return invalid(reply, [{ path: "tokenId", message: problem }]);
      }
      const row = await insertSheet(db, { campaignId, kind: body.kind, doc: parsed.doc, ownerUserId, tokenId });
      return reply.code(201).send(recordOf(row, viewer));
    },
  );

  app.put<{ Params: { id: string; sheetId: string }; Body: UpdateSheetRequest }>(
    "/campaigns/:id/sheets/:sheetId",
    {
      onRequest: requireSession,
      bodyLimit: SHEET_BODY_LIMIT,
      config: writeLimit,
      schema: {
        params: sheetParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["version"],
          properties: { version: { type: "integer", minimum: 1 }, doc: { type: "object" }, ownerUserId: nullableId, tokenId: nullableId },
        },
      },
    },
    async (request, reply) => {
      const campaignId = request.params.id;
      const viewer = await enter(request, reply, campaignId);
      if (!viewer) return;
      const row = await getRow(db, campaignId, request.params.sheetId);
      if (!row || !canView(row, viewer)) return notFound(reply);
      const body = request.body;
      if (!viewer.isGm && (body.ownerUserId !== undefined || body.tokenId !== undefined)) {
        return forbidden(reply, "Solo il GM cambia proprietario e collegamento al token");
      }
      let doc: SheetDoc | undefined;
      if (body.doc !== undefined) {
        const parsed = parseDoc(body.doc);
        if (!parsed.ok) return invalid(reply, parsed.issues);
        doc = parsed.doc;
      }
      if (body.ownerUserId) {
        if (row.kind === "monster") return invalid(reply, [{ path: "ownerUserId", message: "Un mostro non ha un proprietario" }]);
        if (!(await ownerOk(campaignId, body.ownerUserId))) {
          return invalid(reply, [{ path: "ownerUserId", message: "Il proprietario deve essere un giocatore della campagna" }]);
        }
      }
      if (body.tokenId) {
        const problem = await tokenProblem(campaignId, body.tokenId, row.id);
        if (problem) return invalid(reply, [{ path: "tokenId", message: problem }]);
      }
      const saved = await updateSheet(db, campaignId, row.id, body.version, {
        ...(doc ? { doc } : {}),
        ...(body.ownerUserId !== undefined ? { ownerUserId: body.ownerUserId } : {}),
        ...(body.tokenId !== undefined ? { tokenId: body.tokenId } : {}),
      });
      if (!saved) {
        const current = await getRow(db, campaignId, row.id);
        return reply.code(409).send({
          error: "La scheda è stata modificata nel frattempo",
          code: "CONFLICT",
          currentVersion: current?.version ?? null,
        });
      }
      return recordOf(saved, viewer);
    },
  );

  app.delete<{ Params: { id: string; sheetId: string } }>(
    "/campaigns/:id/sheets/:sheetId",
    { onRequest: requireSession, config: writeLimit, schema: { params: sheetParams } },
    async (request, reply) => {
      const campaignId = request.params.id;
      const viewer = await enter(request, reply, campaignId);
      if (!viewer) return;
      const row = await getRow(db, campaignId, request.params.sheetId);
      if (!row || !canView(row, viewer)) return notFound(reply);
      if (!viewer.isGm) return forbidden(reply, "Solo il GM elimina le schede");
      await deleteSheet(db, campaignId, row.id);
      return reply.code(204).send();
    },
  );
}
