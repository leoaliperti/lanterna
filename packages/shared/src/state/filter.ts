import { z } from "zod";
import type { StateChange } from "./changes.js";
import type { Fog } from "./fog.js";
import type { Actor, Scene, Token } from "./schema.js";
import {
  FogViewSchema,
  SceneViewSchema,
  TokenViewSchema,
  WallViewSchema,
  canSeeScene,
  canSeeToken,
  isGm,
  projectFog,
  projectScene,
  projectToken,
  projectWall,
  type FogView,
  type SceneView,
  type TokenView,
  type WallView,
} from "./view.js";

/**
 * Eventi per un singolo utente (server -> client). Derivano SEMPRE dalle
 * proiezioni di `view.ts`: si calcola la vista del token/scena/muro/nebbia prima e
 * dopo il cambiamento e si invia solo la differenza. Così un token che diventa
 * nascosto (o finisce sotto la nebbia) è, per un giocatore, una "scomparsa"
 * (`token.deleted`) e uno che viene rivelato una "creazione" (`token.created`).
 */
export const ServerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("token.created"), token: TokenViewSchema }),
  z.strictObject({
    type: z.literal("token.updated"),
    tokenId: z.string(),
    changes: TokenViewSchema.partial(),
  }),
  z.strictObject({ type: z.literal("token.deleted"), tokenId: z.string() }),
  z.strictObject({ type: z.literal("scene.created"), scene: SceneViewSchema }),
  z.strictObject({
    type: z.literal("scene.updated"),
    sceneId: z.string(),
    changes: SceneViewSchema.partial(),
  }),
  z.strictObject({ type: z.literal("scene.deleted"), sceneId: z.string() }),
  z.strictObject({
    type: z.literal("scene.activated"),
    sceneId: z.string().nullable(),
    /** La scena attivata e i suoi token visibili: il client sostituisce quelli della scena precedente. */
    scene: SceneViewSchema.nullable(),
    tokens: z.array(TokenViewSchema),
    /** Nebbia e muri visibili della scena attivata (M6): sostituiscono quelli precedenti. */
    fog: FogViewSchema.nullable().optional(),
    walls: z.array(WallViewSchema).optional(),
  }),
  /** Nebbia di una scena sostituita per intero (`null` = nebbia tolta). */
  z.strictObject({ type: z.literal("fog.updated"), sceneId: z.string(), fog: FogViewSchema.nullable() }),
  z.strictObject({ type: z.literal("wall.created"), wall: WallViewSchema }),
  z.strictObject({ type: z.literal("wall.updated"), wall: WallViewSchema }),
  z.strictObject({ type: z.literal("wall.deleted"), wallId: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const rb = b as Record<string, unknown>;
  const ra = a as Record<string, unknown>;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && deepEqual(ra[k], rb[k]));
}

function diff<T extends object>(before: T, after: T): Partial<T> {
  const out: Partial<T> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof T>;
  for (const k of keys) {
    if (!deepEqual(before[k], after[k])) out[k] = after[k];
  }
  return out;
}

function tokenView(t: Token | null, viewer: Actor, activeSceneId: string | null, fog: Fog | null): TokenView | null {
  return t && canSeeToken(t, viewer, activeSceneId, fog) ? projectToken(t, viewer) : null;
}

function sceneView(s: Scene | null, viewer: Actor, activeSceneId: string | null, fog: Fog | null): SceneView | null {
  return s && canSeeScene(s, viewer, activeSceneId) ? projectScene(s, viewer, fog) : null;
}

function fogView(f: Fog | null, viewer: Actor, activeSceneId: string | null, scene: Scene | null): FogView | null {
  if (!f) return null;
  if (!isGm(viewer) && f.sceneId !== activeSceneId) return null;
  return projectFog(f, viewer, scene && scene.id === f.sceneId ? scene : null);
}

function tokenEvents(b: TokenView | null, a: TokenView | null): ServerEvent[] {
  if (!b && !a) return [];
  if (!b && a) return [{ type: "token.created", token: a }];
  if (b && !a) return [{ type: "token.deleted", tokenId: b.id }];
  const changes = diff(b as TokenView, a as TokenView);
  if (Object.keys(changes).length === 0) return [];
  return [{ type: "token.updated", tokenId: (a as TokenView).id, changes }];
}

