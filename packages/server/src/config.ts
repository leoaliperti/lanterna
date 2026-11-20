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
  /**
   * Prefisso di tutte le rotte API (`/auth`, `/ws`, `/assets`, ...). Vuoto in sviluppo e nei test
   * (il proxy di Vite riscrive `/api/x` in `/x`); in produzione `/api`, così il client compilato
   * (servito alla radice) e l'API convivono su una sola porta.
   */
  apiPrefix: string;
  /** Cartella del client compilato da servire (`packages/client/dist`), o `null` se non si serve. */
  clientDir: string | null;
  /** Aggiunge `'unsafe-eval'` a `script-src` (serve a PixiJS 8 senza `pixi.js/unsafe-eval`). */
  cspUnsafeEval: boolean;
  /** Dimensione massima del corpo di `POST /content/import` (byte). */
  contentMaxBytes: number;
  /** Tipi di contenuto leggibili dai giocatori (membri di una campagna). */
  contentPlayerKinds: string[];
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
  chat: {
    /** Voci di cronologia inviate dopo ogni `hello` (ultime N visibili all'utente). */
    historyOnConnect: number;
    /** Messaggi di chat al minuto per utente (media) e raffica massima. */
    messagesPerMinute: number;
    messageBurst: number;
    /** Tiri al minuto per utente (media) e raffica massima. */
    rollsPerMinute: number;
    rollBurst: number;
  };
  /** Misurazioni, frecce e ping effimeri (M7): limite per utente su tutte le sue connessioni. */
  ephemeral: {
    perSecond: number;
    burst: number;
  };
}

/** Massimo di voci inviate alla connessione (`CHAT_HISTORY_LIMIT`). */
export const MAX_HISTORY_ON_CONNECT = 500;

/** Lunghezza minima del segreto: 32 caratteri, come richiesto da Better Auth. */
export const MIN_SECRET_LENGTH = 32;

/** `packages/client/dist`, relativo a questo file (`packages/server/src` o `dist`). */
const DEFAULT_CLIENT_DIR = fileURLToPath(new URL("../../client/dist", import.meta.url));

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

/** Prefisso normalizzato: `""` oppure `/qualcosa` (niente slash finale). */
function parsePrefix(value: string): string {
  const v = value.trim().replace(/\/+$/, "");
  if (v === "") return "";
  if (!/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(v)) {
    throw new ConfigError("API_PREFIX non valido: usa un percorso come /api.");
  }
  return v;
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

  if (production) {
    if (env.DATABASE_URL === ":memory:" || env.DATABASE_URL?.includes(":memory:")) {
      throw new ConfigError("DATABASE_URL in memoria non è ammesso in produzione.");
    }
    if (parseTrustProxy(env.TRUST_PROXY) === true) {
      throw new ConfigError("TRUST_PROXY=true si fida di qualsiasi client: indica loopback o gli IP del proxy.");
    }
  }

  const port = env.PORT ?? "3000";
  const publicUrl = new URL(env.BETTER_AUTH_URL ?? `http://localhost:${port}`);
  const baseURL = publicUrl.origin;
  if (production && publicUrl.protocol !== "https:" && env.ALLOW_INSECURE_HTTP !== "true") {
    throw new ConfigError(
      "BETTER_AUTH_URL deve essere https in produzione (i cookie sono Secure). Per prove in locale: ALLOW_INSECURE_HTTP=true.",
    );
  }
  const trustedOrigins = parseList(env.TRUSTED_ORIGINS ?? (production ? "" : "http://localhost:5173"));
  const apiPrefix = parsePrefix(env.API_PREFIX ?? (production ? "/api" : ""));
  const clientDir = env.CLIENT_DIR
    ? resolve(env.CLIENT_DIR)
    : production && env.SERVE_CLIENT !== "false"
      ? DEFAULT_CLIENT_DIR
      : null;
  if (clientDir && apiPrefix === "") {
    throw new ConfigError("Servire il client richiede un API_PREFIX (es. /api): le rotte /assets si sovrapporrebbero.");
  }

  return {
    production,
    databaseUrl: env.DATABASE_URL ?? "file:./data/lanterna.db",
    authSecret: secret ?? DEV_SECRET,
    baseURL,
    trustedOrigins,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    apiPrefix,
    clientDir,
    cspUnsafeEval: env.CSP_ALLOW_UNSAFE_EVAL === "true",
    contentMaxBytes: positiveInt(env.CONTENT_MAX_BYTES, 5 * 1024 * 1024),
    contentPlayerKinds: (env.CONTENT_PLAYER_KINDS ?? "item,spell")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
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
    chat: {
      historyOnConnect: Math.min(positiveInt(env.CHAT_HISTORY_LIMIT, 50), MAX_HISTORY_ON_CONNECT),
      messagesPerMinute: positiveInt(env.CHAT_MESSAGES_PER_MINUTE, 30),
      messageBurst: positiveInt(env.CHAT_MESSAGE_BURST, 10),
      rollsPerMinute: positiveInt(env.ROLLS_PER_MINUTE, 30),
      rollBurst: positiveInt(env.ROLL_BURST, 10),
    },
    ephemeral: {
      perSecond: positiveInt(env.EPHEMERAL_PER_SECOND, 10),
      burst: positiveInt(env.EPHEMERAL_BURST, 20),
    },
  };
}

/** Carica `.env` dalla radice del repo, se esiste (non sovrascrive variabili già presenti). */
export function loadDotEnv(): void {
  // config.ts vive in packages/server/src (o dist): la radice è tre livelli sopra.
  const path = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}
