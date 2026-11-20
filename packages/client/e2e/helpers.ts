/**
 * Helper condivisi dai test end-to-end: un vero `RealtimeClient` collegato con i cookie di un utente
 * al vero server (avviato da `createTestApp`). Registra tutto il traffico ricevuto, cosi' i test
 * possono cercare dati segreti nei byte effettivamente arrivati.
 */
import WebSocket from "ws";
import { ORIGIN } from "../../server/src/test/helpers";
import { RealtimeClient, type SocketLike } from "../src/realtime/RealtimeClient";

export const sockets: WebSocket[] = [];
export const clients: RealtimeClient[] = [];

export interface Player {
  client: RealtimeClient;
  traffic: string[];
  sockets: WebSocket[];
}

/** `query`: parametri del percorso /ws (M9: `?viewAs=<userId>`, `?readOnly=1`). */
export function connect(port: number, campaignId: string, cookie: string, query = ""): Player {
  const traffic: string[] = [];
  const mine: WebSocket[] = [];
  const client = new RealtimeClient({
    campaignId,
    url: `ws://127.0.0.1:${port}/ws${query}`,
    stopOnForbidden: query.includes("viewAs="),
    backoff: { baseMs: 20, maxMs: 60 },
    createSocket: (url) => {
      const ws = new WebSocket(url, { headers: { cookie, origin: ORIGIN } });
      ws.on("message", (d) => traffic.push(d.toString("utf8")));
      sockets.push(ws);
      mine.push(ws);
      return ws as unknown as SocketLike;
    }
  });
  clients.push(client);
  client.start();
  return { client, traffic, sockets: mine };
}

export async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Ferma client e socket aperti (da chiamare in `afterEach`). */
export function closeConnections(): void {
  for (const c of clients.splice(0)) c.stop();
  for (const s of sockets.splice(0)) s.terminate();
}
