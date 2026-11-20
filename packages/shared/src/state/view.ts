import { z } from "zod";
import {
  FOG_TILE_SIZE,
  FogLightingSchema,
  FogMaskSchema,
  PlayerMaskSchema,
  fnv1a,
  maskFor,
  rectRevealed,
  tileGrid,
  type Fog,
} from "./fog.js";
import {
  CombatViewSchema,
  EffectViewSchema,
  GroupSchema,
  type Combat,
  type CombatView,
  type Effect,
  type EffectView,
} from "./combat.js";
import type { Actor, CampaignState, Scene, Token } from "./schema.js";
import { MemberSchema, RoleSchema, SceneSchema, TokenSchema, fogOf } from "./schema.js";
import { clipSegmentToMask, type Wall } from "./walls.js";

/**
 * Proiezioni per utente. Regole:
 * - il GM (`admin`) vede tutto;
 * - un giocatore vede solo la scena attiva e i token NON nascosti di quella scena;
 * - con la nebbia (M6) un giocatore vede un token solo se almeno una cella sotto la sua
 *   impronta è rivelata a lui (o se il token è suo); la mappa non gli arriva come URL
 *   dell'immagine intera ma come tessere servite dal server (`fog.tiles`); dei muri riceve
 *   solo i pezzi nelle celle rivelate; della nebbia riceve solo la propria maschera;
 * - la vita (`health`) arriva solo al GM e al proprietario del token (agli altri `null`);
 * - vista e luce (`vision`) come la vita: solo GM e proprietario (agli altri `null`);
 * - le note del GM (`gmNotes`) arrivano solo al GM (agli altri il campo manca del tutto);
 * - condizioni e stati sono visibili a tutti quelli che vedono il token.
 *
 * Le proiezioni copiano i campi uno per uno (lista bianca): un campo nuovo
 * aggiunto al modello non arriva ai giocatori finché non lo si aggiunge qui.
 */

export const TokenViewSchema = TokenSchema.omit({ gmNotes: true, effects: true, faction: true }).extend({
  gmNotes: z.string().optional(),
  /** Effetti temporanei visibili all'utente (M7). Il server lo manda sempre, anche vuoto. */
  effects: z.array(EffectViewSchema).optional(),
  /** Fazione (M7): solo GM. */
  faction: z.string().nullable().optional(),
});
export type TokenView = z.infer<typeof TokenViewSchema>;

export const SceneViewSchema = SceneSchema;
export type SceneView = z.infer<typeof SceneViewSchema>;

/** Muro visto da un utente: il GM riceve il segmento intero, il giocatore solo i pezzi rivelati. */
export const WallViewSchema = z.strictObject({
  id: z.string(),
  sceneId: z.string(),
  door: z.boolean(),
  open: z.boolean(),
  /** Segmenti piatti `x1, y1, x2, y2, ...` (uno solo per il GM). */
  segments: z.array(z.number()),
});
export type WallView = z.infer<typeof WallViewSchema>;

/** Tessere della mappa servite dal server (`GET /campaigns/:id/scenes/:sceneId/tiles/:col/:row`). */
export const FogTilesSchema = z.strictObject({
  size: z.number(),
  cols: z.number().int(),
  rows: z.number().int(),
  /** Cambia quando cambia l'immagine o la dimensione della mappa (per invalidare la cache del client). */
  key: z.string(),
});

/**
 * Nebbia vista da un utente.
 * - Giocatore: `mask` è la SUA maschera; `players` manca.
 * - GM: `mask` è la maschera "di tutti" (`everyone`) e `players` le maschere personali.
 */
export const FogViewSchema = z.strictObject({
  sceneId: z.string(),
  cellSize: z.number(),
  offsetX: z.number(),
  offsetY: z.number(),
  lighting: FogLightingSchema,
  mask: FogMaskSchema,
  players: z.array(PlayerMaskSchema).optional(),
  tiles: FogTilesSchema.nullable(),
});
export type FogView = z.infer<typeof FogViewSchema>;

export const CampaignViewSchema = z.strictObject({
  campaignId: z.string(),
  name: z.string(),
  version: z.number().int().min(0),
  viewer: z.strictObject({ userId: z.string(), role: RoleSchema }),
  activeSceneId: z.string().nullable(),
  members: z.array(MemberSchema),
  scenes: z.array(SceneViewSchema),
  tokens: z.array(TokenViewSchema),
  /** Nebbia delle scene visibili (M6). Sempre presente nelle viste del server. */
  fogs: z.array(FogViewSchema).optional(),
  /** Muri visibili (M6). Sempre presente nelle viste del server. */
  walls: z.array(WallViewSchema).optional(),
  /** Combattimenti visibili (M7): il GM tutti, il giocatore solo quello della scena attiva. */
  combats: z.array(CombatViewSchema).optional(),
  /** Gruppi di token (M7): solo GM. */
  groups: z.array(GroupSchema).optional(),
});
export type CampaignView = z.infer<typeof CampaignViewSchema>;

