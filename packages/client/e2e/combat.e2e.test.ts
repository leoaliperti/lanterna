// @vitest-environment node
/**
 * Integrazione del combattimento: `RealtimeClient` reale e logica della UI (comandi del tracker, azioni di gruppo,
 * selezione per categoria, forme effimere) contro il server vero. Un GM e due giocatori con la nebbia. Si cercano
 * stringhe distintive (non numeri corti) nei byte ricevuti dai giocatori.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Command, CombatView, RandomInt, ServerMessage } from "@lanterna/shared";
import { createTestApp, type TestContext } from "../../server/src/test/helpers";
import { MAIN, createTable, scene, token } from "../../server/src/test/campaign";
import { listen } from "../../server/src/test/ws";
import { alertKey } from "../src/combat/alerts";
import { addEntryCommand, addTokenCommand, rollRequest } from "../src/combat/combatLogic";
import { EphemeralStore, isShapeMessage, shapesOfScene } from "../src/combat/ephemeralStore";
import { emptyEffectDraft } from "../src/combat/effectsLogic";
import { applyCommand, createGroupCommand, groupAction, selectByCategory, type ActionDraft } from "../src/combat/selectionLogic";
import { fogShapeCommand, fogTarget } from "../src/fog/fogLogic";
import { cellRects, measureShape } from "../src/map/measure";
import type { CombatAlert } from "../src/realtime/RealtimeClient";
import { closeConnections, connect, until, type Player } from "./helpers";

const S = {
  entry: "VoceNascostaCombatXYZ",
  entryInit: 987.25,
  hiddenToken: "MostroNascostoCombatXYZ",
  secretEffect: "EffettoSegretoCombatXYZ",
  openEffect: "BenedizioneCombatXYZ",
  group: "GruppoSegretoCombatXYZ"
} as const;

let queued: number[] = [];
const rng: RandomInt = (max) => {
  const v = queued.shift() ?? 0;
  if (v >= max) throw new Error(`valore ${v} non valido per ${max}`);
  return v;
};

let ctx: TestContext | undefined;

afterEach(async () => {
  closeConnections();
  await ctx?.close();
  ctx = undefined;
  queued = [];
});

const ROOM_A = { kind: "rect", x: 0, y: 0, width: 280, height: 210 } as const; // celle 0..3 x 0..2 (celle da 70 px)
const ROOM_B = { kind: "rect", x: 980, y: 630, width: 420, height: 370 } as const;

async function must(p: ReturnType<Player["client"]["sendCommand"]>, what = "comando") {
  const r = await p;
  if (!r.ok) throw new Error(`${what} rifiutato: ${r.code} ${r.message}`);
}

interface Rec {
  alerts: CombatAlert[];
  messages: ServerMessage[];
}
function record(p: Player): Rec {
  const rec: Rec = { alerts: [], messages: [] };
  p.client.onEvent((e) => {
    if (e.type === "alert") rec.alerts.push(e.alert);
    else if (e.type === "message") rec.messages.push(e.message);
  });
  return rec;
}

async function setup() {
  ctx = await createTestApp({}, undefined, undefined, { rng });
  const port = await listen(ctx);
  const t = await createTable(ctx);
  const gm = connect(port, t.campaignId, t.gm.cookie);
  await until(() => gm.client.getState().status === "connected", "GM connesso");
  const cmds: Command[] = [
    { type: "scene.create", scene: scene(MAIN, { name: "Taverna" }) },
    { type: "scene.activate", sceneId: MAIN },
    { type: "token.create", token: token("tok-p1", { ownerUserId: t.p1.id, kind: "pc", name: "Eroe1", x: 105, y: 105, health: { current: 10, max: 10, temp: 0 } }) },
    { type: "token.create", token: token("tok-p2", { ownerUserId: t.p2.id, kind: "pc", name: "Eroe2", x: 1155, y: 805, health: { current: 10, max: 10, temp: 0 } }) },
    { type: "token.create", token: token("tok-gob", { name: "Goblin", x: 175, y: 105, faction: "Orda", health: { current: 7, max: 7, temp: 0 } }) },
    { type: "token.create", token: token("tok-hid", { name: S.hiddenToken, x: 245, y: 105, hidden: true, faction: "Orda" }) },
    { type: "fog.enable", sceneId: MAIN, initial: "covered" },
    fogShapeCommand("reveal", MAIN, ROOM_A, fogTarget([t.p1.id])),
    fogShapeCommand("reveal", MAIN, ROOM_B, fogTarget([t.p2.id]))
  ];
  for (const c of cmds) await must(gm.client.sendCommand(c), c.type);
  const p1 = connect(port, t.campaignId, t.p1.cookie);
  const p2 = connect(port, t.campaignId, t.p2.cookie);
  await until(() => !!p1.client.getState().view?.fogs?.length && !!p2.client.getState().view?.fogs?.length, "giocatori con nebbia");
  const recs = { gm: record(gm), p1: record(p1), p2: record(p2) };
  return { t, port, gm, p1, p2, recs };
}

const combatOf = (p: Player): CombatView | undefined => p.client.getState().view!.combats?.find((c) => c.sceneId === MAIN);
const tokenOf = (p: Player, id: string) => p.client.getState().view!.tokens.find((x) => x.id === id);
const trafficOf = (p: Player) => p.traffic.join("");

describe("combattimento: client reale contro server reale", () => {
  it("tracker: il giocatore non vede voci nascoste ne' sotto la nebbia; il tiro e' del server; gli avvisi vanno ai diretti interessati", async () => {
    const { gm, p1, p2, recs } = await setup();
    const add = (c: Command) => must(gm.client.sendCommand(c), c.type);
    await add(addTokenCommand("pa", MAIN, "tok-p1"));
    await add(addTokenCommand("pb", MAIN, "tok-p2"));
    await add(addTokenCommand("pc", MAIN, "tok-gob"));
    await add(addTokenCommand("pd", MAIN, "tok-hid"));
    await add(addEntryCommand("pe", MAIN, S.entry, S.entryInit, true)!);

    // Il tiro lo decide il server (d20 con l'RNG iniettato): il client manda solo bonus e modo.
    queued = [14, 4, 9];
    const request = rollRequest(MAIN, ["pa", "pb", "pc"], { bonus: 2, mode: "normal" }, true)!;
    expect(JSON.stringify(request)).not.toMatch(/total|natural/);
    expect((await gm.client.rollInitiative(request)).ok).toBe(true);
    await until(() => combatOf(gm)?.participants.find((p) => p.id === "pa")?.initiative === 17, "iniziativa tirata dal server");
    expect(combatOf(gm)!.participants.map((p) => [p.id, p.initiative]).slice(0, 3)).toEqual([["pe", S.entryInit], ["pa", 17], ["pc", 12]]);
    // Un giocatore non puo' far tirare l'iniziativa.
    expect((await p1.client.rollInitiative({ sceneId: MAIN, rolls: [{ participantId: "pa", bonus: 5 }] })).ok).toBe(false);

    await add({ type: "combat.start", sceneId: MAIN, sort: true });
    await until(() => combatOf(p1)?.started === true, "combattimento avviato per p1");

    // Il giocatore vede solo cio' che il server invia.
    const seenByP1 = combatOf(p1)!;
    expect(seenByP1.participants.map((x) => x.name)).toEqual(["Eroe1", "Goblin"]);
    expect(seenByP1.turnId).toBeNull(); // il primo turno e' della voce nascosta: il giocatore non lo sa
    expect(combatOf(p2)!.participants.map((x) => x.name)).toEqual(["Eroe2"]); // il goblin e' sotto la nebbia per lui
    for (const p of [p1, p2]) {
      const traffic = trafficOf(p);
      expect(traffic).not.toContain(S.entry);
      expect(traffic).not.toContain(S.hiddenToken);
      expect(traffic).not.toContain(String(S.entryInit));
    }
    expect(trafficOf(p2)).not.toContain("Goblin");
    expect(combatOf(gm)!.participants.some((x) => x.name === S.entry && x.hidden === true)).toBe(true);

    // Avvisi: solo GM e proprietario del token di turno.
    const turns = (r: { alerts: CombatAlert[] }) => r.alerts.filter((a) => a.type === "combat.turn");
    await until(() => turns(recs.gm).length >= 1, "avviso al GM");
    expect(turns(recs.p1)).toHaveLength(0);
    await add({ type: "combat.next", sceneId: MAIN }); // turno di Eroe1
    await until(() => turns(recs.p1).some((a) => a.type === "combat.turn" && a.tokenId === "tok-p1"), "avviso a p1 (suo turno)");
    expect(combatOf(p1)!.turnId).toBe("pa");
    expect(turns(recs.p2)).toHaveLength(0);
    await add({ type: "combat.next", sceneId: MAIN }); // Goblin: del GM
    await add({ type: "combat.next", sceneId: MAIN }); // Eroe2
    await until(() => turns(recs.p2).some((a) => a.type === "combat.turn" && a.tokenId === "tok-p2"), "avviso a p2");
    expect(turns(recs.p1)).toHaveLength(1);
    // Mai il testo della voce nascosta negli avvisi dei giocatori; chiavi di dedupe distinte per round e partecipante.
    expect(JSON.stringify(recs.p1.alerts)).not.toContain(S.entry);
    const keys = recs.gm.alerts.map(alertKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("azione di gruppo atomica e annullabile in un colpo; effetti segreti, fazione e gruppi solo al GM", async () => {
    const { gm, p1, p2 } = await setup();
    const gmView = () => gm.client.getState().view!;

    // Selezione per categoria sui dati del GM (il GM vede anche il token nascosto).
    const pcs = selectByCategory(gmView().tokens, MAIN, { kind: "pc", faction: null }).map((x) => x.id);
    expect(pcs).toEqual(["tok-p1", "tok-p2"]);
    expect(selectByCategory(gmView().tokens, MAIN, { kind: "all", faction: "Orda" }).map((x) => x.id)).toEqual(["tok-gob", "tok-hid"]);

    const damage: ActionDraft = { kind: "damage", amount: "4", critical: false, conditionId: "", removeCondition: false, effect: emptyEffectDraft(), dx: "0", dy: "0" };
    await must(gm.client.sendCommand(applyCommand(pcs, groupAction(damage, "x", 70)!)), "danno di gruppo");
    await until(() => tokenOf(p1, "tok-p1")?.health?.current === 6, "danno visto da p1");
    expect(gmView().tokens.filter((x) => pcs.includes(x.id)).map((x) => x.health?.current)).toEqual([6, 6]);
    expect(tokenOf(p2, "tok-p2")?.health?.current).toBe(6);

    // Un solo annulla ripristina tutti i bersagli.
    expect((await gm.client.undo()).ok).toBe(true);
    await until(() => tokenOf(p1, "tok-p1")?.health?.current === 10, "annullato per p1");
    expect(gmView().tokens.filter((x) => pcs.includes(x.id)).map((x) => x.health?.current)).toEqual([10, 10]);
    expect(tokenOf(p2, "tok-p2")?.health?.current).toBe(10);

    // Il giocatore non puo' applicare danni (FORBIDDEN), nemmeno al proprio token.
    const denied = await p1.client.sendCommand(applyCommand(["tok-p1"], { kind: "damage", amount: 1 }));
    expect(denied).toMatchObject({ ok: false, code: "FORBIDDEN" });

    // Effetti: il segreto resta al GM, quello aperto arriva al proprietario con la durata residua.
    const fx = (name: string, secret: boolean): ActionDraft => ({ ...damage, kind: "effect", effect: { ...emptyEffectDraft(), name, duration: "3", secret } });
    await must(gm.client.sendCommand(applyCommand(["tok-p1"], groupAction(fx(S.secretEffect, true), "eff-secret", 70)!)), "effetto segreto");
    await must(gm.client.sendCommand(applyCommand(["tok-p1"], groupAction(fx(S.openEffect, false), "eff-open", 70)!)), "effetto aperto");
    await until(() => (tokenOf(p1, "tok-p1")?.effects?.length ?? 0) === 1, "effetto aperto visto da p1");
    expect(tokenOf(p1, "tok-p1")!.effects![0]).toMatchObject({ name: S.openEffect, remaining: 3, timing: "end" });
    expect(trafficOf(p1)).not.toContain(S.secretEffect);
    expect(tokenOf(gm, "tok-p1")!.effects!.map((e) => e.name).sort()).toEqual([S.openEffect, S.secretEffect].sort());

    // Gruppi e fazione: solo GM.
    await must(gm.client.sendCommand(createGroupCommand("g1", S.group, ["tok-gob", "tok-hid"])!), "gruppo");
    await until(() => (gmView().groups?.length ?? 0) === 1, "gruppo salvato");
    await new Promise((r) => setTimeout(r, 150));
    for (const p of [p1, p2]) {
      expect(p.client.getState().view!.groups ?? []).toEqual([]);
      expect(trafficOf(p)).not.toContain(S.group);
      expect(trafficOf(p)).not.toContain("Orda");
    }
  });

  it("forme effimere: ritagliate dal server per la nebbia, mai ricostruite dal client; le private non partono", async () => {
    const { gm, p1, p2, recs } = await setup();
    const store1 = new EphemeralStore();
    recs.p1.messages.forEach((m) => isShapeMessage(m) && store1.receive(m));
    const shownBy = (r: Rec) => r.messages.filter((m) => m.type === "ephemeral.shown");

    // Un cerchio grande attorno al token di p1: copre molte celle, p1 ne vede solo quelle rivelate.
    const big = measureShape("circle", { x: 105, y: 105 }, { x: 105 + 350, y: 105 }, 70)!;
    expect((await gm.client.showEphemeral({ id: "m-big", sceneId: MAIN, audience: "all", shape: big })).ok).toBe(true);
    await until(() => shownBy(recs.p1).length === 1, "p1 riceve la forma ritagliata");
    const got = shownBy(recs.p1)[0] as Extract<ServerMessage, { type: "ephemeral.shown" }>;
    expect(got.shape.kind).toBe("cells");
    if (got.shape.kind !== "cells") throw new Error("cells attese");
    const rects = cellRects(got.shape.cells, { cellSize: 70, offsetX: 0, offsetY: 0 });
    expect(rects.length).toBeGreaterThan(0);
    // Solo celle della stanza rivelata a p1 (0..3 x 0..2): nessuna coordinata o misura oltre.
    expect(got.shape.cells.length % 2).toBe(0);
    for (const r of rects) {
      expect(r.x).toBeLessThan(280);
      expect(r.y).toBeLessThan(210);
    }
    const raw = p1.traffic.find((m) => m.includes('"ephemeral.shown"') && m.includes("m-big"))!;
    expect(raw).not.toContain("radius");
    // p2 non vede nulla di quella zona: nemmeno il messaggio.
    await new Promise((r) => setTimeout(r, 200));
    expect(shownBy(recs.p2)).toHaveLength(0);
    expect(p2.traffic.join("")).not.toContain("m-big");

    // Il client mostra le celle cosi' come sono (scadenza locale dal ttl ricevuto).
    for (const m of recs.p1.messages) if (isShapeMessage(m)) store1.receive(m);
    const live = shapesOfScene(store1.getSnapshot(), MAIN);
    expect(live).toHaveLength(1);
    expect(live[0]!.shape.kind).toBe("cells");
    expect(live[0]!.ttlMs).toBe(10_000);
    store1.dispose();

    // Forma tutta dentro la stanza di p1: arriva intera.
    const small = measureShape("circle", { x: 105, y: 105 }, { x: 105 + 30, y: 105 }, 70)!;
    await must(gm.client.showEphemeral({ id: "m-small", sceneId: MAIN, audience: "all", shape: small }), "forma piccola");
    await until(() => shownBy(recs.p1).length === 2, "p1 riceve la forma intera");
    expect((shownBy(recs.p1)[1] as { shape: { kind: string } }).shape.kind).toBe("circle");

    // Misura privata: il server risponde e non la inoltra a nessuno.
    expect((await gm.client.showEphemeral({ id: "m-priv", sceneId: MAIN, audience: "private", shape: big })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(shownBy(recs.p1)).toHaveLength(2);
    expect(p1.traffic.join("")).not.toContain("m-priv");

    // Il giocatore segnala al solo GM; poi toglie la forma.
    const ping = measureShape("ping", { x: 105, y: 105 }, { x: 105, y: 105 }, 70)!;
    await must(p1.client.showEphemeral({ id: "ping-1", sceneId: MAIN, audience: "gm", shape: ping }), "ping");
    await until(() => shownBy(recs.gm).some((m) => (m as { id: string }).id === "ping-1"), "il GM riceve il ping");
    expect(shownBy(recs.p2).some((m) => (m as { id: string }).id === "ping-1")).toBe(false);
    await must(p1.client.clearEphemeral("ping-1"), "clear");
    await until(() => recs.gm.messages.some((m) => m.type === "ephemeral.cleared" && m.id === "ping-1"), "il GM riceve la rimozione");
  });
});
