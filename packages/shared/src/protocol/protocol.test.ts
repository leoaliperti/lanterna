import { describe, expect, it } from "vitest";
import { GM, MAIN, P1, P2, PREP, SECRET, baseState, expectNoLeak, rng, token } from "../state/fixtures.test-utils.js";
import type { Actor } from "../state/schema.js";
import { viewFor, type CampaignView } from "../state/view.js";
import { applyDelta } from "./client.js";
import {
  ClientMessageSchema,
  MAX_CLIENT_MESSAGE_SIZE,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  parseClientMessage,
  type DeltaMessage,
  type ServerMessage,
} from "./messages.js";
import {
  appendToLog,
  createCore,
  createEventLog,
  deltaFor,
  dispatch,
  planResync,
  snapshotFor,
  type CampaignCore,
  type DispatchInput,
} from "./sync.js";

const EPOCH = "epoch-a";

describe("parseClientMessage", () => {
  it("accetta un comando valido", () => {
    const r = parseClientMessage(
      JSON.stringify({ type: "command", requestId: "r1", command: { type: "token.move", tokenId: "t", x: 1, y: 2 } }),
    );
    expect(r.ok).toBe(true);
  });
  it("accetta hello, undo, redo, ping e i segnaposto chat/tiro", () => {
    for (const m of [
      { type: "hello", protocolVersion: PROTOCOL_VERSION, campaignId: "c", lastVersion: null, epoch: null },
      { type: "hello", protocolVersion: PROTOCOL_VERSION, campaignId: "c", lastVersion: 7, epoch: "e" },
      { type: "undo", requestId: "r" },
      { type: "redo", requestId: "r" },
      { type: "ping" },
      { type: "chat.send", requestId: "r", text: "ciao", whisperTo: ["p2"] },
      { type: "roll.request", requestId: "r", formula: "2d6+3", secret: true },
    ]) {
      expect(parseClientMessage(JSON.stringify(m)).ok, JSON.stringify(m)).toBe(true);
    }
  });
  it("JSON non valido, troppo grande, sconosciuto: INVALID senza eccezioni", () => {
    const cases = [
      "{",
      "",
      "null",
      "[]",
      '"x"',
      JSON.stringify({ type: "nope" }),
      JSON.stringify({ type: "command", requestId: "r1" }),
      JSON.stringify({ type: "ping", extra: 1 }),
      "x".repeat(MAX_CLIENT_MESSAGE_SIZE + 1),
    ];
    for (const raw of cases) {
      const r = parseClientMessage(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID");
    }
    expect(parseClientMessage(42 as unknown as string).ok).toBe(false);
  });
  it("conserva il requestId leggibile negli errori", () => {
    const r = parseClientMessage(JSON.stringify({ type: "command", requestId: "r-9", command: { type: "x" } }));
    expect(!r.ok && r.error.requestId).toBe("r-9");
    const r2 = parseClientMessage(JSON.stringify({ type: "command", requestId: { evil: 1 }, command: {} }));
    expect(!r2.ok && r2.error.requestId).toBeNull();
  });
  it("fuzz: stringhe casuali non lanciano mai", () => {
    const r = rng(7);
    const alphabet = '{}[]":,0123456789abcdefghijklmnopqrstuvwxyz-_. \\';
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(r() * 80);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(r() * alphabet.length)];
      expect(() => parseClientMessage(s)).not.toThrow();
    }
  });
  it("lo schema dei messaggi client rifiuta campi extra in profondità", () => {
    expect(
      ClientMessageSchema.safeParse({
        type: "command",
        requestId: "r",
        command: { type: "token.update", tokenId: "t", patch: { hidden: true, evil: 1 } },
      }).success,
    ).toBe(false);
  });
});

/** Simula connessioni: ogni client ha una vista e l'ultima versione ricevuta. */
interface Conn {
  actor: Actor;
  view: CampaignView;
  lastSent: number;
  wire: string[];
}

