import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  parseFormula,
  type ChatEntry,
  type HistoryMessage,
  type RandomInt,
  type RollEntry,
  type ServerMessage,
  type SessionLogExport,
} from "@lanterna/shared";
import { randomInt as cryptoRandomInt } from "../dice/crypto-rng.js";
import { ORIGIN, createTestApp, loginAs, type TestContext } from "../test/helpers.js";
import { addMemberAs, createTable, hello, type Table } from "../test/campaign.js";
import { WsClient, listen, settle } from "../test/ws.js";

let ctx: TestContext;
const clients: WsClient[] = [];
const cleanup: (() => void)[] = [];

/** RNG deterministico iniettato nell'app: restituisce i valori in coda (0 se vuota). */
let queued: number[] = [];
const rng: RandomInt = (max) => {
  const v = queued.shift() ?? 0;
  if (v >= max) throw new Error(`valore ${v} non valido per ${max}`);
  return v;
};

beforeEach(() => {
  queued = [];
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await ctx?.close();
  for (const f of cleanup.splice(0)) f();
});

async function connect(port: number, cookie: string) {
  const c = await WsClient.connect(port, { cookie });
  clients.push(c);
  return c;
}

/** `hello` e attesa della cronologia iniziale. */
async function join_(c: WsClient, campaignId: string): Promise<HistoryMessage> {
  const r = await hello(c, campaignId);
  expect(r.type).toBe("snapshot");
  return c.nextOfType("history");
}

/** GM e due giocatori connessi, con RNG deterministico. */
async function table(env: NodeJS.ProcessEnv = {}, persistent?: { dbPath: string; uploadDir: string }) {
  ctx = await createTestApp(env, undefined, persistent, { rng });
  const port = await listen(ctx);
  const t = await createTable(ctx);
  const gm = await connect(port, t.gm.cookie);
  const p1 = await connect(port, t.p1.cookie);
  const p2 = await connect(port, t.p2.cookie);
  for (const c of [gm, p1, p2]) await join_(c, t.campaignId);
  return { port, t, gm, p1, p2 };
}

type Reply = Extract<ServerMessage, { requestId: string | null }>;

/** Invia una richiesta e attende la risposta con lo stesso requestId. */
async function request(c: WsClient, msg: Record<string, unknown>): Promise<Reply> {
  const requestId = randomUUID();
  c.send({ ...msg, requestId });
  return c.next<Reply>((m) => "requestId" in m && m.requestId === requestId);
}

const say = (c: WsClient, text: string, whisperTo?: string) =>
  request(c, { type: "chat.send", text, ...(whisperTo ? { whisperTo } : {}) });

const rollAs = (c: WsClient, formula: string, visibility: "public" | "gm" | "whisper", extra: Record<string, unknown> = {}) =>
  request(c, { type: "roll.request", formula, visibility, ...extra });

function frameCount(...cs: WsClient[]) {
  return cs.map((c) => c.frames.length);
}

