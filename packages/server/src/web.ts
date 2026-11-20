import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";

/** CSP restrittiva delle risposte dell'API (JSON, immagini caricate): nessuna risorsa ammessa. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * CSP della pagina del client (Vite + React + PixiJS + Three.js), tutto servito dalla stessa origine:
 * - niente CDN: font, script e stile arrivano solo da `'self'`;
 * - `worker-src blob:` e `img-src blob: data:` per le texture e i worker creati a runtime;
 * - `style-src 'unsafe-inline'` per gli attributi `style` di React (gli script restano `'self'`, senza inline);
 * - `connect-src` elenca esplicitamente il WebSocket: `'self'` non copre `ws:` in tutti i browser;
 * - `'unsafe-eval'` solo con `CSP_ALLOW_UNSAFE_EVAL=true` (PixiJS 8 lo richiede salvo `pixi.js/unsafe-eval`).
 */
export function pageCsp(config: Pick<AppConfig, "baseURL" | "cspUnsafeEval">): string {
  const url = new URL(config.baseURL);
  const ws = `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
  const scripts = ["'self'", ...(config.cspUnsafeEval ? ["'unsafe-eval'"] : [])];
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scripts,
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "media-src": ["'self'", "blob:", "data:"],
    "connect-src": ["'self'", ws],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

/** Un percorso appartiene all'API se è il prefisso o sta sotto di esso. */
export function isApiPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Serve il client compilato: file statici, `index.html` come ripiego per le rotte dell'SPA.
 * Cache: i file in `assets/` hanno l'hash nel nome (Vite) quindi `immutable` per un anno;
 * `index.html` e il resto `no-cache` (si rivalida sempre, così un aggiornamento arriva subito).
 */
export async function registerClient(app: FastifyInstance, config: AppConfig): Promise<void> {
  const root = config.clientDir;
  if (!root) return;
  if (!existsSync(join(root, "index.html"))) {
    throw new Error(`Client non compilato: manca ${join(root, "index.html")}. Esegui "npm run build".`);
  }

  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    index: false,
    dotfiles: "ignore",
    cacheControl: false,
    setHeaders(reply, path) {
      const hashed = /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path);
      reply.header("Cache-Control", hashed ? IMMUTABLE : "no-cache");
    },
  });

  // `/` e ogni rotta dell'SPA: index.html, sempre rivalidato.
  app.setNotFoundHandler(async (request, reply) => {
    const pathname = request.url.split("?")[0] ?? "/";
    const wantsPage =
      (request.method === "GET" || request.method === "HEAD") &&
      !isApiPath(pathname, config.apiPrefix) &&
      // Un file con estensione che non esiste (es. /assets/vecchio-hash.js) è un vero 404, non l'SPA.
      !/\.[A-Za-z0-9]{1,8}$/.test(pathname);
    if (!wantsPage) return reply.code(404).send({ error: "Non trovato" });
    reply.header("Cache-Control", "no-cache");
    return reply.sendFile("index.html");
  });
}
