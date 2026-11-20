import { randomUUID } from "node:crypto";
import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { MAX_CLIENT_MESSAGE_SIZE, parseClientMessage, type ServerMessage } from "@lanterna/shared";
import { getSessionFromUpgradeRequest } from "../auth/session.js";
import type { AppConfig } from "../config.js";
import { session as sessionTable } from "../db/schema.js";
import { isAllowedOrigin } from "../security.js";
import { CLOSE, type Hub, type Peer } from "./hub.js";
import { TokenBucket } from "./rate.js";

/** Percorso del WebSocket (in sviluppo il client passa dal proxy Vite: `/api/ws`). */
export const WS_PATH = "/ws";
/** Connessioni contemporanee per utente (finestre multiple, tablet, ...). */
export const MAX_CONNECTIONS_PER_USER = 16;
/** Oltre questo buffer in uscita il client è troppo lento: si chiude. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "X-Content-Type-Options: nosniff\r\n\r\n" +
      body,
  );
}

/**
 * WebSocket su `ws` collegato direttamente all'evento `upgrade` del server HTTP di Fastify
 * (niente @fastify/websocket: così il rifiuto 401/403 avviene in modo esplicito PRIMA
 * dell'handshake e il codice resta piccolo e verificabile).
 */
export function attachRealtime(
  app: FastifyInstance,
  hub: Hub,
  config: AppConfig,
  allowedOrigins: ReadonlySet<string>,
): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_SIZE,
    perMessageDeflate: false,
    clientTracking: false,
  });
  const { realtime } = config;
  /** Per ogni connessione: `false` se non ha risposto al ping precedente, altrimenti invia un nuovo ping. */
  const tick = new WeakMap<Peer, () => boolean>();

  async function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => socket.destroy());
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return rejectUpgrade(socket, 400, "Richiesta non valida");
    }
    if (pathname !== WS_PATH) return rejectUpgrade(socket, 404, "Non trovato");
    // Anti cross-site WebSocket hijacking: il browser manda sempre Origin; senza o diverso => 403.
    if (!isAllowedOrigin({ origin: req.headers.origin }, allowedOrigins)) {
      return rejectUpgrade(socket, 403, "Origine non ammessa");
    }
    const auth = await getSessionFromUpgradeRequest(app.auth, req).catch(() => null);
    if (!auth) return rejectUpgrade(socket, 401, "Non autenticato");
    if (hub.connectionsOf(auth.user.id) >= MAX_CONNECTIONS_PER_USER) {
      return rejectUpgrade(socket, 429, "Troppe connessioni");
    }
    if (socket.destroyed) return;
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, auth.user.id, auth.session.id));
  }

  function onConnection(ws: WebSocket, userId: string, sessionId: string): void {
    let isAlive = true;
    let closed = false;
    const peer: Peer = {
      id: randomUUID(),
      userId,
      sessionId,
      actor: null,
      campaignId: null,
      lastSent: 0,
      send(message: ServerMessage) {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          ws.terminate();
          return;
        }
        ws.send(JSON.stringify(message));
      },
      close(code: number, reason: string) {
        if (closed) return;
        closed = true;
        ws.close(code, reason);
        // Se il client non completa la chiusura, si taglia.
        setTimeout(() => ws.terminate(), 2000).unref();
      },
    };
    tick.set(peer, () => {
      if (!isAlive) {
        // Connessione morta (es. tunnel caduto): niente handshake di chiusura, si taglia.
        ws.terminate();
        return false;
      }
      isAlive = false;
      if (ws.readyState === ws.OPEN) ws.ping();
      return true;
    });
    hub.addPeer(peer);

    const helloTimer = setTimeout(() => {
      if (!peer.actor) peer.close(CLOSE.helloTimeout, "hello mancante");
    }, realtime.helloTimeoutMs);
    helloTimer.unref();

    const bucket = new TokenBucket(realtime.messagesPerSecond, realtime.messageBurst);
    let dropped = 0;

    ws.on("pong", () => {
      isAlive = true;
    });
    ws.on("error", (err) => app.log.debug({ err }, "errore WebSocket"));
    ws.on("close", () => {
      closed = true;
      clearTimeout(helloTimer);
      hub.removePeer(peer);
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      isAlive = true;
      if (closed) return;
      if (!bucket.take()) {
        dropped++;
        if (dropped === 1 || dropped % 50 === 0) {
          peer.send({ type: "error", requestId: null, code: "INVALID", message: "troppi messaggi" });
        }
        if (dropped > realtime.messageBurst * 4) peer.close(CLOSE.policy, "troppi messaggi");
        return;
      }
      dropped = 0;
      try {
        handleMessage(peer, data, isBinary, () => clearTimeout(helloTimer));
      } catch (err) {
        app.log.error({ err }, "errore nella gestione di un messaggio WebSocket");
        peer.send({ type: "error", requestId: null, code: "INVALID", message: "messaggio non valido" });
      }
    });
  }

  function handleMessage(peer: Peer, data: RawData, isBinary: boolean, helloReceived: () => void): void {
    if (isBinary) {
      peer.send({ type: "error", requestId: null, code: "INVALID", message: "messaggio non testuale" });
      return;
    }
    const raw = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as Buffer).toString("utf8");
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      peer.send(parsed.error);
      return;
    }
    const msg = parsed.message;
    switch (msg.type) {
      case "hello":
        helloReceived();
        hub.hello(peer, msg);
        return;
      case "command":
        void hub.submit(peer, { type: "command", requestId: msg.requestId, command: msg.command });
        return;
      case "undo":
      case "redo":
        void hub.submit(peer, { type: msg.type, requestId: msg.requestId });
        return;
      case "ping":
        peer.send({ type: "pong" });
        return;
      case "chat.send":
        void hub.chat(peer, msg);
        return;
      case "roll.request":
        void hub.roll(peer, msg);
        return;
      case "history.request":
        void hub.history(peer, msg);
        return;
    }
  }

  /** Keep-alive: ping periodico; chi non ha risposto dal ping precedente viene chiuso. */
  async function heartbeat(): Promise<void> {
    const now = Date.now();
    for (const peer of [...hub.allPeers()]) {
      const check = tick.get(peer);
      if (check && !check()) {
        hub.removePeer(peer);
        continue;
      }
      // La sessione può essere scaduta, revocata (logout, reset password) nel frattempo.
      try {
        const row = await app.database.db.query.session.findFirst({
          where: eq(sessionTable.id, peer.sessionId),
          columns: { expiresAt: true },
        });
        if (!row || row.expiresAt.getTime() <= now) {
          hub.removePeer(peer);
          peer.close(CLOSE.sessionEnded, "sessione terminata");
        }
      } catch (err) {
        app.log.warn({ err }, "verifica della sessione WebSocket non riuscita");
      }
    }
  }
  const timer = setInterval(() => void heartbeat(), realtime.heartbeatMs);
  timer.unref();

  const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    onUpgrade(req, socket, head).catch((err: unknown) => {
      app.log.error({ err }, "errore durante l'upgrade WebSocket");
      rejectUpgrade(socket, 500, "Errore interno");
    });
  };
  app.server.on("upgrade", listener);

  app.addHook("preClose", async () => {
    clearInterval(timer);
    app.server.off("upgrade", listener);
    await hub.shutdown();
  });
  app.addHook("onClose", async () => {
    wss.close();
  });
}
