// @vitest-environment node
/**
 * Integrazione: schede personaggio contro il vero server (REST + WebSocket), con un GM e due giocatori.
 * Verifica: un giocatore non legge ne' modifica schede altrui e non vede gli statblock (nemmeno nei byte ricevuti);
 * il tiro da scheda passa dal server (formula di `rollFor`, esito del server); PF dalla scheda al token.
 * Tutti i dati sono FITTIZI.
 */
import { afterEach, describe, expect, it } from "vitest";
import { blankDoc, monsterDocFromContent, rollFor, engineSheet, type RollEntry, type SheetRecord, type SheetSummary } from "@lanterna/shared";
import { ORIGIN, createTestApp, type TestContext } from "../../server/src/test/helpers";
import { createTable, scene, token, MAIN } from "../../server/src/test/campaign";
import { listen } from "../../server/src/test/ws";
import { ChatStore } from "../src/chat/ChatStore";
import { formulaOf, planTokenSync } from "../src/sheets/sheetLogic";
import { closeConnections, connect, until, type Player } from "./helpers";

let ctx: TestContext | undefined;

afterEach(async () => {
  closeConnections();
  await ctx?.close();
  ctx = undefined;
});

const SECRET_NAME = "MostroSegretoXYZ";
const SECRET_TEXT = "STATBLOCK-SEGRETO-XYZ";

