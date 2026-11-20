import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `false`, `true` (sconsigliato) o un elenco di IP/subnet fidati, es. `loopback` o `127.0.0.1,::1`. */
export type TrustProxy = boolean | string;

export interface RateLimitRule {
  max: number;
  timeWindowMs: number;
}

export interface AppConfig {
  production: boolean;
  /** URL di SQLite per libSQL, es. `file:./data/lanterna.db`. */
  databaseUrl: string;
  /** Segreto di Better Auth (firma di cookie e token). */
  authSecret: string;
  /** URL pubblico del server, es. `https://lanterna.example.com`. */
  baseURL: string;
  /** Origini ammesse per le richieste che modificano lo stato (oltre a quella di `baseURL`). */
  trustedOrigins: string[];
  /** Valore di `trustProxy` per Fastify (Cloudflare Tunnel: `loopback`). */
  trustProxy: TrustProxy;
  rateLimit: {
    login: RateLimitRule;
    createUser: RateLimitRule;
    upload: RateLimitRule;
  };
  /** Cartella (assoluta) dei file caricati, fuori dalla webroot statica. */
  uploadDir: string;
  upload: {
    /** Dimensione massima di un file in byte. */
    maxBytes: number;
    /** Lato massimo in pixel. */
    maxSide: number;
    /** Area massima in pixel (larghezza x altezza). */
    maxPixels: number;
  };
  realtime: {
    /** Intervallo dei ping WebSocket; una connessione che non risponde entro il ping successivo viene chiusa. */
    heartbeatMs: number;
    /** Tempo massimo per ricevere `hello` dopo l'apertura del socket. */
    helloTimeoutMs: number;
    /** Messaggi al secondo concessi a ogni connessione (media). */
    messagesPerSecond: number;
    /** Raffica massima di messaggi oltre la media. */
    messageBurst: number;
  };
}

/** Lunghezza minima del segreto: 32 caratteri, come richiesto da Better Auth. */
export const MIN_SECRET_LENGTH = 32;

const DEV_SECRET = "lanterna-dev-secret-non-usare-in-produzione-0000";

export class ConfigError extends Error {}

function parseTrustProxy(value: string | undefined): TrustProxy {
  const v = value?.trim();
  if (!v || v === "false") return false;
  if (v === "true") return true;
  return v;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new URL(s).origin);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Legge la configurazione dalle variabili d'ambiente.
 * In produzione `BETTER_AUTH_SECRET` e `BETTER_AUTH_URL` sono obbligatori: senza, il server non parte.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === "production";
  const secret = env.BETTER_AUTH_SECRET?.trim();

  if (production) {
    if (!secret) throw new ConfigError("BETTER_AUTH_SECRET è obbligatorio in produzione.");
    if (!env.BETTER_AUTH_URL) throw new ConfigError("BETTER_AUTH_URL è obbligatorio in produzione.");
  }
  if (secret && secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`BETTER_AUTH_SECRET deve avere almeno ${MIN_SECRET_LENGTH} caratteri.`);
  }

  const port = env.PORT ?? "3000";
  const baseURL = new URL(env.BETTER_AUTH_URL ?? `http://localhost:${port}`).origin;
  const trustedOrigins = parseList(env.TRUSTED_ORIGINS ?? (production ? "" : "http://localhost:5173"));

  return {
    production,
    databaseUrl: env.DATABASE_URL ?? "file:./data/lanterna.db",
    authSecret: secret ?? DEV_SECRET,
    baseURL,
    trustedOrigins,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimit: {
      login: { max: positiveInt(env.RATE_LIMIT_LOGIN_MAX, 5), timeWindowMs: 60_000 },
      createUser: { max: positiveInt(env.RATE_LIMIT_CREATE_USER_MAX, 10), timeWindowMs: 60_000 },
      upload: { max: positiveInt(env.RATE_LIMIT_UPLOAD_MAX, 30), timeWindowMs: 60_000 },
    },
    uploadDir: resolve(env.UPLOAD_DIR ?? "./uploads"),
    upload: {
      maxBytes: positiveInt(env.UPLOAD_MAX_BYTES, 25 * 1024 * 1024),
      maxSide: positiveInt(env.UPLOAD_MAX_SIDE, 16_384),
      maxPixels: positiveInt(env.UPLOAD_MAX_PIXELS, 100_000_000),
    },
    realtime: {
      heartbeatMs: positiveInt(env.WS_HEARTBEAT_MS, 30_000),
      helloTimeoutMs: positiveInt(env.WS_HELLO_TIMEOUT_MS, 10_000),
      messagesPerSecond: positiveInt(env.WS_MESSAGES_PER_SECOND, 30),
      messageBurst: positiveInt(env.WS_MESSAGE_BURST, 60),
    },
  };
}

/** Carica `.env` dalla radice del repo, se esiste (non sovrascrive variabili già presenti). */
export function loadDotEnv(): void {
  // config.ts vive in packages/server/src (o dist): la radice è tre livelli sopra.
  const path = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}