describe("chat: pubblica e whisper", () => {
  it("messaggio pubblico a tutti; il requestId solo al mittente; testo semplice sanificato", async () => {
    const { t, gm, p1, p2 } = await table();
    const r = await say(p1, "  Ciao <b>a tutti</b>\u0000\u202E!  ");
    expect(r.type).toBe("chat.message");
    const entry = (r as Extract<ServerMessage, { type: "chat.message" }>).entry;
    expect(entry).toMatchObject({
      kind: "message",
      authorId: t.p1.id,
      visibility: "public",
      whisperTo: null,
      text: "Ciao <b>a tutti</b>!",
    });
    expect(typeof entry.at).toBe("number");
    for (const c of [gm, p2]) {
      const m = await c.nextOfType("chat.message");
      expect(m).toEqual({ type: "chat.message", requestId: null, entry });
    }
  });

  it("whisper giocatore → GM: solo i due lo ricevono; il terzo non vede nulla nel traffico", async () => {
    const { t, gm, p1, p2 } = await table();
    p2.skip();
    const before = frameCount(p2);
    const secret = "SUSSURRO-SEGRETO-XYZ";
    const r = await say(p1, secret, t.gm.id);
    expect(r).toMatchObject({ type: "chat.message", entry: { visibility: "whisper", whisperTo: t.gm.id, text: secret } });
    const id = (r as Extract<ServerMessage, { type: "chat.message" }>).entry.id;
    expect((await gm.nextOfType("chat.message")).entry.text).toBe(secret);
    await settle();
    expect(frameCount(p2)).toEqual(before);
    expect(p2.traffic()).not.toContain(secret);
    expect(p2.traffic()).not.toContain(id);
  });

  it("GM → giocatore: solo destinatario e GM", async () => {
    const { t, gm, p1, p2 } = await table();
    const before = frameCount(p2);
    const secret = "INDIZIO-PRIVATO-XYZ";
    expect((await say(gm, secret, t.p1.id)).type).toBe("chat.message");
    expect((await p1.nextOfType("chat.message")).entry).toMatchObject({ text: secret, whisperTo: t.p1.id });
    await settle();
    expect(frameCount(p2)).toEqual(before);
    expect(p2.traffic()).not.toContain(secret);
  });

  it("il GM non vede i whisper fra un giocatore e un altro GM", async () => {
    const { port, t, gm, p1 } = await table();
    const gm2 = await loginAs(ctx.app, "admin");
    await addMemberAs(ctx, t.gm.cookie, t.campaignId, gm2.user.id);
    // Il cambio di membri manda uno snapshot nuovo: si riparte dopo.
    await gm.nextOfType("snapshot");
    await p1.nextOfType("snapshot");
    const g2 = await connect(port, gm2.cookie);
    await join_(g2, t.campaignId);
    const before = frameCount(gm);
    const secret = "SOLO-PER-GM2-XYZ";
    expect((await say(p1, secret, gm2.user.id)).type).toBe("chat.message");
    expect((await g2.nextOfType("chat.message")).entry.text).toBe(secret);
    await settle();
    expect(frameCount(gm)).toEqual(before);
    expect(gm.traffic()).not.toContain(secret);
  });

  it("whisper non ammessi: verso un altro giocatore FORBIDDEN, a se stessi INVALID, a un non membro NOT_FOUND", async () => {
    const { t, gm, p1, p2 } = await table();
    const outsider = await loginAs(ctx.app, "player");
    const before = frameCount(gm, p2);
    expect(await say(p1, "psst", t.p2.id)).toMatchObject({ type: "error", code: "FORBIDDEN" });
    expect(await say(p1, "psst", t.p1.id)).toMatchObject({ type: "error", code: "INVALID" });
    expect(await say(p1, "psst", outsider.user.id)).toMatchObject({ type: "error", code: "NOT_FOUND" });
    expect(await say(gm, "psst", t.gm.id)).toMatchObject({ type: "error", code: "INVALID" });
    expect(await say(p1, " \u0000 \n ")).toMatchObject({ type: "error", code: "INVALID", message: "messaggio vuoto" });
    expect(await say(p1, "x".repeat(2001))).toMatchObject({ type: "error", code: "INVALID" });
    await settle();
    // Il GM ha ricevuto solo la risposta d'errore alla propria richiesta.
    expect(frameCount(gm, p2)).toEqual([before[0]! + 1, before[1]]);
    expect(gm.messages.some((m) => m.type === "chat.message")).toBe(false);
  });

  it("chat prima di hello: INVALID", async () => {
    ctx = await createTestApp({}, undefined, undefined, { rng });
    const port = await listen(ctx);
    const t = await createTable(ctx);
    const c = await connect(port, t.p1.cookie);
    expect(await say(c, "ciao")).toMatchObject({ type: "error", code: "INVALID", message: "serve prima hello" });
    expect(await request(c, { type: "history.request", before: null })).toMatchObject({ type: "error", code: "INVALID" });
  });
});