async function setup() {
  ctx = await createTestApp();
  const port = await listen(ctx);
  const t = await createTable(ctx);
  const rest = async (cookie: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/campaigns/${t.campaignId}/sheets${path}`, {
      method,
      headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) as unknown };
  };
  return { port, t, rest };
}

describe("schede: client contro server reale", () => {
  it("un giocatore non legge ne' modifica schede altrui e non vede gli statblock", async () => {
    const { port, t, rest } = await setup();
    const hero1 = (await rest(t.gm.cookie, "POST", "", { kind: "pc", doc: blankDoc("Eroe Uno"), ownerUserId: t.p1.id })).json() as SheetRecord;
    const hero2 = (await rest(t.gm.cookie, "POST", "", { kind: "pc", doc: blankDoc("Eroe Due"), ownerUserId: t.p2.id })).json() as SheetRecord;
    const monster = (
      await rest(t.gm.cookie, "POST", "", { kind: "monster", doc: monsterDocFromContent(SECRET_NAME, { hp: 20, text: SECRET_TEXT }) })
    ).json() as SheetRecord;

    const seen: string[] = [];
    const list = await rest(t.p1.cookie, "GET", "");
    seen.push(list.text);
    expect((list.json() as { sheets: SheetSummary[] }).sheets.map((s) => s.id)).toEqual([hero1.id]);
    for (const id of [hero2.id, monster.id]) {
      const r = await rest(t.p1.cookie, "GET", `/${id}`);
      seen.push(r.text);
      expect(r.status).toBe(404);
      const w = await rest(t.p1.cookie, "PUT", `/${id}`, { version: 1, doc: blankDoc("hack") });
      seen.push(w.text);
      expect(w.status).toBe(404);
      expect((await rest(t.p1.cookie, "DELETE", `/${id}`)).status).toBe(404);
    }
    expect((await rest(t.p1.cookie, "PUT", `/${hero1.id}`, { version: 1, ownerUserId: t.p2.id })).status).toBe(403);
    for (const s of [SECRET_NAME, SECRET_TEXT, monster.id, hero2.id, "Eroe Due"]) expect(seen.join("\n")).not.toContain(s);
    // Sul WebSocket non passa nulla delle schede.
    const p1 = connect(port, t.campaignId, t.p1.cookie);
    await until(() => p1.client.getState().status === "connected", "connessione");
    expect(p1.traffic.join("\n")).not.toContain(SECRET_NAME);
  }, 30_000);

  it("il tiro da scheda passa dal server: formula di rollFor con svantaggio dalle condizioni, esito del server", async () => {
    const { port, t, rest } = await setup();
    const base = blankDoc("Eroe Avvelenato");
    const doc = { ...base, sheet: { ...base.sheet, abilities: { ...base.sheet.abilities, wis: 14 }, skills: { perception: "proficient" as const }, conditions: ["poisoned" as const] } };
    const rec = (await rest(t.gm.cookie, "POST", "", { kind: "pc", doc, ownerUserId: t.p1.id })).json() as SheetRecord;

    const p: Player = connect(port, t.campaignId, t.p1.cookie);
    const rolls: RollEntry[] = [];
    const store = new ChatStore({ client: p.client, selfId: t.p1.id, getMembers: () => p.client.getState().view?.members ?? [] });
    store.attach();
    store.onRoll((r) => rolls.push(r));
    await until(() => p.client.getState().status === "connected", "connessione");

    // Il client legge la scheda dal server e calcola la formula con le regole condivise.
    const fresh = (await rest(t.p1.cookie, "GET", `/${rec.id}`)).json() as SheetRecord;
    const { sheet, content } = engineSheet(fresh.doc);
    const formula = formulaOf(rollFor(sheet, content, { kind: "skill", skill: "perception" }));
    expect(formula).toBe("1d20+4 dis");
    expect((await store.sendRoll({ formula: formula!, visibility: "public", label: "Percezione (Eroe Avvelenato)" })).ok).toBe(true);
    await until(() => rolls.length === 1, "esito del tiro");
    const r = rolls[0]!;
    expect(r.advantage).toBe("disadvantage");
    const die = r.terms.find((x) => x.kind === "dice");
    expect(die && die.kind === "dice" ? die.dice.length : 0).toBe(2); // due d20: l'esito lo ha deciso il server
    const kept = die && die.kind === "dice" ? die.dice.filter((d) => d.kept).map((d) => d.value) : [];
    expect(r.total).toBe(kept[0]! + 4);
    // Fallimento automatico: la formula non esiste, non si invia nulla.
    expect(formulaOf(rollFor({ ...sheet, conditions: ["stunned"] }, content, { kind: "save", ability: "dex" }))).toBeNull();
  }, 30_000);

  it("PF dalla scheda al token: il giocatore modifica la scheda, il client del GM aggiorna la barra, il proprietario la vede", async () => {
    const { port, t, rest } = await setup();
    const gm = connect(port, t.campaignId, t.gm.cookie);
    const p1 = connect(port, t.campaignId, t.p1.cookie);
    await until(() => [gm, p1].every((s) => s.client.getState().status === "connected"), "connessione");
    for (const cmd of [
      { type: "scene.create", scene: scene(MAIN) },
      { type: "scene.activate", sceneId: MAIN },
      { type: "token.create", token: token("tok-eroe", { kind: "pc", ownerUserId: t.p1.id, health: { current: 8, max: 8, temp: 0 } }) }
    ] as const) {
      const r = await gm.client.sendCommand(cmd);
      if (!r.ok) throw new Error(`${cmd.type}: ${r.message}`);
    }
    const rec = (await rest(t.gm.cookie, "POST", "", { kind: "pc", doc: blankDoc("Eroe"), ownerUserId: t.p1.id, tokenId: "tok-eroe" })).json() as SheetRecord;

    // Il giocatore non vede il legame con il token.
    expect((await rest(t.p1.cookie, "GET", "")).text).not.toContain("tok-eroe");

    // Il GM osserva l'elenco (baseline), poi il giocatore si fa male sulla propria scheda.
    const listFor = async () => ((await rest(t.gm.cookie, "GET", "")).json() as { sheets: SheetSummary[] }).sheets;
    const tokensOf = () => gm.client.getState().view!.tokens;
    let seen = planTokenSync(new Map(), await listFor(), tokensOf()).next;

    const own = (await rest(t.p1.cookie, "GET", `/${rec.id}`)).json() as SheetRecord;
    const hurt = { ...own.doc, sheet: { ...own.doc.sheet, hp: { ...own.doc.sheet.hp, current: 3 }, conditions: ["poisoned" as const] } };
    expect((await rest(t.p1.cookie, "PUT", `/${rec.id}`, { version: own.version, doc: hurt })).status).toBe(200);

    const plan = planTokenSync(seen, await listFor(), tokensOf());
    seen = plan.next;
    expect(plan.updates).toHaveLength(1);
    const u = plan.updates[0]!;
    expect((await gm.client.sendCommand({ type: "token.update", tokenId: u.tokenId, patch: u.patch })).ok).toBe(true);

    await until(() => p1.client.getState().view?.tokens.find((x) => x.id === "tok-eroe")?.health?.current === 3, "barra della vita del proprietario");
    const mine = p1.client.getState().view!.tokens.find((x) => x.id === "tok-eroe")!;
    expect(mine.conditions.map((c) => c.id)).toEqual(["poisoned"]);
    // Nessun altro cambiamento al giro successivo.
    expect(planTokenSync(seen, await listFor(), tokensOf()).updates).toEqual([]);
  }, 30_000);
});
