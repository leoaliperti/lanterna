import { z } from "zod";
import type { Actor, CampaignState, Scene, Token } from "./schema.js";
import { MemberSchema, RoleSchema, SceneSchema, TokenSchema } from "./schema.js";

/**
 * Proiezioni per utente. Regole:
 * - il GM (`admin`) vede tutto;
 * - un giocatore vede solo la scena attiva e i token NON nascosti di quella scena;
 * - la vita (`health`) arriva solo al GM e al proprietario del token (agli altri `null`);
 * - le note del GM (`gmNotes`) arrivano solo al GM (agli altri il campo manca del tutto);
 * - condizioni e stati sono visibili a tutti quelli che vedono il token.
 *
 * Le proiezioni copiano i campi uno per uno (lista bianca): un campo nuovo
 * aggiunto al modello non arriva ai giocatori finché non lo si aggiunge qui.
 */

export const TokenViewSchema = TokenSchema.omit({ gmNotes: true }).extend({
  gmNotes: z.string().optional(),
});
export type TokenView = z.infer<typeof TokenViewSchema>;

export const SceneViewSchema = SceneSchema;
export type SceneView = z.infer<typeof SceneViewSchema>;

export const CampaignViewSchema = z.strictObject({
  campaignId: z.string(),
  name: z.string(),
  version: z.number().int().min(0),
  viewer: z.strictObject({ userId: z.string(), role: RoleSchema }),
  activeSceneId: z.string().nullable(),
  members: z.array(MemberSchema),
  scenes: z.array(SceneViewSchema),
  tokens: z.array(TokenViewSchema),
});
export type CampaignView = z.infer<typeof CampaignViewSchema>;

export function isGm(viewer: Actor): boolean {
  return viewer.role === "admin";
}

/** Il viewer può sapere che il token esiste? */
export function canSeeToken(token: Token, viewer: Actor, activeSceneId: string | null): boolean {
  if (isGm(viewer)) return true;
  return !token.hidden && activeSceneId !== null && token.sceneId === activeSceneId;
}

/** Il viewer può vedere la barra della vita del token? */
export function canSeeHealth(token: Token, viewer: Actor): boolean {
  return isGm(viewer) || (token.ownerUserId !== null && token.ownerUserId === viewer.userId);
}

export function canSeeScene(scene: Scene, viewer: Actor, activeSceneId: string | null): boolean {
  return isGm(viewer) || scene.id === activeSceneId;
}

/** Proiezione di un token che il viewer PUÒ vedere (controllare prima con `canSeeToken`). */
export function projectToken(token: Token, viewer: Actor): TokenView {
  const view: TokenView = {
    id: token.id,
    sceneId: token.sceneId,
    name: token.name,
    imageUrl: token.imageUrl,
    x: token.x,
    y: token.y,
    size: token.size,
    rotation: token.rotation,
    ownerUserId: token.ownerUserId,
    kind: token.kind,
    hidden: token.hidden,
    conditions: token.conditions.map((c) => ({ id: c.id, name: c.name })),
    health: canSeeHealth(token, viewer) && token.health ? { ...token.health } : null,
  };
  if (isGm(viewer)) view.gmNotes = token.gmNotes;
  return view;
}

export function projectScene(scene: Scene): SceneView {
  return {
    id: scene.id,
    name: scene.name,
    map: scene.map ? { assetId: scene.map.assetId, url: scene.map.url } : null,
    width: scene.width,
    height: scene.height,
    grid: { ...scene.grid },
    scale: { ...scene.scale },
  };
}

/** Stato visibile al viewer. È l'unica cosa da serializzare verso un client. */
export function viewFor(state: CampaignState, viewer: Actor): CampaignView {
  const active = state.activeSceneId;
  return {
    campaignId: state.campaignId,
    name: state.name,
    version: state.version,
    viewer: { userId: viewer.userId, role: viewer.role },
    activeSceneId: active,
    members: state.members.map((m) => ({ userId: m.userId, displayName: m.displayName, role: m.role })),
    scenes: state.scenes.filter((s) => canSeeScene(s, viewer, active)).map(projectScene),
    tokens: state.tokens.filter((t) => canSeeToken(t, viewer, active)).map((t) => projectToken(t, viewer)),
  };
}