function connect(core: CampaignCore, actor: Actor): Conn {
  const snap = snapshotFor(core.state, actor, core.log.epoch);
  return { actor, view: snap.view, lastSent: snap.version, wire: [JSON.stringify(snap)] };
}

/** Il "server": applica un input e invia i delta a tutte le connessioni attive. */
function serve(core: CampaignCore, conns: Conn[], from: Conn, input: DispatchInput): CampaignCore {
  const r = dispatch(core, from.actor, input);
  for (const c of conns) {
    const d = deltaFor(c.actor, r.core.log.epoch, c.lastSent, r.toVersion, r.changes);
    if (!d) continue;
    c.wire.push(JSON.stringify(d));
    expect(ServerMessageSchema.safeParse(d).success).toBe(true);
    const out = applyDelta(c.view, EPOCH, d);
    if (!out.ok) throw new Error(`delta non applicabile: ${out.reason}`);
    c.view = out.view;
    c.lastSent = d.toVersion;
  }
  from.wire.push(JSON.stringify(r.reply));
  return r.core;
}

const sortTok = (v: CampaignView) => ({ ...v, tokens: [...v.tokens].sort((a, b) => a.id.localeCompare(b.id)) });

describe("dispatch e traffico per utente", () => {
  it("ack con versione, errore con codice e requestId", () => {
    const core = createCore(baseState(), EPOCH);
    const ok = dispatch(core, P1, { type: "command", requestId: "r1", command: { type: "token.move", tokenId: "tok-p1", x: 455, y: 455 } });
    expect(ok.reply).toEqual({ type: "ack", requestId: "r1", version: 1 });
    const ko = dispatch(ok.core, P1, { type: "command", requestId: "r2", command: { type: "token.delete", tokenId: "tok-p1" } });
    expect(ko.reply).toEqual({ type: "error", requestId: "r2", code: "FORBIDDEN", message: expect.any(String) });
    expect(ko.core).toBe(ok.core);
    const u = dispatch(ok.core, P1, { type: "undo", requestId: "r3" });
    expect(u.reply).toMatchObject({ type: "ack", version: 2 });
    const rd = dispatch(u.core, P1, { type: "redo", requestId: "r4" });
    expect(rd.reply).toMatchObject({ type: "ack", version: 3 });
  });

  it("il traffico di rete del giocatore non contiene mai i segreti", () => {
    let core = createCore(baseState(), EPOCH);
    const gm = connect(core, GM);
    const p1 = connect(core, P1);
    const p2 = connect(core, P2);
    const conns = [gm, p1, p2];
    const send = (from: Conn, input: DispatchInput) => (core = serve(core, conns, from, input));
    let n = 0;
    const cmd = (command: unknown): DispatchInput => ({ type: "command", requestId: `r${++n}`, command });

    send(gm, cmd({ type: "token.move", tokenId: SECRET.hiddenOgreId, x: 455, y: 455 }));
    send(gm, cmd({ type: "token.update", tokenId: "tok-orc", patch: { gmNotes: "SEGRETO-XYZ", health: { current: 3, max: 8765, temp: 0 } } }));
    send(gm, cmd({ type: "token.create", token: token("tok-trap-XYZ", { hidden: true, name: "TrappolaXYZ" }) }));
    send(gm, cmd({ type: "scene.setGrid", sceneId: PREP, grid: { cellSize: 40 } }));
    send(p1, cmd({ type: "token.move", tokenId: "tok-p1", x: 455, y: 525 }));
    // P1 prova a toccare un token nascosto: errore indistinguibile da inesistente.
    send(p1, cmd({ type: "token.move", tokenId: SECRET.hiddenOgreId, x: 35, y: 35 }));
    send(p1, cmd({ type: "token.move", tokenId: "tok-trap-XYZ", x: 35, y: 35 }));
    send(p1, { type: "undo", requestId: "u1" });
    send(gm, { type: "undo", requestId: "u2" });

    const p1Wire = p1.wire.join("\n");
    expectNoLeak(p1Wire, [
      SECRET.hiddenOgreId,
      SECRET.hiddenOgreName,
      SECRET.prepDragonId,
      SECRET.prepSceneName,
      SECRET.notesOrc,
      SECRET.notesP1,
      SECRET.orcHp,
      SECRET.p2Hp,
      "TrappolaXYZ",
      "SEGRETO-XYZ",
      "8765",
      "gmNotes",
    ]);
    // ...ma i suoi errori e ack arrivano.
    expect(p1Wire).toContain('"code":"NOT_FOUND"');
    // Gli id inviati dal giocatore stesso tornano solo come requestId, non nei dati.
    expect(p1.wire.filter((w) => w.includes("tok-trap-XYZ"))).toEqual([]);
    // Le modifiche invisibili non arrivano: la versione del giocatore può restare indietro.
    for (const c of conns) {
      expect(c.view.version).toBeLessThanOrEqual(core.state.version);
      expect(sortTok({ ...c.view, version: 0 })).toEqual(sortTok({ ...viewFor(core.state, c.actor), version: 0 }));
    }
    expect(gm.view.version).toBe(core.state.version);
    expect(gm.wire.join("\n")).toContain("TrappolaXYZ");
  });

  it("le versioni ricevute dal giocatore sono crescenti e i delta concatenati", () => {
    let core = createCore(baseState(), EPOCH);
    const p1 = connect(core, P1);
    const gm = connect(core, GM);
    for (let i = 0; i < 5; i++) {
      core = serve(core, [p1, gm], gm, { type: "command", requestId: `g${i}`, command: { type: "token.move", tokenId: SECRET.hiddenOgreId, x: 35 + 70 * i, y: 595 } });
      core = serve(core, [p1, gm], gm, { type: "command", requestId: `o${i}`, command: { type: "token.move", tokenId: "tok-orc", x: 35 + 70 * i, y: 315 } });
    }
    const deltas = p1.wire.slice(1).map((w) => JSON.parse(w) as DeltaMessage);
    expect(deltas.length).toBeGreaterThan(0);
    for (let i = 1; i < deltas.length; i++) expect(deltas[i]!.fromVersion).toBe(deltas[i - 1]!.toVersion);
  });
});

