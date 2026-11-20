import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { PublicUser, UserRole } from "@lanterna/shared";
import { buildApp, type BuildAppOptions } from "../app.js";
import { loadConfig, type AppConfig } from "../config.js";

export const ORIGIN = "http://localhost:3000";
export const PASSWORD = "password-di-prova-123";

export interface TestContext {
  app: FastifyInstance;
  config: AppConfig;
  close(): Promise<void>;
}

/** App completa con un database SQLite temporaneo su file. */
export async function createTestApp(
  env: NodeJS.ProcessEnv = {},
  tweak: (config: AppConfig) => void = () => {},
  /** Riusa un database e una cartella di upload esistenti (test di riavvio): non vengono cancellati. */
  persistent?: { dbPath: string; uploadDir: string },
  /** Opzioni in più per `buildApp` (es. `rng` deterministico per i tiri). */
  appOptions: Pick<BuildAppOptions, "rng"> = {},
): Promise<TestContext> {
  const dbPath = persistent?.dbPath ?? join(tmpdir(), `lanterna-test-${randomUUID()}.db`);
  const uploadDir = persistent?.uploadDir ?? join(tmpdir(), `lanterna-test-uploads-${randomUUID()}`);
  const config = loadConfig({
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "segreto-di-test-lungo-almeno-trentadue-caratteri",
    BETTER_AUTH_URL: ORIGIN,
    TRUSTED_ORIGINS: "http://localhost:5173",
    DATABASE_URL: `file:${dbPath}`,
    UPLOAD_DIR: uploadDir,
    RATE_LIMIT_LOGIN_MAX: "1000",
    RATE_LIMIT_CREATE_USER_MAX: "1000",
    RATE_LIMIT_UPLOAD_MAX: "1000",
    ...env,
  });
  tweak(config);
  const app = await buildApp({ config, logger: false, ...appOptions });
  return {
    app,
    config,
    async close() {
      await app.close();
      if (persistent) return;
      for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
      rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

export async function createUser(
  app: FastifyInstance,
  role: UserRole,
  email = `${role}-${randomUUID()}@example.com`,
): Promise<PublicUser> {
  return app.users.create({ email, name: role, password: PASSWORD, role });
}

/** Cookie `nome=valore` da una risposta, pronti per l'header `cookie`. */
export function cookiesOf(res: LightMyRequestResponse): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

export function signIn(app: FastifyInstance, email: string, password = PASSWORD, ip = "127.0.0.1") {
  return app.inject({
    method: "POST",
    url: "/auth/sign-in/email",
    headers: { origin: ORIGIN },
    remoteAddress: ip,
    payload: { email, password },
  });
}

/** Crea un utente con il ruolo indicato e restituisce i cookie della sua sessione. */
export async function loginAs(app: FastifyInstance, role: UserRole) {
  const user = await createUser(app, role);
  const res = await signIn(app, user.email);
  if (res.statusCode !== 200) throw new Error(`login fallito: ${res.statusCode} ${res.body}`);
  return { user, cookie: cookiesOf(res) };
}