function wallEvents(b: WallView | null, a: WallView | null): ServerEvent[] {
  if (!b && !a) return [];
  if (!b && a) return [{ type: "wall.created", wall: a }];
  if (b && !a) return [{ type: "wall.deleted", wallId: b.id }];
  return deepEqual(a, b) ? [] : [{ type: "wall.updated", wall: a as WallView }];
}

function sceneEvents(b: SceneView | null, a: SceneView | null): ServerEvent[] {
  if (!b && !a) return [];
  if (!b && a) return [{ type: "scene.created", scene: a }];
  if (b && !a) return [{ type: "scene.deleted", sceneId: b.id }];
  const changes = diff(b as SceneView, a as SceneView);
  if (Object.keys(changes).length === 0) return [];
  return [{ type: "scene.updated", sceneId: (a as SceneView).id, changes }];
}

function fogEvents(sceneId: string, b: FogView | null, a: FogView | null): ServerEvent[] {
  if (deepEqual(a, b)) return [];
  return [{ type: "fog.updated", sceneId, fog: a }];
}

/**
 * Traduce un cambiamento interno negli eventi che `viewer` può ricevere.
 * Mai un evento contiene dati che `viewFor` non mostrerebbe.
 */
export function filterEventFor(change: StateChange, viewer: Actor): ServerEvent[] {
  switch (change.type) {
    case "token": {
      const fog = change.fog ?? null;
      return tokenEvents(
        tokenView(change.before, viewer, change.activeSceneId, fog),
        tokenView(change.after, viewer, change.activeSceneId, fog),
      );
    }
    case "scene": {
      const fog = change.fog ?? null;
      const events = sceneEvents(
        sceneView(change.before, viewer, change.activeSceneId, fog),
        sceneView(change.after, viewer, change.activeSceneId, fog),
      );
      // Con la nebbia, mappa e dimensioni della scena entrano nelle tessere della vista della nebbia.
      if (fog && change.before && change.after) {
        events.push(
          ...fogEvents(
            fog.sceneId,
            fogView(fog, viewer, change.activeSceneId, change.before),
            fogView(fog, viewer, change.activeSceneId, change.after),
          ),
        );
      }
      return events;
    }
    case "activeScene": {
      const active = change.after;
      const fog = change.fog ?? null;
      const scene = change.scene && active !== null ? projectScene(change.scene, viewer, fog) : null;
      const tokens = change.tokens
        .filter((t) => canSeeToken(t, viewer, active, fog))
        .map((t) => projectToken(t, viewer));
      const walls = (change.walls ?? []).flatMap((w) => {
        const v = projectWall(w, viewer, active, fog);
        return v ? [v] : [];
      });
      return [
        {
          type: "scene.activated",
          sceneId: active,
          scene,
          tokens,
          fog: fog && change.scene ? fogView(fog, viewer, active, change.scene) : null,
          walls,
        },
      ];
    }
    case "wall":
      return wallEvents(
        change.before ? projectWall(change.before, viewer, change.activeSceneId, change.fog) : null,
        change.after ? projectWall(change.after, viewer, change.activeSceneId, change.fog) : null,
      );
    case "fog": {
      const active = change.activeSceneId;
      const scene = change.scene;
      if (!isGm(viewer) && change.sceneId !== active) return [];
      const events: ServerEvent[] = [];
      if (scene) events.push(...sceneEvents(sceneView(scene, viewer, active, change.before), sceneView(scene, viewer, active, change.after)));
      events.push(
        ...fogEvents(change.sceneId, fogView(change.before, viewer, active, scene), fogView(change.after, viewer, active, scene)),
      );
      for (const t of change.tokens) {
        events.push(...tokenEvents(tokenView(t, viewer, active, change.before), tokenView(t, viewer, active, change.after)));
      }
      for (const w of change.walls) {
        events.push(...wallEvents(projectWall(w, viewer, active, change.before), projectWall(w, viewer, active, change.after)));
      }
      return events;
    }
  }
}

/** Comodità: filtra una lista di cambiamenti. */
export function filterEventsFor(changes: readonly StateChange[], viewer: Actor): ServerEvent[] {
  return changes.flatMap((c) => filterEventFor(c, viewer));
}