describe("riconnessione: delta o snapshot", () => {
  function setup() {
    let core = createCore(baseState(), EPOCH);
    const gm = connect(core, GM);
    const p1 = connect(core, P1);
    // P1 si disconnette dopo aver visto la versione 0.
    const seen = p1.lastSent;
    const viewAtDisconnect = p1.view;
    let n = 0;
    const gmCmd = (command: unknown) => (core = serve(core, [gm], gm, { type: "command", requestId: `r${++n}`, command }));
    gmCmd({ type: "token.move", tokenId: "tok-orc", x: 455, y: 455 });
    gmCmd({ type: "token.update", tokenId: SECRET.hiddenOgreId, patch: { name: "AncoraNascostoXYZ" } });
    gmCmd({ type: "token.update", tokenId: "tok-p2", patch: { hidden: true } });
    gmCmd({ type: "token.update", tokenId: SECRET.hiddenP1Id, patch: { hidden: false } });
    return { core: () => core, seen, viewAtDisconnect };
  }

  it("con il registro che copre l'intervallo: delta filtrato che porta alla vista attuale", () => {
    const { core, seen, viewAtDisconnect } = setup();
    const msg = planResync(core().state, core().log, P1, { lastVersion: seen, epoch: EPOCH });
    expect(msg.type).toBe("delta");
    if (msg.type !== "delta") return;
    expect(msg.fromVersion).toBe(seen);
    expect(msg.toVersion).toBe(core().state.version);
    expectNoLeak(JSON.stringify(msg), [SECRET.hiddenOgreId, "AncoraNascostoXYZ", SECRET.p2Hp]);
    const out = applyDelta(viewAtDisconnect, EPOCH, msg);
    if (!out.ok) throw new Error(out.reason);
    expect(sortTok(out.view)).toEqual(sortTok(viewFor(core().state, P1)));
  });

  it("già aggiornato: delta vuoto", () => {
    const { core } = setup();
    const v = core().state.version;
    expect(planResync(core().state, core().log, P1, { lastVersion: v, epoch: EPOCH })).toEqual({
      type: "delta",
      epoch: EPOCH,
      fromVersion: v,
      toVersion: v,
      events: [],
    });
  });

  const snapshotCases: [string, (c: CampaignCore) => { lastVersion: number | null; epoch: string | null; log?: CampaignCore["log"] }][] = [
    ["prima connessione", () => ({ lastVersion: null, epoch: null })],
    ["epoca diversa (ripristino da backup)", () => ({ lastVersion: 0, epoch: "altra" })],
    ["versione dal futuro", (c) => ({ lastVersion: c.state.version + 5, epoch: EPOCH })],
    ["registro svuotato (riavvio del server)", () => ({ lastVersion: 0, epoch: EPOCH, log: createEventLog(EPOCH) })],
    [
      "registro troppo corto",
      (c) => {
        let log = createEventLog(EPOCH, 2);
        for (const e of c.log.entries) log = appendToLog(log, e.version, e.changes);
        return { lastVersion: 0, epoch: EPOCH, log };
      },
    ],
  ];
  for (const [name, make] of snapshotCases) {
    it(`snapshot: ${name}`, () => {
      const { core } = setup();
      const req = make(core());
      const msg: ServerMessage = planResync(core().state, req.log ?? core().log, P1, req);
      expect(msg.type).toBe("snapshot");
      if (msg.type !== "snapshot") return;
      expect(msg.view).toEqual(viewFor(core().state, P1));
      expect(msg.version).toBe(core().state.version);
      expectNoLeak(JSON.stringify(msg), [SECRET.hiddenOgreId, "AncoraNascostoXYZ", SECRET.prepDragonName, SECRET.notesOrc]);
    });
  }

  it("il registro scarta le voci con versioni non consecutive", () => {
    let log = createEventLog(EPOCH);
    log = appendToLog(log, 1, []);
    log = appendToLog(log, 2, []);
    log = appendToLog(log, 5, []);
    expect(log.entries.map((e) => e.version)).toEqual([5]);
  });

  it("il client rifiuta delta con buco o epoca diversa", () => {
    const view = viewFor(baseState(), P1);
    const base: DeltaMessage = { type: "delta", epoch: EPOCH, fromVersion: 0, toVersion: 1, events: [] };
    expect(applyDelta(view, EPOCH, { ...base, fromVersion: 3 })).toEqual({ ok: false, reason: "gap" });
    expect(applyDelta(view, "altra", base)).toEqual({ ok: false, reason: "epoch" });
    expect(applyDelta(view, EPOCH, base)).toMatchObject({ ok: true });
  });

  it("riconnessione dopo cambio di scena", () => {
    let core = createCore(baseState(), EPOCH);
    const gm = connect(core, GM);
    const p1view = viewFor(core.state, P1);
    core = serve(core, [gm], gm, { type: "command", requestId: "a", command: { type: "scene.activate", sceneId: PREP } });
    core = serve(core, [gm], gm, { type: "command", requestId: "b", command: { type: "token.update", tokenId: SECRET.prepDragonId, patch: { hidden: true } } });
    core = serve(core, [gm], gm, { type: "command", requestId: "c", command: { type: "scene.activate", sceneId: MAIN } });
    const msg = planResync(core.state, core.log, P1, { lastVersion: 0, epoch: EPOCH });
    if (msg.type !== "delta") throw new Error("atteso delta");
    const out = applyDelta(p1view, EPOCH, msg);
    if (!out.ok) throw new Error(out.reason);
    expect(sortTok(out.view)).toEqual(sortTok(viewFor(core.state, P1)));
    // Il drago è stato visibile per un momento (scena PREP attiva): questo è legittimo,
    // ma la scena PREP non deve restare nella vista.
    expect(out.view.scenes.map((s) => s.id)).toEqual([MAIN]);
  });
});
