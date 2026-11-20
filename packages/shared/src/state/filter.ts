import { z } from "zod";
import type { StateChange } from "./changes.js";
import type { Actor, Scene, Token } from "./schema.js";
import {
  SceneViewSchema,
  TokenViewSchema,
  canSeeScene,
  canSeeToken,
  projectScene,
  projectToken,
  type SceneView,
  type TokenView,
} from "./view.js";

/**
 * Eventi per un singolo utente (server -> client). Derivano SEMPRE dalle
 * proiezioni di `view.ts`: si calcola la vista del token/scena prima e dopo
 * il cambiamento e si invia solo la differenza. Così un token che diventa
 * nascosto è, per un giocatore, una "scomparsa" (`token.deleted`) e uno che
 * viene rivelato una "creazione" (`token.created`).
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
  }),
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

function tokenView(t: Token | null, viewer: Actor, activeSceneId: string | null): TokenView | null {
  return t && canSeeToken(t, viewer, activeSceneId) ? projectToken(t, viewer) : null;
}

function sceneView(s: Scene | null, viewer: Actor, activeSceneId: string | null): SceneView | null {
  return s && canSeeScene(s, viewer, activeSceneId) ? projectScene(s) : null;
}

/**
 * Traduce un cambiamento interno negli eventi che `viewer` può ricevere
 * (zero o uno). Mai un evento contiene dati che `viewFor` non mostrerebbe.
 */
export function filterEventFor(change: StateChange, viewer: Actor): ServerEvent[] {
  switch (change.type) {
    case "token": {
      const b = tokenView(change.before, viewer, change.activeSceneId);
      const a = tokenView(change.after, viewer, change.activeSceneId);
      if (!b && !a) return [];
      if (!b && a) return [{ type: "token.created", token: a }];
      if (b && !a) return [{ type: "token.deleted", tokenId: b.id }];
      const changes = diff(b as TokenView, a as TokenView);
      if (Object.keys(changes).length === 0) return [];
      return [{ type: "token.updated", tokenId: (a as TokenView).id, changes }];
    }
    case "scene": {
      const b = sceneView(change.before, viewer, change.activeSceneId);
      const a = sceneView(change.after, viewer, change.activeSceneId);
      if (!b && !a) return [];
      if (!b && a) return [{ type: "scene.created", scene: a }];
      if (b && !a) return [{ type: "scene.deleted", sceneId: b.id }];
      const changes = diff(b as SceneView, a as SceneView);
      if (Object.keys(changes).length === 0) return [];
      return [{ type: "scene.updated", sceneId: (a as SceneView).id, changes }];
    }
    case "activeScene": {
      const active = change.after;
      const scene = change.scene && active !== null ? projectScene(change.scene) : null;
      const tokens = change.tokens
        .filter((t) => canSeeToken(t, viewer, active))
        .map((t) => projectToken(t, viewer));
      return [{ type: "scene.activated", sceneId: active, scene, tokens }];
    }
  }
}

/** Comodità: filtra una lista di cambiamenti. */
export function filterEventsFor(changes: readonly StateChange[], viewer: Actor): ServerEvent[] {
  return changes.flatMap((c) => filterEventFor(c, viewer));
}