export function isGm(viewer: Actor): boolean {
  return viewer.role === "admin";
}

/** Nebbia che vale per un oggetto della scena `sceneId` (null se assente o di un'altra scena). */
const fogFor = (fog: Fog | null | undefined, sceneId: string): Fog | null =>
  fog && fog.sceneId === sceneId ? fog : null;

/**
 * Il viewer può sapere che il token esiste?
 * `fog` è la nebbia della scena del token (o `null`): va passata sempre, anche se assente.
 */
export function canSeeToken(token: Token, viewer: Actor, activeSceneId: string | null, fog: Fog | null): boolean {
  if (isGm(viewer)) return true;
  if (token.hidden || activeSceneId === null || token.sceneId !== activeSceneId) return false;
  const f = fogFor(fog, token.sceneId);
  if (!f || token.ownerUserId === viewer.userId) return true;
  // Impronta del token (quadrato di `size` celle della nebbia, senza rotazione).
  const half = (token.size * f.cellSize) / 2;
  return rectRevealed(maskFor(f, viewer.userId), f, token.x - half, token.y - half, token.x + half, token.y + half);
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
  const privileged = canSeeHealth(token, viewer);
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
    health: privileged && token.health ? { ...token.health } : null,
    vision: privileged && token.vision ? { ...token.vision } : null,
    effects: projectEffects(token.effects ?? [], viewer),
  };
  if (isGm(viewer)) {
    view.gmNotes = token.gmNotes;
    view.faction = token.faction ?? null;
  }
  return view;
}

/** Il GM vede tutti gli effetti (con segreto e ancora); il giocatore solo quelli non segreti, senza dettagli interni. */
export function projectEffects(effects: readonly Effect[], viewer: Actor): EffectView[] {
  if (isGm(viewer)) {
    return effects.map((e) => ({
      id: e.id,
      name: e.name,
      condition: e.condition ? { id: e.condition.id, name: e.condition.name } : null,
      remaining: e.remaining,
      timing: e.timing,
      secret: e.secret,
      turnOf: e.turnOf,
    }));
  }
  return effects
    .filter((e) => !e.secret)
    .map((e) => ({
      id: e.id,
      name: e.name,
      condition: e.condition ? { id: e.condition.id, name: e.condition.name } : null,
      remaining: e.remaining,
      timing: e.timing,
    }));
}

/**
 * Proiezione di un combattimento, o `null` se il viewer non lo vede.
 * Giocatore: solo la scena attiva; i partecipanti nascosti, quelli di token che non vede (nascosti o sotto la
 * nebbia) e i valori di iniziativa nascosti dal GM non gli arrivano; se il turno è di uno di loro `turnId` è `null`.
 * Il nome di un partecipante-token è quello del token (visibile).
 */
export function projectCombat(
  combat: Combat | null,
  tokens: readonly Token[],
  viewer: Actor,
  activeSceneId: string | null,
  fog: Fog | null,
): CombatView | null {
  if (!combat) return null;
  const gm = isGm(viewer);
  if (!gm && combat.sceneId !== activeSceneId) return null;
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const participants: CombatView["participants"] = [];
  for (const p of combat.participants) {
    const token = p.tokenId ? byId.get(p.tokenId) : undefined;
    if (p.tokenId && !token) continue; // incoerente: non si mostra
    if (gm) {
      participants.push({
        id: p.id,
        tokenId: p.tokenId,
        name: token ? token.name : (p.name as string),
        initiative: p.initiative,
        hidden: p.hidden,
        hideInitiative: p.hideInitiative,
      });
      continue;
    }
    if (p.hidden) continue;
    if (token && !canSeeToken(token, viewer, activeSceneId, fog)) continue;
    participants.push({
      id: p.id,
      tokenId: p.tokenId,
      name: token ? token.name : (p.name as string),
      initiative: p.hideInitiative ? null : p.initiative,
    });
  }
  const turnVisible = combat.turnId !== null && participants.some((p) => p.id === combat.turnId);
  return {
    sceneId: combat.sceneId,
    started: combat.started,
    round: combat.round,
    turnId: gm || turnVisible ? combat.turnId : null,
    participants,
  };
}

