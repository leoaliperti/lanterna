import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type CampaignView, type Command } from "@lanterna/shared";
import { RealtimeClient, backoffDelay } from "./RealtimeClient";
import { FakeSocket } from "./fakeSocket";
import { assetUrl, wsUrl } from "./urls";

const view = (version: number, extra: Partial<CampaignView> = {}): CampaignView => ({
  campaignId: "c1",
  name: "Campagna",
  version,
  viewer: { userId: "u1", role: "admin" },
  activeSceneId: null,
  members: [{ userId: "u1", displayName: "Marta", role: "admin" }],
  scenes: [],
  tokens: [],
  ...extra
});

const snapshot = (version: number, epoch = "e1", v: CampaignView = view(version)) => ({
  type: "snapshot",
  protocolVersion: PROTOCOL_VERSION,
  epoch,
  version,
  view: v
});

const scene = {
  id: "s1",
  name: "Cripta",
  map: null,
  width: 1000,
  height: 800,
  grid: { cellSize: 70, color: "#000000", opacity: 0.3, offsetX: 0, offsetY: 0, snap: true, visible: true },
  scale: { unitsPerCell: 5, unit: "ft" }
};

let sockets: FakeSocket[] = [];

function make(over: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
  const client = new RealtimeClient({
    campaignId: "c1",
    url: "ws://test/api/ws",
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    random: () => 0.5,
    backoff: { baseMs: 1000, maxMs: 8000 },
    isOnline: () => true,
    ...over
  });
  return client;
}
const cur = () => sockets[sockets.length - 1]!;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("handshake e stato", () => {
  it("invia hello con versione nulla alla prima connessione e applica lo snapshot", () => {
    const c = make();
    c.start();
    expect(c.getState().status).toBe("connecting");
    cur().open();
    expect(cur().sent[0]).toEqual({ type: "hello", protocolVersion: PROTOCOL_VERSION, campaignId: "c1", lastVersion: null, epoch: null });
    cur().push(snapshot(3));
    expect(c.getState().status).toBe("connected");
    expect(c.getState().view?.version).toBe(3);
    expect(c.getState().epoch).toBe("e1");
  });

  it("applica i delta in sequenza e notifica i sottoscrittori", () => {
    const c = make();
    const seen = vi.fn();
    c.subscribe(seen);
    c.start();
    cur().open();
    cur().push(snapshot(3));
    seen.mockClear();
    cur().push({ type: "delta", epoch: "e1", fromVersion: 3, toVersion: 4, events: [{ type: "scene.created", scene }] });
    expect(c.getState().view?.version).toBe(4);
    expect(c.getState().view?.scenes).toHaveLength(1);
    expect(seen).toHaveBeenCalled();
  });

  it("ignora messaggi non validi o sconosciuti senza rompersi", () => {
    const c = make();
    c.start();
    cur().open();
    cur().onmessage?.({ data: "non json" });
    cur().push({ type: "boh" });
    cur().push(snapshot(1));
    expect(c.getState().view?.version).toBe(1);
  });

  it("buco di versione: chiede uno snapshot e ignora i delta fino alla risposta", () => {
    const c = make();
    c.start();
    cur().open();
    cur().push(snapshot(3));
    cur().push({ type: "delta", epoch: "e1", fromVersion: 5, toVersion: 6, events: [{ type: "scene.created", scene }] });
    expect(cur().last("hello")).toMatchObject({ lastVersion: null, epoch: null });
    expect(c.getState().view?.version).toBe(3);
    const hellos = cur().sent.filter((m) => m.type === "hello").length;
    cur().push({ type: "delta", epoch: "e1", fromVersion: 6, toVersion: 7, events: [] });
    expect(cur().sent.filter((m) => m.type === "hello")).toHaveLength(hellos); // niente richieste doppie
    cur().push(snapshot(7, "e1", view(7, { scenes: [scene] })));
    expect(c.getState().view?.version).toBe(7);
    cur().push({ type: "delta", epoch: "e1", fromVersion: 7, toVersion: 8, events: [] });
    expect(c.getState().view?.version).toBe(8);
  });

  it("epoca diversa: chiede uno snapshot", () => {
    const c = make();
    c.start();
    cur().open();
    cur().push(snapshot(3));
    cur().push({ type: "delta", epoch: "altra", fromVersion: 3, toVersion: 4, events: [] });
    expect(cur().last("hello")).toMatchObject({ lastVersion: null });
    cur().push(snapshot(4, "altra"));
    expect(c.getState().epoch).toBe("altra");
  });

  it("delta vuoto dopo la riconnessione: resta connesso senza cambiare la vista", () => {
    const c = make();
    c.start();
    cur().open();
    cur().push(snapshot(3));
    const before = c.getState().view;
    cur().drop();
    vi.advanceTimersByTime(10_000);
    cur().open();
    expect(cur().sent[0]).toMatchObject({ type: "hello", lastVersion: 3, epoch: "e1" });
    cur().push({ type: "delta", epoch: "e1", fromVersion: 3, toVersion: 3, events: [] });
    expect(c.getState().status).toBe("connected");
    expect(c.getState().view).toBe(before);
  });
});

