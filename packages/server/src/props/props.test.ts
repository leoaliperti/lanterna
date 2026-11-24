import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Command, ServerEvent, ServerMessage } from "@lanterna/shared";
import { MAIN, PREP, command, createTable, hello, populate, send, type Table } from "../test/campaign.js";
import { createTestApp, type TestContext } from "../test/helpers.js";
import { WsClient, listen, settle } from "../test/ws.js";

/** Livelli e oggetti di scena (M10) e gestione scene: GM + 2 giocatori su WebSocket reali. */

const SECRET = { hidden: "OggettoNascostoPropXYZ", prep: "OggettoPrepPropXYZ", plain: "AlberoPropXYZ" } as const;

let ctx: TestContext | undefined;
let clients: WsClient[] = [];
const files: string[] = [];

afterEach(async () => {
  for (const c of clients) c.ws.terminate();
  clients = [];
  await ctx?.close();
  ctx = undefined;
  for (const f of files.splice(0)) rmSync(f, { recursive: true, force: true });
});

interface Setup {
  t: Table;
  port: number;
  gm: WsClient;
  p1: WsClient;
  p2: WsClient;
}

async function setup(persistent?: { dbPath: string; uploadDir: string }): Promise<Setup> {
  ctx = await createTestApp({}, undefined, persistent);
  const t = await createTable(ctx);
  const port = await listen(ctx);
  const gm = await WsClient.connect(port, { cookie: t.gm.cookie });
  clients.push(gm);
  await hello(gm, t.campaignId);
  await populate(gm, t);
  const p1 = await WsClient.connect(port, { cookie: t.p1.cookie });
  const p2 = await WsClient.connect(port, { cookie: t.p2.cookie });
  clients.push(p1, p2);
  await hello(p1, t.campaignId);
  await hello(p2, t.campaignId);
  return { t, port, gm, p1, p2 };
}

const prop = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  sceneId: MAIN,
  name: SECRET.plain,
  imageUrl: `/assets/${id}.png`,
  x: 300,
  y: 300,
  width: 140,
  height: 140,
  rotation: 0,
  layer: "above",
  opacity: 1,
  fade: true,
  hidden: false,
  ...over,
});

const ok = async (c: WsClient, cmd: Command | Record<string, unknown>) => {
  const r = await command(c, cmd);
  if (r.type !== "ack") throw new Error(`${(cmd as { type: string }).type}: ${JSON.stringify(r)}`);
  return r;
};

const events = (c: WsClient): ServerEvent[] => c.messages.flatMap((m) => (m.type === "delta" ? m.events : []));

