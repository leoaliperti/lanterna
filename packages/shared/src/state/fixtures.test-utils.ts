/* Fixture per i test di stato e protocollo (escluse dalla build). */
import { expect } from "vitest";
import {
  CampaignStateSchema,
  DEFAULT_GRID,
  DEFAULT_SCALE,
  type Actor,
  type CampaignState,
  type Scene,
  type Token,
} from "./schema.js";

export const GM: Actor = { userId: "gm1", role: "admin" };
export const P1: Actor = { userId: "p1", role: "player" };
export const P2: Actor = { userId: "p2", role: "player" };
/** Utente non membro della campagna. */
export const STRANGER: Actor = { userId: "stranger", role: "player" };

export const MAIN = "scn-main";
export const PREP = "scn-prep";

export function scene(id: string, over: Partial<Scene> = {}): Scene {
  return {
    id,
    name: `Scena ${id}`,
    map: { assetId: `asset-${id}`, url: `/assets/${id}.webp` },
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
    imageUrl: `/assets/${id}.png`,
    x: 105,
    y: 105,
    size: 1,
    rotation: 0,
    ownerUserId: null,
    kind: "monster",
    hidden: false,
    conditions: [],
    health: { current: 10, max: 10, temp: 0 },
    gmNotes: "",
    ...over,
  };
}

/**
 * Stato di riferimento. Ogni dato segreto ha una stringa univoca e
 * facilmente cercabile nel JSON (per i test anti-fuga).
 */
export const SECRET = {
  hiddenOgreId: "tok-hidden-ogre",
  hiddenOgreName: "OgreNascostoXYZ",
  hiddenP1Id: "tok-hidden-p1",
  hiddenP1Name: "AlleatoNascostoXYZ",
  prepDragonId: "tok-prep-dragon",
  prepDragonName: "DragoPreparatoXYZ",
  prepSceneName: "ScenaSegretaXYZ",
  prepAsset: "asset-segreto-XYZ",
  notesP1: "NOTA-GM-P1-XYZ",
  notesOrc: "NOTA-GM-ORCO-XYZ",
  orcHp: 4321,
  p2Hp: 2468,
  p1Hp: 1357,
} as const;

export function baseState(): CampaignState {
  return CampaignStateSchema.parse({
    campaignId: "camp-1",
    name: "Campagna di prova",
    version: 0,
    activeSceneId: MAIN,
    members: [
      { userId: "gm1", displayName: "Master", role: "admin" },
      { userId: "p1", displayName: "Alice", role: "player" },
      { userId: "p2", displayName: "Bruno", role: "player" },
    ],
    scenes: [
      scene(MAIN, { name: "Taverna" }),
      scene(PREP, {
        name: SECRET.prepSceneName,
        map: { assetId: SECRET.prepAsset, url: `/assets/${SECRET.prepAsset}.webp` },
      }),
    ],
    tokens: [
      token("tok-p1", {
        name: "Alice-PG",
        kind: "pc",
        ownerUserId: "p1",
        x: 35,
        y: 35,
        health: { current: SECRET.p1Hp, max: 9999, temp: 3 },
        gmNotes: SECRET.notesP1,
        conditions: [{ id: "poisoned", name: "Avvelenato" }],
      }),
      token("tok-p2", {
        name: "Bruno-PG",
        kind: "pc",
        ownerUserId: "p2",
        x: 175,
        y: 35,
        health: { current: SECRET.p2Hp, max: 9999, temp: 0 },
      }),
      token("tok-orc", {
        name: "Orco",
        x: 315,
        y: 315,
        health: { current: SECRET.orcHp, max: 9999, temp: 0 },
        gmNotes: SECRET.notesOrc,
        conditions: [{ id: "prone", name: "Prono" }],
      }),
      token(SECRET.hiddenOgreId, { name: SECRET.hiddenOgreName, hidden: true, x: 595, y: 595 }),
      token(SECRET.hiddenP1Id, {
        name: SECRET.hiddenP1Name,
        hidden: true,
        ownerUserId: "p1",
        kind: "pc",
        x: 665,
        y: 665,
      }),
      token(SECRET.prepDragonId, { name: SECRET.prepDragonName, sceneId: PREP, x: 735, y: 735 }),
    ],
  });
}

/** Il testo `json` non deve contenere nessuna delle stringhe proibite. */
export function expectNoLeak(json: string, forbidden: readonly (string | number)[]): void {
  for (const f of forbidden) {
    expect(json, `trapela "${f}"`).not.toContain(String(f));
  }
}

/** Congela in profondità (per verificare che il riduttore non muti l'input). */
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** PRNG deterministico (mulberry32) per i test fuzz: riproducibili dato il seme. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
