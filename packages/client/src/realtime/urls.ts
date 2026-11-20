/**
 * Percorsi pubblici verso il server.
 *
 * Il client parla sempre con il server sotto il prefisso `/api`: in sviluppo lo fa il proxy di Vite
 * (che toglie il prefisso e, con `ws: true`, inoltra anche il WebSocket), in produzione lo fa il
 * reverse proxy / Cloudflare Tunnel con la stessa regola. Quindi:
 *  - REST: `/api/campaigns/mine`, `/api/uploads/map`...
 *  - WebSocket: `ws(s)://<host>/api/ws`
 *  - file caricati: il server restituisce `/assets/<uuid>.<ext>` (percorso relativo all'API, salvato
 *    cosi' nello stato di gioco); per mostrarli il client li legge da `/api/assets/<uuid>.<ext>`.
 */
export const API_BASE = "/api";
export const ASSETS_PREFIX = "/assets/";

/** Da percorso salvato nello stato (`/assets/x.png`) a URL da usare in `<img>` o nel canvas. */
export function assetUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  if (path.startsWith(ASSETS_PREFIX)) return `${API_BASE}${path}`;
  return path;
}

/** URL del WebSocket del server, stessa origine della pagina. */
export function wsUrl(loc: Pick<Location, "protocol" | "host"> = window.location): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${API_BASE}/ws`;
}
