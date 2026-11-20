import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDelta,
  type CampaignView,
  type Command,
  type RandomInt,
  type ServerEvent,
  type ServerMessage,
} from "@lanterna/shared";
import { MAIN, PREP, command, createTable, hello, populate, send, token, type Table } from "../test/campaign.js";
import { createTestApp, type TestContext } from "../test/helpers.js";
import { WsClient, listen, settle } from "../test/ws.js";

/**
 * Combattimento (M7) con WebSocket reali: GM + 2 giocatori. Iniziativa tirata dal server con un RNG
 * iniettato, turni, effetti con avvisi, azioni di gruppo, forme effimere con la nebbia, nessuna fuga nel
 * traffico dei giocatori e riavvio con lo stato salvato.
 */

const S = {
  hiddenName: "MostroNascostoCombatXYZ",
  entry: "VoceNascostaCombatXYZ",
  effect: "EffettoSegretoCombatXYZ",
  faction: "FazioneSegretaCombatXYZ",
  group: "GruppoSegretoCombatXYZ",
  hiddenInit: 987,
  monsterInit: 654,
} as const;

let queued: number[] = [];
const rng: RandomInt = (max) => {
  const v = queued.shift() ?? 0;
  if (v >= max) throw new Error(`valore ${v} non valido per ${max}`);
  return v;
};

let ctx: TestContext | undefined;
let clients: WsClient[] = [];
const files: string[] = [];

afterEach(async () => {
  for (const c of clients) c.ws.terminate();
  clients = [];
  await ctx?.close();
  ctx = undefined;
  for (const f of files.splice(0)) rmSync(f, { recursive: true, force: true });
  queued = [];
});

interface Setup {
  t: Table;
  port: number;
  gm: WsClient;
  p1: WsClient;
  p2: WsClient;
}

async function setup(env: NodeJS.ProcessEnv = {}, persistent?: { dbPath: string; uploadDir: string }): Promise<Setup> {
  ctx = await createTestApp(env, undefined, persistent, { rng });
  const t = await createTable(ctx);
  const port = await listen(ctx);
  const gm = await WsClient.connect(port, { cookie: t.gm.cookie });
  clients.push(gm);
  await hello(gm, t.campaignId);
  await populate(gm, t);
  for (const c of [
    token("tok-a", { name: "Goblin A", x: 455 }),
    token("tok-b", { name: "Goblin B", x: 525, faction: S.faction, health: { current: 7, max: 7, temp: 0 } }),
    token("tok-m", { name: S.hiddenName, x: 595, hidden: true }),
  ]) {
    expect((await command(gm, { type: "token.create", token: c })).type).toBe("ack");
  }
  const p1 = await WsClient.connect(port, { cookie: t.p1.cookie });
  const p2 = await WsClient.connect(port, { cookie: t.p2.cookie });
  clients.push(p1, p2);
  await hello(p1, t.campaignId);
  await hello(p2, t.campaignId);
  return { t, port, gm, p1, p2 };
}

const ok = async (c: WsClient, cmd: Command | Record<string, unknown>) => {
  const r = await command(c, cmd);
  if (r.type !== "ack") throw new Error(`${(cmd as { type: string }).type}: ${JSON.stringify(r)}`);
  return r;
};

const entry = (id: string, tokenId: string | null, initiative: number | null, over: Record<string, unknown> = {}) => ({
  id,
  tokenId,
  name: tokenId ? null : `Libero ${id}`,
  initiative,
  hidden: false,
  hideInitiative: false,
  ...over,
});

