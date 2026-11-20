// @vitest-environment node
/**
 * Integrazione: chat e dadi del client (`ChatStore` + `RealtimeClient`) contro il vero server, con un GM
 * e due giocatori. Whisper e tiri segreti non devono arrivare al terzo: si cerca nei byte ricevuti.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RollEntry } from "@lanterna/shared";
import { createTestApp, type TestContext } from "../../server/src/test/helpers";
import { createTable } from "../../server/src/test/campaign";
import { listen } from "../../server/src/test/ws";
import { ChatStore } from "../src/chat/ChatStore";
import { closeConnections, connect, until, type Player } from "./helpers";

let ctx: TestContext | undefined;

afterEach(async () => {
  closeConnections();
  await ctx?.close();
  ctx = undefined;
});

interface Seat extends Player {
  store: ChatStore;
  rolls: RollEntry[];
}

function seat(port: number, campaignId: string, cookie: string, userId: string): Seat {
  const p = connect(port, campaignId, cookie);
  const store = new ChatStore({ client: p.client, selfId: userId, getMembers: () => p.client.getState().view?.members ?? [] });
  store.attach();
  const rolls: RollEntry[] = [];
  store.onRoll((r) => rolls.push(r));
  return { ...p, store, rolls };
}

async function setup() {
  ctx = await createTestApp();
  const port = await listen(ctx);
  const t = await createTable(ctx);
  const gm = seat(port, t.campaignId, t.gm.cookie, t.gm.id);
  const p1 = seat(port, t.campaignId, t.p1.cookie, t.p1.id);
  const p2 = seat(port, t.campaignId, t.p2.cookie, t.p2.id);
  await until(() => [gm, p1, p2].every((s) => s.client.getState().status === "connected"), "connessione");
  return { port, t, gm, p1, p2 };
}

const texts = (s: Seat) => s.store.getState().entries.map((e) => (e.kind === "message" ? e.text : `tiro:${e.formula}`));
const traffic = (s: Seat) => s.traffic.join("\n");

describe("chat e dadi: client reale contro server reale", () => {
  it("messaggi pubblici arrivano a tutti; whisper e tiro segreto non arrivano al terzo", async () => {
    const { t, gm, p1, p2 } = await setup();

    // Pubblico: lo vedono tutti.
    expect((await p1.store.sendChat("ciao a tutti")).ok).toBe(true);
    await until(() => [gm, p1, p2].every((s) => texts(s).includes("ciao a tutti")), "messaggio pubblico");

    // Whisper giocatore -> GM: solo autore e GM.
    expect((await p1.store.sendChat("SUSSURRO-SEGRETO-XYZ", t.gm.id)).ok).toBe(true);
    await until(() => texts(gm).includes("SUSSURRO-SEGRETO-XYZ") && texts(p1).includes("SUSSURRO-SEGRETO-XYZ"), "whisper");
    // Il giocatore non puo' sussurrare a un altro giocatore: lo rifiuta il server.
    const toPlayer = await p1.store.sendChat("DA-P1-A-P2-XYZ", t.p2.id);
    expect(toPlayer).toMatchObject({ ok: false, code: "FORBIDDEN" });
    // Whisper GM -> p2: p1 non lo vede.
    expect((await gm.store.sendChat("GM-A-P2-XYZ", t.p2.id)).ok).toBe(true);
    await until(() => texts(p2).includes("GM-A-P2-XYZ"), "whisper del GM");

    // Tiro segreto del GM: solo il GM lo riceve (e lo anima); un giocatore non puo' farne.
    const secret = await gm.store.sendRoll({ formula: "1d20+7", visibility: "gm", label: "ETICHETTA-SEGRETA-XYZ" });
    expect(secret.ok).toBe(true);
    await until(() => gm.rolls.length === 1, "tiro segreto al GM");
    expect(gm.rolls[0]).toMatchObject({ visibility: "gm", label: "ETICHETTA-SEGRETA-XYZ" });
    expect(await p1.store.sendRoll({ formula: "1d20", visibility: "gm" })).toMatchObject({ ok: false, code: "FORBIDDEN" });

    // Tiro pubblico: tutti lo ricevono con gli stessi dadi (animazione sugli stessi valori).
    expect((await p1.store.sendRoll({ formula: "2d6+3", visibility: "public" })).ok).toBe(true);
    await until(() => [gm, p1, p2].every((s) => s.rolls.some((r) => r.formula === "2d6+3")), "tiro pubblico");
    const seen = [gm, p1, p2].map((s) => s.rolls.find((r) => r.formula === "2d6+3")!);
    expect(new Set(seen.map((r) => r.id)).size).toBe(1);
    const first = seen[0]!;
    const dice = first.terms.flatMap((term) => (term.kind === "dice" ? term.dice.map((d) => d.value) : []));
    expect(dice).toHaveLength(2);
    expect(first.total).toBe(dice[0]! + dice[1]! + 3); // coerente con quanto ha deciso il server
    expect(first.detail).toContain("2d6+3 →");

    // Tiro in whisper del giocatore al GM.
    expect((await p1.store.sendRoll({ formula: "1d4", visibility: "whisper", whisperTo: t.gm.id, label: "LBL-WHISPER-XYZ" })).ok).toBe(true);
    await until(() => gm.rolls.some((r) => r.label === "LBL-WHISPER-XYZ"), "tiro whisper al GM");

    // Un messaggio pubblico successivo passa dalla stessa coda: se p2 lo ha, ha gia' ricevuto tutto cio' che doveva.
    expect((await gm.store.sendChat("FINE-XYZ")).ok).toBe(true);
    await until(() => [gm, p1, p2].every((s) => texts(s).includes("FINE-XYZ")), "messaggio finale");

    const p2Bytes = traffic(p2);
    for (const secretText of ["SUSSURRO-SEGRETO-XYZ", "ETICHETTA-SEGRETA-XYZ", "LBL-WHISPER-XYZ", "DA-P1-A-P2-XYZ"]) {
      expect(p2Bytes).not.toContain(secretText);
    }
    expect(p2.rolls.map((r) => r.visibility)).toEqual(["public"]);
    const p1Bytes = traffic(p1);
    for (const secretText of ["GM-A-P2-XYZ", "ETICHETTA-SEGRETA-XYZ"]) expect(p1Bytes).not.toContain(secretText);
    expect(p1.rolls.every((r) => r.visibility !== "gm")).toBe(true);
  }, 30_000);

  it("formula non valida: errore del parser in italiano con il codice; nessun tiro per gli altri", async () => {
    const { gm, p1 } = await setup();
    const r = await p1.store.sendRoll({ formula: "9999d9999", visibility: "public" });
    expect(r).toMatchObject({ ok: false, code: "INVALID", reason: "DADI_FUORI_LIMITE" });
    expect(r.ok ? "" : r.message).toMatch(/dadi/i);
    const adv = await p1.store.sendRoll({ formula: "2d6 adv", visibility: "public" });
    expect(adv).toMatchObject({ ok: false, code: "INVALID", reason: "VANTAGGIO_NON_APPLICABILE" });
    expect(gm.rolls).toHaveLength(0);
  }, 30_000);

  it("cronologia: ultime voci all'handshake, pagine piu' vecchie con cursore, nessun duplicato dopo la riconnessione", async () => {
    const { port, t, gm, p1 } = await setup();
    for (let i = 1; i <= 5; i++) expect((await gm.store.sendChat(`msg-${i}`)).ok).toBe(true);
    expect((await gm.store.sendChat("PRIVATO-XYZ", t.p1.id)).ok).toBe(true);
    await until(() => texts(p1).includes("msg-5") && texts(p1).includes("PRIVATO-XYZ"), "messaggi live");

    // Un nuovo client (cronologia dall'handshake) vede le voci in ordine; un terzo giocatore non vede il whisper.
    const late = seat(port, t.campaignId, t.p2.cookie, t.p2.id);
    await until(() => texts(late).length === 5, "cronologia all'handshake");
    expect(texts(late)).toEqual(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
    expect(traffic(late)).not.toContain("PRIVATO-XYZ");

    // Pagine piu' vecchie con cursore = id della prima voce (qui simulate chiedendo prima del terzo messaggio).
    const entries = late.store.getState().entries;
    const third = entries[2]!;
    const page = await new Promise<{ entries: string[]; hasMore: boolean }>((resolve) => {
      const off = late.client.onEvent((e) => {
        if (e.type === "message" && e.message.type === "history" && e.message.requestId) {
          off();
          resolve({ entries: e.message.entries.map((x) => (x.kind === "message" ? x.text : "")), hasMore: e.message.hasMore });
        }
      });
      void late.client.requestHistory(third.id, 1);
    });
    expect(page).toEqual({ entries: ["msg-2"], hasMore: true });

    // Riconnessione: il server rimanda la cronologia, la lista resta senza duplicati.
    late.sockets[0]!.terminate();
    await until(() => late.sockets.length > 1 && late.client.getState().status === "connected", "riconnessione");
    await new Promise((r) => setTimeout(r, 150));
    expect(texts(late)).toEqual(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
  }, 30_000);
});