describe("oggetti di scena su WebSocket", () => {
  it("il giocatore non puo' creare, modificare, eliminare ne' duplicare (FORBIDDEN)", async () => {
    const s = await setup();
    await ok(s.gm, { type: "prop.create", prop: prop("a") });
    const cmds: Record<string, unknown>[] = [
      { type: "prop.create", prop: prop("b") },
      { type: "prop.update", propId: "a", patch: { opacity: 0.2 } },
      { type: "prop.delete", propId: "a" },
      { type: "scene.duplicate", sceneId: MAIN, newSceneId: "dup", name: "Copia" },
    ];
    for (const c of cmds) {
      const r = await command(s.p1, c);
      expect(r.type).toBe("error");
      if (r.type === "error") expect(r.code).toBe("FORBIDDEN");
    }
    expect(ctx!.app.realtime.stateOf(s.t.campaignId)!.state.props).toHaveLength(1);
  });

  it("traffico per utente: nessun nome, nascosto o oggetto di altre scene arriva ai giocatori", async () => {
    const s = await setup();
    await ok(s.gm, { type: "prop.create", prop: prop("vis") });
    await ok(s.gm, { type: "prop.create", prop: prop("hid", { hidden: true, name: SECRET.hidden }) });
    await ok(s.gm, { type: "prop.create", prop: prop("prep", { sceneId: PREP, name: SECRET.prep }) });
    await ok(s.gm, { type: "prop.update", propId: "hid", patch: { opacity: 0.5 } });
    await ok(s.gm, { type: "prop.update", propId: "vis", patch: { layer: "ground", fade: false } });
    await settle();
    for (const p of [s.p1, s.p2]) {
      const json = JSON.stringify(p.messages);
      for (const secret of Object.values(SECRET)) expect(json).not.toContain(secret);
      const created = events(p).filter((e) => e.type === "prop.created");
      expect(created).toHaveLength(1);
      expect(events(p).some((e) => e.type === "prop.updated")).toBe(true);
    }
    // Un giocatore che si riconnette riceve lo snapshot filtrato.
    const late = await WsClient.connect(s.port, { cookie: s.t.p2.cookie });
    clients.push(late);
    const snap = await hello(late, s.t.campaignId);
    if (snap.type !== "snapshot") throw new Error("snapshot atteso");
    expect(snap.view.props?.map((p) => p.id)).toEqual(["vis"]);
    for (const secret of Object.values(SECRET)) expect(JSON.stringify(snap)).not.toContain(secret);
    // Il GM invece vede tutto, con il nome.
    const gmSnap = await hello(await WsClient.connect(s.port, { cookie: s.t.gm.cookie }), s.t.campaignId);
    if (gmSnap.type !== "snapshot") throw new Error("snapshot atteso");
    expect(gmSnap.view.props).toHaveLength(3);
  });

  it("annulla e ripeti riportano esattamente lo stato; mostrare la scena preparata invia gli oggetti", async () => {
    const s = await setup();
    await ok(s.gm, { type: "prop.create", prop: prop("prep", { sceneId: PREP, name: SECRET.prep }) });
    await settle();
    expect(events(s.p1).some((e) => e.type === "prop.created")).toBe(false);
    await ok(s.gm, { type: "scene.activate", sceneId: PREP });
    await settle();
    const act = events(s.p1).find((e) => e.type === "scene.activated" && e.sceneId === PREP);
    expect(act && act.type === "scene.activated" ? act.props?.map((p) => p.id) : null).toEqual(["prep"]);
    const state = () => ctx!.app.realtime.stateOf(s.t.campaignId)!.state;
    const before = state().props;
    await ok(s.gm, { type: "prop.update", propId: "prep", patch: { x: 500 } });
    const undo = await send(s.gm, { type: "undo" });
    expect(undo.type).toBe("ack");
    expect(state().props).toEqual(before);
  });

  it("duplicare una scena crea la copia (non attiva, invisibile ai giocatori) e si annulla", async () => {
    const s = await setup();
    await ok(s.gm, { type: "prop.create", prop: prop("a", { name: SECRET.plain }) });
    await ok(s.gm, { type: "scene.duplicate", sceneId: MAIN, newSceneId: "dup-1", name: "NomeCopiaXYZ" });
    await settle();
    const st = ctx!.app.realtime.stateOf(s.t.campaignId)!.state;
    expect(st.scenes.some((x) => x.id === "dup-1")).toBe(true);
    expect(st.props?.filter((p) => p.sceneId === "dup-1")).toHaveLength(1);
    expect(st.activeSceneId).toBe(MAIN);
    for (const p of [s.p1, s.p2]) expect(JSON.stringify(p.messages)).not.toContain("NomeCopiaXYZ");
    await send(s.gm, { type: "undo" });
    const after = ctx!.app.realtime.stateOf(s.t.campaignId)!.state;
    expect(after.scenes.some((x) => x.id === "dup-1")).toBe(false);
    expect(after.props?.some((p) => p.sceneId === "dup-1")).toBe(false);
  });

  it("gli oggetti sopravvivono al riavvio; eliminare la scena li toglie dal database", async () => {
    const dbPath = join(tmpdir(), `lanterna-props-${randomUUID()}.db`);
    const uploadDir = join(tmpdir(), `lanterna-props-up-${randomUUID()}`);
    files.push(uploadDir, dbPath, `${dbPath}-wal`, `${dbPath}-shm`);
    const persistent = { dbPath, uploadDir };
    const s = await setup(persistent);
    await ok(s.gm, { type: "prop.create", prop: prop("a") });
    await ok(s.gm, { type: "prop.create", prop: prop("b", { sceneId: PREP }) });
    await ok(s.gm, { type: "scene.delete", sceneId: PREP });
    const before = ctx!.app.realtime.stateOf(s.t.campaignId)!.state;
    expect(before.props?.map((p) => p.id)).toEqual(["a"]);
    for (const c of clients) c.close();
    clients = [];
    await ctx!.close();
    ctx = await createTestApp({}, undefined, persistent);
    expect(ctx.app.realtime.stateOf(s.t.campaignId)!.state.props).toEqual(before.props);
  });
});

export type { ServerMessage };