describe("riconnessione", () => {
  it("il backoff e' esponenziale con tetto e jitter", () => {
    expect(backoffDelay(0, 1000, 8000, () => 0)).toBe(500);
    expect(backoffDelay(0, 1000, 8000, () => 1)).toBe(1000);
    expect(backoffDelay(1, 1000, 8000, () => 1)).toBe(2000);
    expect(backoffDelay(2, 1000, 8000, () => 1)).toBe(4000);
    expect(backoffDelay(10, 1000, 8000, () => 1)).toBe(8000);
    expect(backoffDelay(10, 1000, 8000, () => 0)).toBe(4000);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(3, 1000, 8000, Math.random);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });

  it("dopo una caduta riprova con ritardi crescenti e mantiene la vista", () => {
    const c = make();
    c.start();
    cur().open();
    cur().push(snapshot(3));
    cur().drop();
    expect(c.getState().status).toBe("reconnecting");
    expect(c.getState().view?.version).toBe(3);
    expect(sockets).toHaveLength(1);
    // random 0.5 => 0.75 * 1000 = 750ms al primo tentativo
    vi.advanceTimersByTime(749);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    cur().drop(); // secondo fallimento: 1500ms
    vi.advanceTimersByTime(1499);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    cur().open();
    cur().push(snapshot(4));
    expect(c.getState()).toMatchObject({ status: "connected", attempt: 0 });
    cur().drop(); // dopo un successo si riparte dal ritardo minimo
    vi.advanceTimersByTime(750);
    expect(sockets).toHaveLength(4);
  });

  it("stop() non riconnette e chiude il socket", () => {
    const c = make();
    c.start();
    cur().open();
    c.stop();
    expect(cur().closedWith).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("start dopo stop (StrictMode) ripristina la connessione", () => {
    const c = make();
    c.start();
    c.stop();
    c.start();
    expect(sockets).toHaveLength(2);
    expect(c.getState().status).toBe("connecting");
  });

  it("sessione terminata (4401): niente riconnessione e evento session-ended", () => {
    const c = make();
    const events = vi.fn();
    c.onEvent(events);
    c.start();
    cur().open();
    cur().push(snapshot(1));
    cur().drop(4401);
    expect(c.getState()).toMatchObject({ status: "failed", failure: "session" });
    expect(events).toHaveBeenCalledWith({ type: "session-ended" });
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("non membro (4404) e versione del protocollo (4400) sono definitivi", () => {
    const a = make();
    a.start();
    cur().open();
    cur().drop(4404);
    expect(a.getState().failure).toBe("not-member");
    const b = make();
    b.start();
    cur().open();
    cur().drop(4400);
    expect(b.getState().failure).toBe("protocol");
  });

  it("permessi cambiati (4403): riconnette e ricevera' uno snapshot", () => {
    const c = make();
    c.start();
    cur().open();
    cur().push(snapshot(1));
    cur().drop(4403);
    expect(c.getState().status).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it("dopo 3 fallimenti verifica la sessione e si ferma se e' scaduta", async () => {
    const verifySession = vi.fn().mockResolvedValue(false);
    const c = make({ verifySession });
    c.start();
    for (let i = 0; i < 3; i++) {
      cur().drop();
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(verifySession).toHaveBeenCalledTimes(1);
    expect(c.getState().failure).toBe("session");
    expect(sockets).toHaveLength(3);
  });

  it("senza rete mostra offline e riprova subito quando torna", () => {
    let online = false;
    const c = make({ isOnline: () => online });
    c.start();
    expect(c.getState().status).toBe("offline");
    expect(sockets).toHaveLength(0);
    online = true;
    window.dispatchEvent(new Event("online"));
    expect(sockets).toHaveLength(1);
    c.stop();
  });

  it("ping periodico; senza pong il socket viene abbandonato e si riconnette", () => {
    const c = make({ pingIntervalMs: 1000, pongTimeoutMs: 500 });
    c.start();
    cur().open();
    cur().push(snapshot(1));
    vi.advanceTimersByTime(1000);
    expect(cur().last("ping")).toBeTruthy();
    cur().push({ type: "pong" });
    vi.advanceTimersByTime(1000); // secondo ping, questa volta senza risposta
    const first = cur();
    vi.advanceTimersByTime(500);
    expect(first.closedWith).toBe(4000);
    expect(c.getState().status).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });
});

describe("comandi", () => {
  const move: Command = { type: "token.move", tokenId: "t1", x: 10, y: 20 };

  it("invia requestId e risolve con l'ack, senza toccare la vista", async () => {
    const c = make();
    c.start();
    cur().open();
    cur().push(snapshot(1));
    const p = c.sendCommand(move);
    const sent = cur().last("command") as { requestId: string; command: Command };
    expect(sent.command).toEqual(move);
    expect(sent.requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(c.getState().view?.version).toBe(1);
    cur().push({ type: "ack", requestId: sent.requestId, version: 2 });
    await expect(p).resolves.toEqual({ ok: true, version: 2 });
  });

  it("gli errori FORBIDDEN, INVALID e CONFLICT arrivano al chiamante con il codice", async () => {
    const c = make();
    c.start();
    cur().open();
    cur().push(snapshot(1));
    for (const code of ["FORBIDDEN", "INVALID", "CONFLICT"] as const) {
      const p = c.sendCommand(move);
      const { requestId } = cur().last("command") as { requestId: string };
      cur().push({ type: "error", requestId, code, message: "m" });
      await expect(p).resolves.toEqual({ ok: false, code, message: "m" });
    }
  });

  it("errori senza requestId diventano eventi", () => {
    const c = make();
    const events = vi.fn();
    c.onEvent(events);
    c.start();
    cur().open();
    cur().push({ type: "error", requestId: null, code: "INVALID", message: "troppi messaggi" });
    expect(events).toHaveBeenCalledWith({ type: "error", code: "INVALID", message: "troppi messaggi" });
  });

  it("undo e redo usano requestId propri", async () => {
    const c = make();
    c.start();
    cur().open();
    cur().push(snapshot(1));
    const u = c.undo();
    const undoMsg = cur().last("undo") as { requestId: string };
    cur().push({ type: "ack", requestId: undoMsg.requestId, version: 2 });
    await expect(u).resolves.toMatchObject({ ok: true });
    const r = c.redo();
    const redoMsg = cur().last("redo") as { requestId: string };
    expect(redoMsg.requestId).not.toBe(undoMsg.requestId);
    cur().push({ type: "error", requestId: redoMsg.requestId, code: "NOT_FOUND", message: "x" });
    await expect(r).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("offline: nessun invio, errore immediato", async () => {
    const c = make();
    c.start();
    await expect(c.sendCommand(move)).resolves.toMatchObject({ ok: false, code: "OFFLINE" });
    expect(cur().sent.some((m) => m.type === "command")).toBe(false);
  });

  it("caduta della connessione: i comandi in attesa falliscono con OFFLINE", async () => {
    const c = make();
    c.start();
    cur().open();
    cur().push(snapshot(1));
    const p = c.sendCommand(move);
    cur().drop();
    await expect(p).resolves.toMatchObject({ ok: false, code: "OFFLINE" });
  });

  it("senza risposta scade con TIMEOUT", async () => {
    const c = make({ commandTimeoutMs: 2000 });
    c.start();
    cur().open();
    cur().push(snapshot(1));
    const p = c.sendCommand(move);
    vi.advanceTimersByTime(2000);
    await expect(p).resolves.toMatchObject({ ok: false, code: "TIMEOUT" });
  });
});

describe("URL", () => {
  it("prefissa /api agli asset del server e lascia stare il resto", () => {
    expect(assetUrl("/assets/a.png")).toBe("/api/assets/a.png");
    expect(assetUrl("https://example.org/x.png")).toBe("https://example.org/x.png");
    expect(assetUrl(null)).toBeUndefined();
  });
  it("sceglie ws o wss in base alla pagina", () => {
    expect(wsUrl({ protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173/api/ws");
    expect(wsUrl({ protocol: "https:", host: "vtt.example.org" })).toBe("wss://vtt.example.org/api/ws");
  });
});