describe("tiri: esito sul server", () => {
  it("2d6+3 pubblico con dettaglio, dadi e totale, uguale per tutti", async () => {
    const { t, gm, p1, p2 } = await table();
    queued = [3, 4];
    const r = await rollAs(p1, "2d6+3", "public", { label: "Danni" });
    expect(r.type).toBe("roll.result");
    const entry = (r as Extract<ServerMessage, { type: "roll.result" }>).entry;
    expect(entry).toMatchObject({
      kind: "roll",
      authorId: t.p1.id,
      visibility: "public",
      whisperTo: null,
      label: "Danni",
      formula: "2d6+3",
      total: 12,
      detail: "2d6+3 → [4, 5] + 3 = 12",
      critical: false,
      criticalFailure: false,
      advantage: "normal",
    });
    expect(entry.terms[0]).toMatchObject({
      kind: "dice",
      dice: [
        { face: 6, value: 4, kept: true },
        { face: 6, value: 5, kept: true },
      ],
    });
    for (const c of [gm, p2]) expect((await c.nextOfType("roll.result")).entry).toEqual(entry);
  });

  it("vantaggio e svantaggio: d20 adv tiene il più alto, d20 dis il più basso; critico sul d20 deciso", async () => {
    const { p1 } = await table();
    queued = [4, 16];
    const adv = (await rollAs(p1, "d20 adv", "public")) as Extract<ServerMessage, { type: "roll.result" }>;
    expect(adv.entry).toMatchObject({ formula: "1d20 adv", advantage: "advantage", total: 17 });
    expect((adv.entry.terms[0] as { dice: unknown[] }).dice).toEqual([
      { face: 20, value: 5, kept: false },
      { face: 20, value: 17, kept: true },
    ]);
    queued = [4, 16];
    const dis = (await rollAs(p1, "d20+2 dis", "public")) as Extract<ServerMessage, { type: "roll.result" }>;
    expect(dis.entry).toMatchObject({ advantage: "disadvantage", total: 7 });
    queued = [0, 19];
    const crit = (await rollAs(p1, "1d20 adv", "public")) as Extract<ServerMessage, { type: "roll.result" }>;
    expect(crit.entry).toMatchObject({ total: 20, critical: true, criticalFailure: false });
  });

  it("tiro segreto del GM: solo al GM, nessuna traccia nel traffico dei giocatori", async () => {
    const { gm, p1, p2 } = await table();
    p1.skip();
    p2.skip();
    const before = frameCount(p1, p2);
    queued = [19];
    const r = await rollAs(gm, "1d20+987654", "gm", { label: "PERCEZIONE-SEGRETA" });
    expect(r).toMatchObject({ type: "roll.result", entry: { visibility: "gm", total: 987674, critical: true } });
    const id = (r as Extract<ServerMessage, { type: "roll.result" }>).entry.id;
    await settle();
    expect(frameCount(p1, p2)).toEqual(before);
    for (const c of [p1, p2]) {
      const traffic = c.traffic();
      for (const s of ["PERCEZIONE-SEGRETA", "987654", "987674", id]) expect(traffic).not.toContain(s);
    }
  });

  it("un giocatore non può fare tiri segreti (FORBIDDEN); può tirare in whisper al GM", async () => {
    const { t, gm, p1, p2 } = await table();
    const before = frameCount(gm, p2);
    expect(await rollAs(p1, "1d20", "gm")).toMatchObject({ type: "error", code: "FORBIDDEN" });
    expect(await rollAs(p1, "1d20", "whisper", { whisperTo: t.p2.id })).toMatchObject({ type: "error", code: "FORBIDDEN" });
    expect(await rollAs(p1, "1d20", "whisper")).toMatchObject({ type: "error", code: "INVALID" });
    expect(await rollAs(p1, "1d20", "public", { whisperTo: t.gm.id })).toMatchObject({ type: "error", code: "INVALID" });
    await settle();
    expect(frameCount(gm, p2)).toEqual(before);

    queued = [0];
    const r = await rollAs(p1, "1d20+876543", "whisper", { whisperTo: t.gm.id, label: "FURTIVITA-XYZ" });
    expect(r).toMatchObject({ type: "roll.result", entry: { visibility: "whisper", whisperTo: t.gm.id, total: 876544, criticalFailure: true } });
    expect((await gm.nextOfType("roll.result")).entry.total).toBe(876544);
    await settle();
    expect(frameCount(p2)).toEqual([before[1]]);
    for (const s of ["FURTIVITA-XYZ", "876543", "876544"]) expect(p2.traffic()).not.toContain(s);
  });

  it("formule malformate o oltre i limiti: INVALID con il messaggio italiano del parser, nessun tiro", async () => {
    const { gm, p1, p2 } = await table();
    const before = frameCount(gm, p2);
    for (const formula of ["9999d9999", "101d6", "1d1001", "2d6+", "d20 adv + d20", "abc", "", "1+".repeat(30) + "1", "1".repeat(201)]) {
      const expected = parseFormula(formula);
      expect(expected.ok, formula).toBe(false);
      if (expected.ok) continue;
      const r = await rollAs(p1, formula, "public");
      expect(r, formula).toEqual({
        type: "error",
        requestId: (r as { requestId: string }).requestId,
        code: "INVALID",
        message: expected.error.message,
        reason: expected.error.code,
      });
    }
    // Oltre il limite del protocollo: messaggio non valido (senza arrivare al parser).
    expect(await rollAs(p1, "1".repeat(1001), "public")).toMatchObject({ type: "error", code: "INVALID" });
    // Esiti dal client: campi sconosciuti, rifiutati.
    expect(await rollAs(p1, "1d20", "public", { total: 20 })).toMatchObject({ type: "error", code: "INVALID" });
    await settle();
    expect(frameCount(gm, p2)).toEqual(before);
  });
});

