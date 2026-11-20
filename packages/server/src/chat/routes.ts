import type { FastifyInstance } from "fastify";
import type { ChatLogEntry, SessionLogExport } from "@lanterna/shared";
import { requireSession } from "../auth/session.js";
import { campaignExists, loadMembers } from "../campaigns/store.js";
import type { Hub } from "../realtime/hub.js";
import { loadAll } from "./store.js";

const id = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" } as const;

/** Una voce in testo semplice. Le righe successive alla prima sono rientrate: nessuno può fingere una voce. */
export function formatEntry(entry: ChatLogEntry, names: ReadonlyMap<string, string>): string {
  const time = new Date(entry.at).toISOString();
  const to = entry.whisperTo ? (names.get(entry.whisperTo) ?? entry.whisperTo) : null;
  const scope = entry.visibility === "gm" ? " (solo GM)" : to ? ` (sussurro a ${to})` : "";
  const body =
    entry.kind === "message"
      ? `${entry.authorName}${scope}: ${entry.text}`
      : `${entry.authorName}${scope} tira${entry.label ? ` «${entry.label}»` : ""}: ${entry.detail}` +
        (entry.critical ? " CRITICO" : entry.criticalFailure ? " FALLIMENTO CRITICO" : "");
  return `[${time}] ${body.replace(/\n/g, "\n    ")}`;
}

/**
 * Esportazione del log di sessione. Admin: log completo. Giocatore: deve essere membro della
 * campagna (altrimenti 404, come per una campagna inesistente) e riceve solo ciò che poteva vedere.
 */
export async function chatRoutes(app: FastifyInstance, hub: Hub) {
  const db = app.database.db;

  app.get<{ Params: { id: string }; Querystring: { format?: "json" | "text"; since?: number } }>(
    "/campaigns/:id/log",
    {
      onRequest: requireSession,
      schema: {
        params: { type: "object", required: ["id"], properties: { id } },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            format: { type: "string", enum: ["json", "text"] },
            since: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const user = request.session!.user;
      const campaignId = request.params.id;
      const isAdmin = user.role === "admin";
      const member = hub.stateOf(campaignId)?.state.members.find((m) => m.userId === user.id);
      if (isAdmin ? !(await campaignExists(db, campaignId)) : !member) {
        return reply.code(404).send({ error: "Campagna inesistente" });
      }
      const viewer = isAdmin ? null : { userId: user.id, role: member!.role };
      const entries = await loadAll(db, campaignId, viewer, request.query.since);
      reply.header("Cache-Control", "no-store");
      if (request.query.format === "text") {
        const names = new Map((await loadMembers(db, campaignId)).map((m) => [m.userId, m.displayName]));
        return reply
          .type("text/plain; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="lanterna-log-${campaignId}.txt"`)
          .send(entries.map((e) => formatEntry(e, names)).join("\n") + (entries.length > 0 ? "\n" : ""));
      }
      const body: SessionLogExport = {
        campaignId,
        exportedAt: new Date().toISOString(),
        scope: isAdmin ? "full" : "visible",
        entries,
      };
      return body;
    },
  );
}
