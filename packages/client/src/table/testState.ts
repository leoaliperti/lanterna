import { DEFAULT_GRID, DEFAULT_SCALE, type Actor, type CampaignState, type Token } from "@lanterna/shared";

/* Stato di prova condiviso dai test del tavolo. */
export const gm: Actor = { userId: "gm", role: "admin" };
export const luca: Actor = { userId: "luca", role: "player" };
export const sara: Actor = { userId: "sara", role: "player" };

export function token(over: Partial<Token> & { id: string }): Token {
  return {
    sceneId: "s1",
    name: over.id,
    imageUrl: null,
    x: 140,
    y: 210,
    size: 1,
    rotation: 0,
    ownerUserId: null,
    kind: "monster",
    hidden: false,
    conditions: [],
    health: null,
    gmNotes: "",
    ...over
  };
}

export const state: CampaignState = {
  campaignId: "c1",
  name: "Campagna",
  version: 7,
  activeSceneId: "s1",
  members: [
    { userId: "gm", displayName: "Marta", role: "admin" },
    { userId: "luca", displayName: "Luca", role: "player" },
    { userId: "sara", displayName: "Sara", role: "player" }
  ],
  scenes: [
    { id: "s1", name: "Cripta", map: { assetId: "a1", url: "/assets/aaaa.png" }, width: 1400, height: 1050, grid: { ...DEFAULT_GRID }, scale: { ...DEFAULT_SCALE } },
    { id: "s2", name: "Bosco", map: null, width: 800, height: 600, grid: { ...DEFAULT_GRID }, scale: { ...DEFAULT_SCALE } }
  ],
  tokens: [
    token({ id: "pg-luca", kind: "pc", ownerUserId: "luca", health: { current: 12, max: 20, temp: 3 }, imageUrl: "/assets/bbbb.webp", conditions: [{ id: "prone", name: "Prono" }] }),
    token({ id: "pg-sara", kind: "pc", ownerUserId: "sara", health: { current: 8, max: 8, temp: 0 } }),
    token({ id: "drago", kind: "monster", hidden: true, health: { current: 200, max: 200, temp: 0 }, gmNotes: "segreto del GM" }),
    token({ id: "altra-scena", sceneId: "s2" })
  ]
};