/**
 * Proiezione di una scena. Con la nebbia, al giocatore NON arriva l'immagine della mappa
 * (`map: null`): la vede solo a tessere, filtrate dal server (vedi `FogView.tiles`).
 */
export function projectScene(scene: Scene, viewer: Actor, fog: Fog | null): SceneView {
  const fogged = fogFor(fog, scene.id) !== null && !isGm(viewer);
  return {
    id: scene.id,
    name: scene.name,
    map: scene.map && !fogged ? { assetId: scene.map.assetId, url: scene.map.url } : null,
    width: scene.width,
    height: scene.height,
    grid: { ...scene.grid },
    scale: { ...scene.scale },
  };
}

/** Chiave delle tessere: cambia con immagine e dimensioni della mappa, senza rivelare l'asset. */
function tilesKey(scene: Scene): string {
  return fnv1a(`${scene.map?.assetId ?? ""}|${scene.width}|${scene.height}`);
}

/** Proiezione della nebbia di una scena visibile al viewer. */
export function projectFog(fog: Fog, viewer: Actor, scene: Scene | null): FogView {
  const gm = isGm(viewer);
  const mask = gm ? fog.everyone : maskFor(fog, viewer.userId);
  const grid = scene ? tileGrid(scene.width, scene.height) : null;
  const view: FogView = {
    sceneId: fog.sceneId,
    cellSize: fog.cellSize,
    offsetX: fog.offsetX,
    offsetY: fog.offsetY,
    lighting: fog.lighting,
    mask: { base: mask.base, runs: [...mask.runs] },
    tiles:
      scene && scene.map && grid
        ? { size: FOG_TILE_SIZE, cols: grid.cols, rows: grid.rows, key: tilesKey(scene) }
        : null,
  };
  if (gm) view.players = fog.players.map((p) => ({ userId: p.userId, mask: { base: p.mask.base, runs: [...p.mask.runs] } }));
  return view;
}

/**
 * Proiezione di un muro, o `null` se il viewer non ne vede nulla.
 * Giocatore: solo scena attiva; con la nebbia solo i pezzi nelle celle rivelate a lui.
 */
export function projectWall(wall: Wall, viewer: Actor, activeSceneId: string | null, fog: Fog | null): WallView | null {
  const base = { id: wall.id, sceneId: wall.sceneId, door: wall.door, open: wall.open };
  if (isGm(viewer)) return { ...base, segments: [wall.x1, wall.y1, wall.x2, wall.y2] };
  if (activeSceneId === null || wall.sceneId !== activeSceneId) return null;
  const f = fogFor(fog, wall.sceneId);
  if (!f) return { ...base, segments: [wall.x1, wall.y1, wall.x2, wall.y2] };
  const segments = clipSegmentToMask(wall.x1, wall.y1, wall.x2, wall.y2, f, maskFor(f, viewer.userId));
  return segments.length > 0 ? { ...base, segments } : null;
}

/** Stato visibile al viewer. È l'unica cosa da serializzare verso un client. */
export function viewFor(state: CampaignState, viewer: Actor): CampaignView {
  const active = state.activeSceneId;
  const visibleScenes = state.scenes.filter((s) => canSeeScene(s, viewer, active));
  const sceneIds = new Set(visibleScenes.map((s) => s.id));
  return {
    campaignId: state.campaignId,
    name: state.name,
    version: state.version,
    viewer: { userId: viewer.userId, role: viewer.role },
    activeSceneId: active,
    members: state.members.map((m) => ({ userId: m.userId, displayName: m.displayName, role: m.role })),
    scenes: visibleScenes.map((s) => projectScene(s, viewer, fogOf(state, s.id))),
    tokens: state.tokens
      .filter((t) => canSeeToken(t, viewer, active, fogOf(state, t.sceneId)))
      .map((t) => projectToken(t, viewer)),
    fogs: (state.fogs ?? [])
      .filter((f) => sceneIds.has(f.sceneId))
      .map((f) => projectFog(f, viewer, state.scenes.find((s) => s.id === f.sceneId) ?? null)),
    walls: (state.walls ?? []).flatMap((w) => {
      const v = projectWall(w, viewer, active, fogOf(state, w.sceneId));
      return v ? [v] : [];
    }),
    combats: (state.combats ?? []).flatMap((c) => {
      const v = projectCombat(c, state.tokens.filter((t) => t.sceneId === c.sceneId), viewer, active, fogOf(state, c.sceneId));
      return v ? [v] : [];
    }),
    ...(isGm(viewer) ? { groups: (state.groups ?? []).map((g) => ({ id: g.id, name: g.name, tokenIds: [...g.tokenIds] })) } : {}),
  };
}
