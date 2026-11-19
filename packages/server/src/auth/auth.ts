import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type UserRole } from "@lanterna/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { schema } from "../db/schema.js";

/** Header interno con l'IP del client ricavato da Fastify (rispetta `trustProxy`). */
export const CLIENT_IP_HEADER = "x-lanterna-client-ip";

/** Percorso base delle rotte di Better Auth. */
export const AUTH_BASE_PATH = "/auth";

export function createAuth(config: AppConfig, db: Db) {
  return betterAuth({
    appName: "Lanterna",
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    trustedOrigins: [config.baseURL, ...config.trustedOrigins],
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      // Nessuna registrazione pubblica: gli account li crea solo l'admin.
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      // Hash: scrypt, il default di Better Auth.
    },
    user: {
      additionalFields: {
        role: {
          type: ["admin", "player"],
          required: true,
          defaultValue: "player",
          // Mai impostabile dal client.
          input: false,
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 giorni
      updateAge: 60 * 60 * 24, // rinnovo al massimo una volta al giorno
    },
    // Il rate limit lo fa Fastify (@fastify/rate-limit), che conosce l'IP reale dietro il proxy.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    advanced: {
      useSecureCookies: config.production,
      cookiePrefix: "lanterna",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: config.production },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export interface AuthSession {
  user: SessionUser;
  session: { id: string; userId: string; expiresAt: Date };
}
