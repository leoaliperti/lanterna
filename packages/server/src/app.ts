import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { HealthResponse, RandomInt } from "@lanterna/shared";
import { createAuth } from "./auth/auth.js";
import { authRoutes } from "./auth/routes.js";
import "./auth/session.js";
import { loadConfig, type AppConfig } from "./config.js";
import { openDatabase, type Database } from "./db/client.js";
import { originGuard } from "./security.js";
import { campaignRoutes } from "./campaigns/routes.js";
import { chatRoutes } from "./chat/routes.js";
import { randomInt as cryptoRandomInt } from "./dice/crypto-rng.js";
import { Hub, CLOSE } from "./realtime/hub.js";
import { attachRealtime } from "./realtime/server.js";
import { uploadRoutes } from "./media/routes.js";
import { adminRoutes } from "./users/routes.js";
import { createUserService, type UserService } from "./users/service.js";

declare module "fastify" {
  interface FastifyInstance {
    database: Database;
    users: UserService;
    realtime: Hub;
  }
}

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
  /**
   * Generatore dei tiri, solo per i test. In produzione si usa sempre `crypto.randomInt`
   * (`dice/crypto-rng.ts`): `main.ts` non lo passa mai.
   */
  rng?: RandomInt;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: options.logger ?? process.env.NODE_ENV !== "test",
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    // Campi sconosciuti nel corpo: errore 400 invece di essere scartati in silenzio.
    ajv: { customOptions: { removeAdditional: false } },
  });

  const database = await openDatabase(config.databaseUrl);
  const auth = createAuth(config, database.db);
  const users = createUserService(database.db, auth);
  app.decorate("database", database);
  app.decorate("auth", auth);
  app.decorate("users", users);
  // Stanze delle campagne: lo stato salvato si ricarica prima di accettare connessioni.
  const hub = new Hub(database.db, app.log, { rng: options.rng ?? cryptoRandomInt, chat: config.chat });
  await hub.loadAll();
  app.decorate("realtime", hub);
  app.decorateRequest("session", null);
  app.addHook("onClose", async () => database.close());

  // Header di sicurezza di base. È un'API JSON: CSP restrittiva.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(rateLimit, { global: false });

  const allowedOrigins = new Set([config.baseURL, ...config.trustedOrigins]);
  app.addHook("onRequest", originGuard(allowedOrigins));

  app.get("/health", async (): Promise<HealthResponse> => ({ status: "ok" }));
  await authRoutes(app, config);
  await adminRoutes(app, config, users, {
    userChanged: (id) => hub.userChanged(id),
    sessionsRevoked: (id) => hub.closeUser(id, CLOSE.sessionEnded, "sessione terminata"),
  });
  await campaignRoutes(app, hub);
  await chatRoutes(app, hub);
  await uploadRoutes(app, config);
  attachRealtime(app, hub, config, allowedOrigins);

  return app;
}
