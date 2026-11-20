import { randomUUID } from "node:crypto";
import {
  DEFAULT_GRID,
  DEFAULT_SCALE,
  PROTOCOL_VERSION,
  type Command,
  type Scene,
  type ServerMessage,
  type Token,
} from "@lanterna/shared";
import { ORIGIN, loginAs, type TestContext } from "./helpers.js";
import { WsClient } from "./ws.js";

/** Stringhe segrete univoche, da cercare nel traffico dei giocatori. */
export const SECRET = {
  hiddenId: "tok-hidden-ogre",
  hiddenName: "OgreNascostoXYZ",
  prepSceneName: "ScenaSegretaXYZ",
  prepTokenName: "DragoPreparatoXYZ",
  notes: "NOTA-GM-XYZ",
  p1HpMax: 9753,
  p2HpMax: 8642,
} as const;

export const MAIN = "scn-main";
export const PREP = "scn-prep";

export function scene(id: string, over: Partial<Scene> = {}): Scene {
  return {
    id,
    name: `Scena ${id}`,
    map: null,
    width: 1400,
    height: 1000,
    grid: { ...DEFAULT_GRID },
    scale: { ...DEFAULT_SCALE },
    ...over,
  };
}

export function token(id: string, over: Partial<Token> = {}): Token {
  return {
    id,
    sceneId: MAIN,
    name: `Token ${id}`,
    imageUrl: null,
    x: 105,
    y: 105,
    size: 1,
    rotation: 0,
    ownerUserId: null,
    kind: "monster",
    hidden: false,
    conditions: [],
    health: null,
    gmNotes: "",
    ...over,
  };
}

export async function createCampaignAs(ctx: TestContext, cookie: string, name = "Campagna di prova"): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/campaigns",
    headers: { origin: ORIGIN, cookie },
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`creazione campagna: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

export async function addMemberAs(ctx: TestContext, cookie: string, campaignId: string, userId: string) {
  const res = await ctx.app.inject({
    method: "POST",
    url: `/campaigns/${campaignId}/members`,
    headers: { origin: ORIGIN, cookie },
    payload: { userId },
  });
  if (res.statusCode !== 201) throw new Error(`aggiunta membro: ${res.statusCode} ${res.body}`);
}

/** Invia un comando e attende l'ack o l'errore con lo stesso requestId. */
export async function send(
  client: WsClient,
  message: { type: "command"; command: Command | Record<string, unknown> } | { type: "undo" | "redo" },
): Promise<Extract<ServerMessage, { type: "ack" | "error" }>> {
  const requestId = randomUUID();
  client.send({ ...message, requestId });
  return client.next((m) => (m.type === "ack" || m.type === "error") && m.requestId === requestId);
}

export async function command(client: WsClient, cmd: Command | Record<string, unknown>) {
  return send(client, { type: "command", command: cmd });
}

export function hello(client: WsClient, campaignId: string, lastVersion: number | null = null, epoch: string | null = null) {
  client.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, campaignId, lastVersion, epoch });
  return client.next((m) => m.type === "snapshot" || m.type === "delta" || m.type === "error");
}

export interface Table {
  campaignId: string;
  gm: { id: string; cookie: string };
  p1: { id: string; cookie: string };
  p2: { id: string; cookie: string };
}

/** Admin, due giocatori membri e una campagna vuota. */
export async function createTable(ctx: TestContext): Promise<Table> {
  const gm = await loginAs(ctx.app, "admin");
  const p1 = await loginAs(ctx.app, "player");
  const p2 = await loginAs(ctx.app, "player");
  const campaignId = await createCampaignAs(ctx, gm.cookie);
  await addMemberAs(ctx, gm.cookie, campaignId, p1.user.id);
  await addMemberAs(ctx, gm.cookie, campaignId, p2.user.id);
  return {
    campaignId,
    gm: { id: gm.user.id, cookie: gm.cookie },
    p1: { id: p1.user.id, cookie: p1.cookie },
    p2: { id: p2.user.id, cookie: p2.cookie },
  };
}

/** Il GM prepara scena attiva, scena segreta e token (con dati segreti). */
export async function populate(gm: WsClient, t: Table): Promise<void> {
  const cmds: Command[] = [
    { type: "scene.create", scene: scene(MAIN, { name: "Taverna" }) },
    { type: "scene.create", scene: scene(PREP, { name: SECRET.prepSceneName }) },
    { type: "scene.activate", sceneId: MAIN },
    {
      type: "token.create",
      token: token("tok-p1", {
        ownerUserId: t.p1.id,
        kind: "pc",
        name: "Eroe1",
        health: { current: 10, max: SECRET.p1HpMax, temp: 0 },
        gmNotes: SECRET.notes,
      }),
    },
    {
      type: "token.create",
      token: token("tok-p2", {
        ownerUserId: t.p2.id,
        kind: "pc",
        name: "Eroe2",
        x: 245,
        health: { current: 20, max: SECRET.p2HpMax, temp: 0 },
      }),
    },
    { type: "token.create", token: token(SECRET.hiddenId, { name: SECRET.hiddenName, hidden: true, x: 385 }) },
    { type: "token.create", token: token("tok-drago", { sceneId: PREP, name: SECRET.prepTokenName }) },
  ];
  for (const c of cmds) {
    const r = await command(gm, c);
    if (r.type !== "ack") throw new Error(`comando ${c.type} rifiutato: ${r.message}`);
  }
}
