import type { FastifyInstance } from "fastify";
import type {
  AddMemberRequest,
  CampaignSummary,
  CreateCampaignRequest,
  ListCampaignsResponse,
  ListMembersResponse,
} from "@lanterna/shared";
import { requireRole, requireSession } from "../auth/session.js";
import type { Hub } from "../realtime/hub.js";
import {
  addMember,
  campaignExists,
  createCampaign,
  listCampaigns,
  listCampaignsOf,
  loadMembers,
  removeMember,
} from "./store.js";

const id = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" } as const;
const campaignParams = { type: "object", required: ["id"], properties: { id } } as const;

/**
 * Campagne e membri. Creazione, elenco completo e gestione dei membri: solo admin (verificato
 * lato server con `requireRole`). `GET /campaigns/mine`: qualsiasi utente autenticato.
 */
export async function campaignRoutes(app: FastifyInstance, hub: Hub) {
  const onlyAdmin = requireRole("admin");
  const db = app.database.db;

  app.get("/campaigns", { onRequest: onlyAdmin }, async (): Promise<ListCampaignsResponse> => ({
    campaigns: await listCampaigns(db),
  }));

  app.get("/campaigns/mine", { onRequest: requireSession }, async (request): Promise<ListCampaignsResponse> => ({
    campaigns: await listCampaignsOf(db, request.session!.user.id),
  }));

  app.post<{ Body: CreateCampaignRequest }>(
    "/campaigns",
    {
      onRequest: onlyAdmin,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 64, pattern: "\\S" } },
        },
      },
    },
    async (request, reply) => {
      const created: CampaignSummary = await createCampaign(db, request.body.name.trim(), request.session!.user.id);
      await hub.loadRoom(created.id);
      return reply.code(201).send(created);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/campaigns/:id/members",
    { onRequest: onlyAdmin, schema: { params: campaignParams } },
    async (request, reply): Promise<ListMembersResponse | void> => {
      if (!(await campaignExists(db, request.params.id))) return reply.code(404).send({ error: "Campagna inesistente" });
      return { members: await loadMembers(db, request.params.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: AddMemberRequest }>(
    "/campaigns/:id/members",
    {
      onRequest: onlyAdmin,
      schema: {
        params: campaignParams,
        body: { type: "object", additionalProperties: false, required: ["userId"], properties: { userId: id } },
      },
    },
    async (request, reply) => {
      const campaignId = request.params.id;
      if (!(await campaignExists(db, campaignId))) return reply.code(404).send({ error: "Campagna inesistente" });
      if (!(await app.users.findById(request.body.userId))) return reply.code(404).send({ error: "Utente inesistente" });
      if (!(await addMember(db, campaignId, request.body.userId))) {
        return reply.code(409).send({ error: "Già membro" });
      }
      await hub.refreshMembers(campaignId);
      return reply.code(201).send({ members: await loadMembers(db, campaignId) });
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    "/campaigns/:id/members/:userId",
    {
      onRequest: onlyAdmin,
      schema: { params: { type: "object", required: ["id", "userId"], properties: { id, userId: id } } },
    },
    async (request, reply) => {
      const { id: campaignId, userId } = request.params;
      const result = await removeMember(db, campaignId, userId);
      if (result === "not_found") return reply.code(404).send({ error: "Membro inesistente" });
      if (result === "last_admin") return reply.code(409).send({ error: "Deve restare almeno un GM" });
      await hub.refreshMembers(campaignId);
      return reply.code(204).send();
    },
  );
}