const eff = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Effetto ${id}`,
  condition: null,
  remaining: 2,
  timing: "end",
  turnOf: null,
  secret: false,
  ...over,
});

/** Tutti gli eventi dei delta ricevuti da un client. */
function events(c: WsClient): ServerEvent[] {
  return c.messages.flatMap((m) => (m.type === "delta" ? m.events : []));
}

async function request(c: WsClient, msg: Record<string, unknown>) {
  const requestId = randomUUID();
  c.send({ ...msg, requestId });
  return c.next<Extract<ServerMessage, { type: "ack" | "error" }>>((m) => (m.type === "ack" || m.type === "error") && m.requestId === requestId);
}

/** Combattimento di base: PG1 (18), PG2 (14), Goblin A (12, iniziativa nascosta), Goblin B (9), mostro nascosto, voce nascosta. */
async function fightSetup(s: Setup): Promise<void> {
  const add = (p: Record<string, unknown>) => ok(s.gm, { type: "combat.add", sceneId: MAIN, participant: p });
  await add(entry("pa", "tok-p1", 18));
  await add(entry("pb", "tok-p2", 14));
  await add(entry("pc", "tok-a", S.monsterInit, { hideInitiative: true }));
  await add(entry("pd", "tok-b", 9));
  await add(entry("pe", "tok-m", S.hiddenInit));
  await add(entry("pf", null, 5, { hidden: true, name: S.entry }));
}

describe("iniziativa tirata dal server", () => {
  it("il GM tira con l'RNG del server (d20 + bonus, vantaggio), i giocatori no", async () => {
    const s = await setup();
    await ok(s.gm, { type: "combat.add", sceneId: MAIN, participant: entry("pa", "tok-p1", null) });
    await ok(s.gm, { type: "combat.add", sceneId: MAIN, participant: entry("pb", "tok-p2", null) });
    await ok(s.gm, { type: "combat.add", sceneId: MAIN, participant: entry("pc", "tok-a", null) });
    // Un giocatore non può tirare l'iniziativa di nessuno (FORBIDDEN, anche con id inventati).
    const denied = await request(s.p1, { type: "initiative.roll", sceneId: "ghost", rolls: [{ participantId: "x", bonus: 9 }] });
    expect(denied).toMatchObject({ type: "error", code: "FORBIDDEN" });
    expect(queued).toEqual([]);

    queued = [9, 3, 18, 1]; // pa: 10+2, pb: 4+4 (vantaggio: 3,18 -> 19) ... vedi sotto
    // pa: d20 = 10 -> +2 = 12 ; pb (vantaggio): dadi 4 e 19 -> 19 +0 ; pc (svantaggio): 2 e 6 -> 2 -> +5 = 7
    queued = [9, 3, 18, 1, 5];
    const r = await request(s.gm, {
      type: "initiative.roll",
      sceneId: MAIN,
      sort: true,
      rolls: [
        { participantId: "pa", bonus: 2 },
        { participantId: "pb", bonus: 0, mode: "advantage" },
        { participantId: "pc", bonus: 5, mode: "disadvantage" },
      ],
    });
    expect(r.type).toBe("ack");
    const c = ctx!.app.realtime.stateOf(s.t.campaignId)!.state.combats![0]!;
    // pa: 9+1+2 = 12; pb: max(3+1, 18+1) = 19; pc: min(1+1, 5+1) + 5 = 7
    expect(c.participants.map((p) => [p.id, p.initiative])).toEqual([["pb", 19], ["pa", 12], ["pc", 7]]);
    expect(queued).toEqual([]);
    // Un solo passo di annulla ripristina tutti i valori.
    const u = await send(s.gm, { type: "undo" });
    expect(u.type).toBe("ack");
    expect(ctx!.app.realtime.stateOf(s.t.campaignId)!.state.combats![0]!.participants.map((p) => p.initiative)).toEqual([null, null, null]);
  });

  it("partecipante inesistente: errore e nessun cambiamento", async () => {
    const s = await setup();
    await ok(s.gm, { type: "combat.add", sceneId: MAIN, participant: entry("pa", "tok-p1", null) });
    const before = ctx!.app.realtime.stateOf(s.t.campaignId)!.state.version;
    const r = await request(s.gm, { type: "initiative.roll", sceneId: MAIN, rolls: [{ participantId: "zz", bonus: 1 }] });
    expect(r).toMatchObject({ type: "error", code: "NOT_FOUND" });
    expect(ctx!.app.realtime.stateOf(s.t.campaignId)!.state.version).toBe(before);
  });

  it("l'app di produzione usa crypto.randomInt per l'iniziativa", async () => {
    const real = await createTestApp();
    try {
      const { randomInt } = await import("../dice/crypto-rng.js");
      expect(real.app.realtime.rng).toBe(randomInt);
    } finally {
      await real.close();
    }
  });
});

describe("tracker, turni ed effetti nel traffico dei giocatori", () => {
  it("i giocatori non ricevono voci o iniziative nascoste, né gruppi, fazioni o effetti segreti", async () => {
    const s = await setup();
    await fightSetup(s);
    await ok(s.gm, { type: "group.create", group: { id: "g1", name: S.group, tokenIds: ["tok-a", "tok-b"] } });
    await ok(s.gm, { type: "effect.add", tokenId: "tok-p1", effect: eff("sec", { name: S.effect, secret: true }) });
    await ok(s.gm, { type: "effect.add", tokenId: "tok-p1", effect: eff("pub", { name: "Benedizione" }) });
    await ok(s.gm, { type: "combat.start", sceneId: MAIN });
    for (let i = 0; i < 6; i++) await ok(s.gm, { type: "combat.next", sceneId: MAIN });
    await ok(s.gm, { type: "token.update", tokenId: "tok-m", patch: { name: `${S.hiddenName}2` } });
    await ok(s.gm, { type: "group.apply", target: { kind: "group", groupId: "g1" }, action: { kind: "damage", amount: 3 } });
    await settle();
    // Un giocatore che si riconnette riceve lo snapshot, anch'esso senza segreti.
    const p1b = await WsClient.connect(s.port, { cookie: s.t.p1.cookie });
    clients.push(p1b);
    await hello(p1b, s.t.campaignId);
    await settle();
    for (const c of [s.p1, s.p2, p1b]) {
      const traffic = c.traffic();
      for (const secret of [S.hiddenName, S.entry, S.effect, S.faction, S.group, `"initiative":${S.hiddenInit}`, `"initiative":${S.monsterInit}`, "tok-m", '"pe"', '"pf"', "hideInitiative", '"faction"', '"groups"']) {
        expect(traffic, `trapela ${secret}`).not.toContain(secret);
      }
    }
    // Il GM vede tutto.
    const gmTraffic = s.gm.traffic();
    for (const secret of [S.entry, S.effect, S.faction, S.group]) expect(gmTraffic).toContain(secret);
    // I giocatori vedono invece il tracker pubblico.
    const view = (await hello(s.p2, s.t.campaignId)) as Extract<ServerMessage, { type: "snapshot" | "delta" }>;
    if (view.type !== "snapshot" && view.type !== "delta") throw new Error("risposta inattesa");
    const snap = view.type === "snapshot" ? view.view : null;
    if (snap) {
      const c = snap.combats![0]!;
      expect(c.participants.map((p) => p.id)).toEqual(["pa", "pb", "pc", "pd"]);
      expect(c.participants.find((p) => p.id === "pc")!.initiative).toBeNull();
      expect(c.participants.find((p) => p.id === "pa")!.initiative).toBe(18);
    }
  });

  it("avvisi: il turno solo a GM e proprietario; l'effetto che scade solo al proprietario e al GM", async () => {
    const s = await setup();
    await ok(s.gm, { type: "combat.add", sceneId: MAIN, participant: entry("pa", "tok-p1", 18) });
    await ok(s.gm, { type: "combat.add", sceneId: MAIN, participant: entry("pb", "tok-p2", 10) });
    await ok(s.gm, { type: "effect.add", tokenId: "tok-p1", effect: eff("e1", { remaining: 1, timing: "end", name: "Scudo" }) });
    await ok(s.gm, { type: "combat.start", sceneId: MAIN });
    await settle();
    const kinds = (c: WsClient) => events(c).map((e) => e.type).filter((t) => t === "combat.turn" || t.startsWith("effect."));
    // Alla partenza è il turno di pa (tok-p1): l'effetto scade alla fine di questo turno -> "in arrivo".
    expect(kinds(s.p1)).toEqual(["effect.expiring", "combat.turn"]);
    expect(kinds(s.p2)).toEqual([]);
    expect(kinds(s.gm)).toEqual(["effect.expiring", "combat.turn"]);
    await ok(s.gm, { type: "combat.next", sceneId: MAIN });
    await settle();
    expect(kinds(s.p1)).toEqual(["effect.expiring", "combat.turn", "effect.expired"]);
    expect(kinds(s.p2)).toEqual(["combat.turn"]);
    expect(events(s.p1).find((e) => e.type === "effect.expired")).toMatchObject({ tokenId: "tok-p1", effectId: "e1", name: "Scudo", reason: "elapsed" });
    // Sull'effetto scaduto il token del giocatore non lo mostra più.
    const tokenView = (c: WsClient) => {
      const snap = c.messages.find((m) => m.type === "snapshot");
      if (!snap || snap.type !== "snapshot") throw new Error("snapshot");
      let view: CampaignView = snap.view;
      let epoch = snap.epoch;
      for (const m of c.messages) if (m.type === "delta") {
        const r = applyDelta(view, epoch, m);
        if (r.ok) view = r.view;
        epoch = m.epoch;
      }
      return view.tokens.find((t) => t.id === "tok-p1")!;
    };
    expect(tokenView(s.p1).effects).toEqual([]);
  });

  it("combat.next è riservato al GM; il giocatore non può tirare per sé né avviare il combattimento", async () => {
    const s = await setup();
    await fightSetup(s);
    const before = ctx!.app.realtime.stateOf(s.t.campaignId)!.state;
    for (const cmd of [
      { type: "combat.start", sceneId: MAIN },
      { type: "combat.update", sceneId: MAIN, participantId: "pa", patch: { initiative: 99 } },
      { type: "combat.remove", sceneId: MAIN, participantId: "pa" },
      { type: "effect.add", tokenId: "tok-p1", effect: eff("x") },
      { type: "group.create", group: { id: "g", name: "g", tokenIds: ["tok-p1"] } },
      { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-p1"] }, action: { kind: "heal", amount: 5 } },
      { type: "group.apply", target: { kind: "category", sceneId: MAIN, tokenKind: "pc" }, action: { kind: "move", dx: 1, dy: 1 } },
    ]) {
      const r = await command(s.p1, cmd);
      expect(r, JSON.stringify(cmd)).toMatchObject({ type: "error", code: "FORBIDDEN" });
    }
    expect(ctx!.app.realtime.stateOf(s.t.campaignId)!.state).toEqual(before);
  });
});

describe("azioni di gruppo via WebSocket", () => {
  it("danno di gruppo atomico: i delta arrivano a chi può vederli, un annulla ripristina tutto", async () => {
    const s = await setup();
    await ok(s.gm, { type: "token.update", tokenId: "tok-a", patch: { health: { current: 6, max: 6, temp: 0 } } });
    await ok(s.gm, { type: "group.create", group: { id: "g1", name: "Goblin", tokenIds: ["tok-a", "tok-b"] } });
    const v0 = ctx!.app.realtime.stateOf(s.t.campaignId)!.state;
    s.p1.skip();
    const r = await ok(s.gm, { type: "group.apply", target: { kind: "group", groupId: "g1" }, action: { kind: "damage", amount: 6 } });
    expect(r.version).toBe(v0.version + 1);
    const st = ctx!.app.realtime.stateOf(s.t.campaignId)!.state;
    expect(st.tokens.find((t) => t.id === "tok-a")!.health).toEqual({ current: 0, max: 6, temp: 0 });
    expect(st.tokens.find((t) => t.id === "tok-b")!.health).toEqual({ current: 1, max: 7, temp: 0 });
    expect(st.tokens.find((t) => t.id === "tok-a")!.conditions.map((c) => c.id)).toEqual(["dead"]);
    await settle();
    // Una sola versione (un solo delta) per tutta l'azione; i giocatori vedono le condizioni (Morto) ma non i PF.
    const deltas = s.p1.messages.filter((m) => m.type === "delta");
    expect(deltas).toHaveLength(1);
    expect(s.p1.traffic()).toContain('"dead"');
    expect(JSON.stringify(deltas)).not.toContain('"health":{"current"');
    const u = await send(s.gm, { type: "undo" });
    expect(u.type).toBe("ack");
    expect(ctx!.app.realtime.stateOf(s.t.campaignId)!.state.tokens).toEqual(v0.tokens);
  });

  it("azione di gruppo rifiutata in blocco (un token fuori mappa): nessun cambiamento e nessun delta", async () => {
    const s = await setup();
    s.p1.skip();
    const before = ctx!.app.realtime.stateOf(s.t.campaignId)!.state;
    const r = await command(s.gm, { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-a", "tok-b"] }, action: { kind: "move", dx: 5000, dy: 0 } });
    expect(r).toMatchObject({ type: "error", code: "INVALID" });
    await settle();
    expect(ctx!.app.realtime.stateOf(s.t.campaignId)!.state).toEqual(before);
    expect(s.p1.messages.filter((m) => m.type === "delta")).toHaveLength(0);
  });

  it("il giocatore muove di gruppo solo i propri token e annulla la propria azione", async () => {
    const s = await setup();
    const own = { kind: "tokens", tokenIds: ["tok-p1"] };
    expect((await command(s.p1, { type: "group.apply", target: own, action: { kind: "move", dx: 70, dy: 0 } })).type).toBe("ack");
    expect(ctx!.app.realtime.stateOf(s.t.campaignId)!.state.tokens.find((t) => t.id === "tok-p1")!.x).toBe(175);
    expect((await command(s.p1, { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-p2"] }, action: { kind: "move", dx: 70, dy: 0 } }))).toMatchObject({ type: "error", code: "FORBIDDEN" });
    expect((await send(s.p1, { type: "undo" })).type).toBe("ack");
    expect(ctx!.app.realtime.stateOf(s.t.campaignId)!.state.tokens.find((t) => t.id === "tok-p1")!.x).toBe(105);
    // il token nascosto è indistinguibile da uno inesistente
    const hidden = await command(s.p1, { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-m"] }, action: { kind: "move", dx: 1, dy: 1 } });
    const ghost = await command(s.p1, { type: "group.apply", target: { kind: "tokens", tokenIds: ["tok-ghost"] }, action: { kind: "move", dx: 1, dy: 1 } });
    expect(hidden).toMatchObject({ type: "error", code: "NOT_FOUND" });
    expect({ ...hidden, requestId: null }).toEqual({ ...ghost, requestId: null });
  });
});

describe("forme effimere (righello, cono, frecce, ping)", () => {
  const ruler = (over: Record<string, unknown> = {}) => ({
    type: "ephemeral.show",
    id: "m1",
    sceneId: MAIN,
    audience: "all",
    shape: { kind: "ruler", points: [{ x: 100.125, y: 100.125 }, { x: 300.375, y: 100.125 }] },
    ...over,
  });
  const shown = (c: WsClient) => c.messages.filter((m) => m.type === "ephemeral.shown");
  const cleared = (c: WsClient) => c.messages.filter((m) => m.type === "ephemeral.cleared");

  it("pubblico: arriva a tutti tranne all'autore; privato: nessun evento; gm: solo al GM", async () => {
    const s = await setup();
    expect((await request(s.p1, ruler())).type).toBe("ack");
    await settle();
    expect(shown(s.gm)).toHaveLength(1);
    expect(shown(s.p2)).toHaveLength(1);
    expect(shown(s.p1)).toHaveLength(0);
    expect(shown(s.p2)[0]).toMatchObject({ id: "m1", authorId: s.t.p1.id, sceneId: MAIN, ttlMs: 10_000, shape: { kind: "ruler" } });
    // privata: ack ma nessun evento a nessuno
    expect((await request(s.p1, ruler({ id: "m2", audience: "private" }))).type).toBe("ack");
    await settle();
    expect(shown(s.gm)).toHaveLength(1);
    expect(shown(s.p2)).toHaveLength(1);
    // solo GM
    expect((await request(s.p1, ruler({ id: "m3", audience: "gm", shape: { kind: "arrow", x1: 1, y1: 1, x2: 50, y2: 50 } }))).type).toBe("ack");
    await settle();
    expect(shown(s.gm)).toHaveLength(2);
    expect(shown(s.p2)).toHaveLength(1);
  });

  it("scadenza: ttl predefinito per tipo e personalizzato; limiti rifiutati", async () => {
    const s = await setup();
    await request(s.gm, ruler({ id: "k1", shape: { kind: "ping", x: 10, y: 10 } }));
    await request(s.gm, ruler({ id: "k2", ttlMs: 1500 }));
    await settle();
    const ttls = shown(s.p1).map((m) => (m as { id: string; ttlMs: number }).ttlMs);
    expect(ttls).toEqual([4000, 1500]);
    expect(await request(s.gm, ruler({ id: "k3", ttlMs: 999_999 }))).toMatchObject({ type: "error", code: "INVALID" });
    expect(await request(s.gm, ruler({ id: "k4", ttlMs: 5 }))).toMatchObject({ type: "error", code: "INVALID" });
  });

  it("clear: avvisa solo chi aveva ricevuto la forma; sostituzione con lo stesso id", async () => {
    const s = await setup();
    await request(s.p1, ruler());
    await request(s.p1, ruler({ shape: { kind: "ruler", points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] } })); // stesso id: sostituisce
    await settle();
    expect(shown(s.p2)).toHaveLength(2);
    expect((await request(s.p1, { type: "ephemeral.clear", id: "m1" })).type).toBe("ack");
    await settle();
    expect(cleared(s.p2)).toHaveLength(1);
    expect(cleared(s.gm)).toHaveLength(1);
    // clear di una forma inesistente o altrui: ack ma nessun avviso
    expect((await request(s.p2, { type: "ephemeral.clear", id: "m1" })).type).toBe("ack");
    expect((await request(s.p1, { type: "ephemeral.clear", id: "mai" })).type).toBe("ack");
    await settle();
    expect(cleared(s.p1)).toHaveLength(0);
    expect(cleared(s.gm)).toHaveLength(1);
  });

  it("un giocatore può usare solo la scena attiva e dentro la mappa; il GM qualsiasi scena", async () => {
    const s = await setup();
    const other = await request(s.p1, ruler({ sceneId: PREP }));
    const ghost = await request(s.p1, ruler({ sceneId: "ghost" }));
    expect(other).toMatchObject({ type: "error", code: "NOT_FOUND" });
    expect({ ...other, requestId: null }).toEqual({ ...ghost, requestId: null });
    expect(await request(s.p1, ruler({ shape: { kind: "ping", x: 99999, y: 1 } }))).toMatchObject({ type: "error", code: "INVALID" });
    expect((await request(s.gm, ruler({ id: "g1", sceneId: PREP }))).type).toBe("ack");
    await settle();
    // la scena segreta non è visibile ai giocatori: non ricevono nulla
    expect(shown(s.p1)).toHaveLength(0);
    expect(shown(s.p2)).toHaveLength(0);
    expect(s.p1.traffic()).not.toContain("scn-prep");
  });

  it("rate limit per utente", async () => {
    const s = await setup({ EPHEMERAL_PER_SECOND: "1", EPHEMERAL_BURST: "3" });
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await request(s.p1, ruler({ id: `r${i}`, shape: { kind: "ping", x: 10, y: 10 } }));
      results.push(r.type === "ack" ? "ack" : (r as { code: string }).code);
    }
    expect(results.slice(0, 3)).toEqual(["ack", "ack", "ack"]);
    expect(results).toContain("RATE_LIMITED");
    // il GM ha il suo limite
    expect((await request(s.gm, ruler({ id: "gm1" }))).type).toBe("ack");
  });

  it("al massimo 8 forme vive per utente: la più vecchia viene tolta", async () => {
    const s = await setup();
    for (let i = 0; i < 9; i++) await request(s.p1, ruler({ id: `v${i}`, shape: { kind: "ping", x: 10 + i, y: 10 } }));
    await settle();
    expect(shown(s.p2)).toHaveLength(9);
    expect(cleared(s.p2).map((m) => (m as { id: string }).id)).toEqual(["v0"]);
  });

  it("forme di messaggi malformati: nessuna eccezione, errore INVALID", async () => {
    const s = await setup();
    s.p1.send({ type: "ephemeral.show", requestId: "r", id: "x", sceneId: MAIN, audience: "all", shape: { kind: "circle", x: 1, y: 1, radius: -5 } });
    const e = await s.p1.next<Extract<ServerMessage, { type: "error" }>>((m) => m.type === "error");
    expect(e.code).toBe("INVALID");
  });

  describe("con la nebbia", () => {
    /** Nebbia con la scena 1400x1000, celle da 70: P1 vede la colonna di sinistra (0..210), P2 quella di destra (1190..1400). */
    async function foggy() {
      const s = await setup();
      await ok(s.gm, { type: "fog.enable", sceneId: MAIN, initial: "covered" });
      await ok(s.gm, { type: "fog.reveal", sceneId: MAIN, shape: { kind: "rect", x: 0, y: 0, width: 210, height: 1000 }, target: { kind: "players", userIds: [s.t.p1.id] } });
      await ok(s.gm, { type: "fog.reveal", sceneId: MAIN, shape: { kind: "rect", x: 1190, y: 0, width: 210, height: 1000 }, target: { kind: "players", userIds: [s.t.p2.id] } });
      s.p1.skip();
      s.p2.skip();
      return s;
    }

    it("un ping in una zona non rivelata a un destinatario non gli arriva; a chi la vede sì", async () => {
      const s = await foggy();
      // P1 segnala nella zona di P2: P2 lo riceve, il GM pure.
      expect((await request(s.p1, ruler({ id: "pg", shape: { kind: "ping", x: 1260.75, y: 345.5 } }))).type).toBe("ack");
      await settle();
      expect(shown(s.p2)).toHaveLength(1);
      expect(shown(s.gm)).toHaveLength(1);
      // P1 segnala nella propria zona: P2 non riceve nulla (e nemmeno le coordinate).
      expect((await request(s.p1, ruler({ id: "pm", shape: { kind: "ping", x: 100.25, y: 345.5 } }))).type).toBe("ack");
      await settle();
      expect(shown(s.p2)).toHaveLength(1);
      expect(s.p2.traffic()).not.toContain("100.25");
      // Una zona coperta a entrambi: nessun giocatore, solo il GM.
      await request(s.gm, ruler({ id: "pc", shape: { kind: "ping", x: 700.5, y: 500.5 } }));
      await settle();
      expect(shown(s.p1)).toHaveLength(0);
      expect(shown(s.p2)).toHaveLength(1);
      expect(s.p1.traffic()).not.toContain("700.5");
      expect(s.p2.traffic()).not.toContain("700.5");
    });

    it("un righello che attraversa zone diverse arriva ritagliato alle sole celle rivelate al destinatario", async () => {
      const s = await foggy();
      // dal bordo sinistro (rivelato a P1) fino al centro (coperto): P1 lo ha disegnato, il GM lo riceve intero.
      const shape = { kind: "ruler", points: [{ x: 35.125, y: 35.125 }, { x: 733.875, y: 35.125 }] };
      expect((await request(s.p1, ruler({ id: "rl", shape }))).type).toBe("ack");
      await settle();
      const gmGot = shown(s.gm)[0] as { shape: { kind: string; points: { x: number }[] } };
      expect(gmGot.shape.kind).toBe("ruler");
      expect(gmGot.shape.points[1]!.x).toBe(733.875);
      // P2 non vede nessuna di quelle celle (colonne 0..9): non riceve nulla
      expect(shown(s.p2)).toHaveLength(0);
      expect(s.p2.traffic()).not.toContain("733.875");
      // Il GM disegna un righello da sinistra a destra: P1 riceve solo le celle sue, P2 solo le sue.
      const wide = { kind: "ruler", points: [{ x: 35.5, y: 35.5 }, { x: 1365.5, y: 35.5 }] };
      await request(s.gm, ruler({ id: "wide", shape: wide }));
      await settle();
      const g1 = shown(s.p1).at(-1) as { shape: { kind: string; cells: number[] } };
      const g2 = shown(s.p2).at(-1) as { shape: { kind: string; cells: number[] } };
      expect(g1.shape.kind).toBe("cells");
      expect(g2.shape.kind).toBe("cells");
      const cols = (cells: number[]) => cells.filter((_, i) => i % 2 === 0);
      expect(Math.max(...cols(g1.shape.cells))).toBeLessThanOrEqual(2); // colonne 0..2 (0..210 px)
      expect(Math.min(...cols(g2.shape.cells))).toBeGreaterThanOrEqual(17); // colonne 17..19 (1190..1400 px)
      for (const c of [s.p1, s.p2]) {
        expect(c.traffic()).not.toContain("1365.5");
        expect(c.traffic()).not.toContain("35.5,");
      }
    });

    it("la forma sostituita non lascia una vecchia versione a chi non la riceve più", async () => {
      const s = await foggy();
      await request(s.p1, ruler({ id: "mv", shape: { kind: "ping", x: 1260.5, y: 100.5 } })); // P2 la vede
      await settle();
      expect(shown(s.p2)).toHaveLength(1);
      await request(s.p1, ruler({ id: "mv", shape: { kind: "ping", x: 100.5, y: 100.5 } })); // ora solo P1: P2 la deve togliere
      await settle();
      expect(cleared(s.p2)).toHaveLength(1);
      expect(shown(s.p2)).toHaveLength(1);
    });
  });
});

describe("riavvio", () => {
  it("combattimento, effetti, gruppi e fazioni sopravvivono al riavvio e il combattimento prosegue", async () => {
    const dbPath = join(tmpdir(), `lanterna-combat-${randomUUID()}.db`);
    const uploadDir = join(tmpdir(), `lanterna-combat-up-${randomUUID()}`);
    files.push(uploadDir, dbPath, `${dbPath}-wal`, `${dbPath}-shm`);
    const persistent = { dbPath, uploadDir };
    const s = await setup({}, persistent);
    await fightSetup(s);
    await ok(s.gm, { type: "group.create", group: { id: "g1", name: S.group, tokenIds: ["tok-a", "tok-b"] } });
    await ok(s.gm, { type: "effect.add", tokenId: "tok-p1", effect: eff("e1", { remaining: 3, condition: { id: "stunned", name: "Stordito" } }) });
    await ok(s.gm, { type: "combat.start", sceneId: MAIN });
    await ok(s.gm, { type: "combat.next", sceneId: MAIN });
    await ok(s.gm, { type: "combat.next", sceneId: MAIN });
    const before = ctx!.app.realtime.stateOf(s.t.campaignId)!.state;
    const p2fresh = await WsClient.connect(s.port, { cookie: s.t.p2.cookie });
    clients.push(p2fresh);
    const viewP2 = (await hello(p2fresh, s.t.campaignId)) as Extract<ServerMessage, { type: "snapshot" }>;
    expect(viewP2.type).toBe("snapshot");
    for (const c of clients) c.close();
    clients = [];
    await ctx!.close();

    ctx = await createTestApp({}, undefined, persistent, { rng });
    const after = ctx.app.realtime.stateOf(s.t.campaignId)!.state;
    expect(after.combats).toEqual(before.combats);
    expect(after.groups).toEqual(before.groups);
    expect(after.tokens).toEqual(before.tokens);
    expect(after.version).toBe(before.version);
    const port = await listen(ctx);
    const gm = await WsClient.connect(port, { cookie: s.t.gm.cookie });
    const p2 = await WsClient.connect(port, { cookie: s.t.p2.cookie });
    clients.push(gm, p2);
    const snap2 = await hello(p2, s.t.campaignId);
    await hello(gm, s.t.campaignId);
    if (snap2.type !== "snapshot") throw new Error("snapshot atteso");
    expect(snap2.view.combats).toEqual(viewP2.view.combats);
    expect(JSON.stringify(snap2)).not.toContain(S.entry);
    // Il combattimento prosegue: l'effetto scala al giro giusto.
    const r = await ok(gm, { type: "combat.next", sceneId: MAIN });
    expect(r.version).toBe(before.version + 1);
    const cur = ctx.app.realtime.stateOf(s.t.campaignId)!.state;
    expect(cur.combats![0]!.turnId).toBe("pb");
    // Un client rimasto indietro riprende con il registro anche dopo il riavvio.
    const late = await WsClient.connect(port, { cookie: s.t.p1.cookie });
    clients.push(late);
    const ok2 = await hello(late, s.t.campaignId, before.version, snap2.epoch);
    expect(ok2.type).toBe("delta");
    if (ok2.type === "delta") expect(ok2.events.some((e) => e.type === "combat.updated")).toBe(true);
  });
});