describe("cronologia e log di sessione", () => {
  /** Partita di prova: pubblico, whisper p1→GM, tiro segreto del GM, whisper GM→p2. */
  async function play(s: { t: Table; gm: WsClient; p1: WsClient }) {
    expect((await say(s.p1, "pubblico-1")).type).toBe("chat.message");
    expect((await say(s.p1, "WHISPER-P1-GM", s.t.gm.id)).type).toBe("chat.message");
    queued = [9];
    expect((await rollAs(s.gm, "1d20+765432", "gm")).type).toBe("roll.result");
    expect((await say(s.gm, "WHISPER-GM-P2", s.t.p2.id)).type).toBe("chat.message");
    queued = [2, 3];
    expect((await rollAs(s.p1, "2d6+3", "public")).type).toBe("roll.result");
  }

  const texts = (h: HistoryMessage) =>
    h.entries.map((e) => (e.kind === "message" ? (e as ChatEntry).text : (e as RollEntry).formula));

  it("all'hello ogni utente riceve le ultime voci che può vedere", async () => {
    const s = await table();
    await play(s);
    const again = {
      gm: await connect(s.port, s.t.gm.cookie),
      p1: await connect(s.port, s.t.p1.cookie),
      p2: await connect(s.port, s.t.p2.cookie),
    };
    expect(texts(await join_(again.gm, s.t.campaignId))).toEqual([
      "pubblico-1",
      "WHISPER-P1-GM",
      "1d20+765432",
      "WHISPER-GM-P2",
      "2d6+3",
    ]);
    expect(texts(await join_(again.p1, s.t.campaignId))).toEqual(["pubblico-1", "WHISPER-P1-GM", "2d6+3"]);
    const h2 = await join_(again.p2, s.t.campaignId);
    expect(texts(h2)).toEqual(["pubblico-1", "WHISPER-GM-P2", "2d6+3"]);
    expect(h2.hasMore).toBe(false);
    for (const secret of ["WHISPER-P1-GM", "765432"]) expect(again.p2.traffic()).not.toContain(secret);
  });

  it("pagine più vecchie con cursore (history.request), filtrate per l'utente", async () => {
    const s = await table({ CHAT_HISTORY_LIMIT: "2" });
    for (let i = 1; i <= 5; i++) {
      expect((await say(s.p1, `msg-${i}`)).type).toBe("chat.message");
      expect((await say(s.p1, `PRIVATO-${i}`, s.t.gm.id)).type).toBe("chat.message");
    }
    const p2 = await connect(s.port, s.t.p2.cookie);
    const first = await join_(p2, s.t.campaignId);
    expect(texts(first)).toEqual(["msg-4", "msg-5"]);
    expect(first.hasMore).toBe(true);
    const page = (await request(p2, { type: "history.request", before: first.entries[0]!.id, limit: 2 })) as HistoryMessage;
    expect(page).toMatchObject({ type: "history", hasMore: true });
    expect(texts(page)).toEqual(["msg-2", "msg-3"]);
    const last = (await request(p2, { type: "history.request", before: page.entries[0]!.id })) as HistoryMessage;
    expect(texts(last)).toEqual(["msg-1"]);
    expect(last.hasMore).toBe(false);
    expect(p2.traffic()).not.toContain("PRIVATO-");

    // Il cursore di una voce che non può vedere: come inesistente.
    const gmHistory = (await request(s.gm, { type: "history.request", before: null, limit: 1 })) as HistoryMessage;
    expect(texts(gmHistory)).toEqual(["PRIVATO-5"]);
    const hidden = gmHistory.entries[0]!.id;
    const r1 = await request(p2, { type: "history.request", before: hidden });
    const r2 = await request(p2, { type: "history.request", before: "inesistente" });
    expect(r1).toMatchObject({ type: "error", code: "NOT_FOUND" });
    expect((r1 as { message: string }).message).toBe((r2 as { message: string }).message);
  });

  it("persistenza: chat e tiri sopravvivono al riavvio, ancora filtrati", async () => {
    const dbPath = join(tmpdir(), `lanterna-chat-${randomUUID()}.db`);
    const uploadDir = join(tmpdir(), `lanterna-chat-uploads-${randomUUID()}`);
    const persistent = { dbPath, uploadDir };
    cleanup.push(() => {
      for (const x of ["", "-wal", "-shm"]) rmSync(dbPath + x, { force: true });
      rmSync(uploadDir, { recursive: true, force: true });
    });
    const s = await table({}, persistent);
    await play(s);
    const gmBefore = (await request(s.gm, { type: "history.request", before: null })) as HistoryMessage;
    for (const c of clients.splice(0)) c.ws.terminate();
    await ctx.close();

    ctx = await createTestApp({}, undefined, persistent, { rng });
    const port = await listen(ctx);
    const gm = await connect(port, s.t.gm.cookie);
    const p2 = await connect(port, s.t.p2.cookie);
    expect((await join_(gm, s.t.campaignId)).entries).toEqual(gmBefore.entries);
    expect(texts(await join_(p2, s.t.campaignId))).toEqual(["pubblico-1", "WHISPER-GM-P2", "2d6+3"]);
    expect(p2.traffic()).not.toContain("WHISPER-P1-GM");
    // E si continua.
    expect((await say(p2, "dopo il riavvio")).type).toBe("chat.message");
  });

  it("esportazione REST: admin log completo, giocatore solo ciò che vedeva, estranei 404, anonimi 401", async () => {
    const s = await table();
    await play(s);
    expect((await say(s.p1, "riga1\n[2030-01-01T00:00:00.000Z] GM: falso")).type).toBe("chat.message");
    const url = `/campaigns/${s.t.campaignId}/log`;
    const get = (cookie?: string, query = "") =>
      ctx.app.inject({ method: "GET", url: url + query, headers: cookie ? { cookie, origin: ORIGIN } : {} });

    expect((await get()).statusCode).toBe(401);
    const outsider = await loginAs(ctx.app, "player");
    expect((await get(outsider.cookie)).statusCode).toBe(404);
    expect((await get(s.t.gm.cookie.replace(/=.*/, "=x"), "")).statusCode).toBe(401);
    const missing = await ctx.app.inject({ method: "GET", url: "/campaigns/nope/log", headers: { cookie: s.t.gm.cookie } });
    expect(missing.statusCode).toBe(404);
    expect((await get(s.t.p1.cookie, "?format=xml")).statusCode).toBe(400);

    const full = await get(s.t.gm.cookie);
    expect(full.statusCode).toBe(200);
    expect(full.headers["cache-control"]).toBe("no-store");
    const fullBody = full.json() as SessionLogExport;
    expect(fullBody.scope).toBe("full");
    expect(fullBody.entries).toHaveLength(6);

    const mine = await get(s.t.p2.cookie);
    const body = mine.json() as SessionLogExport;
    expect(body.scope).toBe("visible");
    expect(body.entries.map((e) => e.kind === "message" ? e.text : e.formula)).toEqual([
      "pubblico-1",
      "WHISPER-GM-P2",
      "2d6+3",
      "riga1\n[2030-01-01T00:00:00.000Z] GM: falso",
    ]);
    for (const secret of ["WHISPER-P1-GM", "765432"]) expect(mine.body).not.toContain(secret);

    const text = await get(s.t.p2.cookie, "?format=text");
    expect(text.statusCode).toBe(200);
    expect(text.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(text.headers["content-disposition"]).toContain("attachment");
    expect(text.body).toContain("2d6+3 → [3, 4] + 3 = 10");
    expect(text.body).not.toContain("WHISPER-P1-GM");
    // Una riga del messaggio non può sembrare una voce: è rientrata.
    expect(text.body).toContain("\n    [2030-01-01T00:00:00.000Z] GM: falso");
    expect(text.body.split("\n").filter((l) => l.startsWith("[")).length).toBe(4);

    const gmText = await get(s.t.gm.cookie, "?format=text");
    expect(gmText.body).toContain("(solo GM) tira: 1d20+765432");
    expect(gmText.body).toContain("(sussurro a admin): WHISPER-P1-GM");

    const future = await get(s.t.gm.cookie, `?since=${Date.now() + 60_000}`);
    expect((future.json() as SessionLogExport).entries).toEqual([]);
  });
});

describe("rate limit di chat e tiri", () => {
  it("per utente (anche su più connessioni), separato fra messaggi e tiri", async () => {
    const s = await table({ CHAT_MESSAGE_BURST: "3", CHAT_MESSAGES_PER_MINUTE: "1", ROLL_BURST: "2", ROLLS_PER_MINUTE: "1" });
    for (let i = 0; i < 3; i++) expect((await say(s.p1, `m${i}`)).type).toBe("chat.message");
    expect(await say(s.p1, "troppo")).toMatchObject({ type: "error", code: "RATE_LIMITED" });
    const other = await connect(s.port, s.t.p1.cookie);
    await join_(other, s.t.campaignId);
    expect(await say(other, "troppo")).toMatchObject({ type: "error", code: "RATE_LIMITED" });
    // Gli altri utenti non sono toccati; i tiri hanno il loro limite.
    expect((await say(s.p2, "io posso")).type).toBe("chat.message");
    expect((await rollAs(s.p1, "1d6", "public")).type).toBe("roll.result");
    expect((await rollAs(s.p1, "1d6", "public")).type).toBe("roll.result");
    expect(await rollAs(s.p1, "1d6", "public")).toMatchObject({ type: "error", code: "RATE_LIMITED" });
    await settle();
    expect(s.gm.traffic()).not.toContain("troppo");
  });
});

describe("RNG dei tiri", () => {
  it("l'app usa l'RNG iniettato (test) e, senza, quello crittografico (produzione)", async () => {
    ctx = await createTestApp({}, undefined, undefined, { rng });
    expect(ctx.app.realtime.rng).toBe(rng);
    await ctx.close();
    ctx = await createTestApp();
    expect(ctx.app.realtime.rng).toBe(cryptoRandomInt);
  });

  it("i dati del client non influenzano l'esito: hello con campi in più rifiutato", async () => {
    ctx = await createTestApp();
    const port = await listen(ctx);
    const t = await createTable(ctx);
    const c = await connect(port, t.p1.cookie);
    c.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, campaignId: t.campaignId, lastVersion: null, epoch: null, seed: 1 });
    expect(await c.nextOfType("error")).toMatchObject({ code: "INVALID" });
  });
});
