import type { FastifyInstance, FastifyReply } from "fastify";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USER_ROLES,
  type CreateUserRequest,
  type ListUsersResponse,
  type PublicUser,
  type ResetPasswordRequest,
  type UpdateUserRoleRequest,
} from "@lanterna/shared";
import { requireRole } from "../auth/session.js";
import type { AppConfig } from "../config.js";
import { UserServiceError, type UserService } from "./service.js";

const STATUS: Record<UserServiceError["code"], number> = {
  invalid_password: 400,
  email_taken: 409,
  not_found: 404,
  last_admin: 409,
};

function sendServiceError(reply: FastifyReply, err: unknown) {
  if (err instanceof UserServiceError) {
    return reply.code(STATUS[err.code]).send({ error: err.message });
  }
  throw err;
}

const password = { type: "string", minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH };
const role = { type: "string", enum: [...USER_ROLES] };
const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

/** Notifiche verso il tempo reale: chiudere le connessioni WebSocket di un utente cambiato. */
export interface UserEvents {
  /** Ruolo cambiato o utente eliminato. */
  userChanged(userId: string): Promise<void>;
  /** Sessioni revocate (reset password). */
  sessionsRevoked(userId: string): void;
}

/** Gestione account: solo admin. Il ruolo è verificato lato server su ogni rotta. */
export async function adminRoutes(
  app: FastifyInstance,
  config: AppConfig,
  users: UserService,
  events: UserEvents,
) {
  const onlyAdmin = requireRole("admin");

  app.get("/admin/users", { onRequest: onlyAdmin }, async (): Promise<ListUsersResponse> => ({
    users: await users.list(),
  }));

  app.post<{ Body: CreateUserRequest }>(
    "/admin/users",
    {
      onRequest: onlyAdmin,
      config: {
        rateLimit: {
          max: config.rateLimit.createUser.max,
          timeWindow: config.rateLimit.createUser.timeWindowMs,
        },
      },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "name", "password", "role"],
          properties: {
            email: { type: "string", format: "email", maxLength: 254 },
            name: { type: "string", minLength: 1, maxLength: 64 },
            password,
            role,
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const created: PublicUser = await users.create(request.body);
        return reply.code(201).send(created);
      } catch (err) {
        return sendServiceError(reply, err);
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateUserRoleRequest }>(
    "/admin/users/:id",
    {
      onRequest: onlyAdmin,
      schema: {
        params: idParams,
        body: { type: "object", additionalProperties: false, required: ["role"], properties: { role } },
      },
    },
    async (request, reply) => {
      try {
        const updated = await users.setRole(request.params.id, request.body.role);
        await events.userChanged(request.params.id);
        return updated;
      } catch (err) {
        return sendServiceError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/users/:id",
    { onRequest: onlyAdmin, schema: { params: idParams } },
    async (request, reply) => {
      try {
        await users.remove(request.params.id);
        await events.userChanged(request.params.id);
        return reply.code(204).send();
      } catch (err) {
        return sendServiceError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: ResetPasswordRequest }>(
    "/admin/users/:id/password",
    {
      onRequest: onlyAdmin,
      schema: {
        params: idParams,
        body: { type: "object", additionalProperties: false, required: ["password"], properties: { password } },
      },
    },
    async (request, reply) => {
      try {
        await users.resetPassword(request.params.id, request.body.password);
        events.sessionsRevoked(request.params.id);
        return reply.code(204).send();
      } catch (err) {
        return sendServiceError(reply, err);
      }
    },
  );
}
