import type { StateChange } from "./changes.js";
import { CommandSchema, type Command, type ScenePatch, type TokenPatch } from "./commands.js";
import { err, MESSAGES, type CommandError } from "./errors.js";
import { clampToScene, isInsideScene, normalizeRotation, snapToGrid } from "./grid.js";
import {
  GridSchema,
  LIMITS,
  type Actor,
  type CampaignState,
  type Scene,
  type Token,
} from "./schema.js";
import { canSeeToken, isGm } from "./view.js";

/**
 * Riduttore puro: `applyCommand(state, command, actor)`.
 * - non muta mai `state` (restituisce un nuovo oggetto);
 * - non lancia eccezioni: ogni input (anche non validato) produce `ok` o un errore tipizzato;
 * - controlla i PERMESSI: è l'unica fonte di verità, il server non deve rifarli altrove;
 * - restituisce i cambiamenti interni (da filtrare per utente) e i comandi inversi (per annulla).
 *
 * Ordine dei controlli, pensato per non rivelare nulla ai giocatori:
 * 1. forma del comando (Zod) -> INVALID, indipendente dallo stato;
 * 2. comandi solo-GM -> FORBIDDEN prima di guardare lo stato;
 * 3. ricerca dell'oggetto **tra quelli visibili all'attore** -> NOT_FOUND
 *    (un token nascosto e uno inesistente sono indistinguibili);
 * 4. proprietà e campi consentiti -> FORBIDDEN;
 * 5. vincoli che dipendono dallo stato (limiti mappa, id duplicati) -> INVALID / CONFLICT.
 */

export type ApplyResult =
  | { ok: true; state: CampaignState; changes: StateChange[]; inverse: Command[] }
  | { ok: false; error: CommandError };

/** Campi di un token che il proprietario (giocatore) può modificare con `token.update`. */
export const PLAYER_EDITABLE_TOKEN_FIELDS: readonly (keyof TokenPatch)[] = ["conditions"];

type Ok = Extract<ApplyResult, { ok: true }>;

function done(state: CampaignState, next: CampaignState, changes: StateChange[], inverse: Command[]): Ok {
  if (changes.length === 0) return { ok: true, state, changes: [], inverse: [] };
  return { ok: true, state: { ...next, version: state.version + 1 }, changes, inverse };
}

function findScene(state: CampaignState, id: string): Scene | undefined {
  return state.scenes.find((s) => s.id === id);
}

/** Cerca un token tra quelli che l'attore può vedere. */
function findVisibleToken(state: CampaignState, id: string, actor: Actor): Token | undefined {
  const t = state.tokens.find((x) => x.id === id);
  return t && canSeeToken(t, actor, state.activeSceneId) ? t : undefined;
}

function replaceToken(state: CampaignState, next: Token): CampaignState {
  return { ...state, tokens: state.tokens.map((t) => (t.id === next.id ? next : t)) };
}

function isMember(state: CampaignState, userId: string): boolean {
  return state.members.some((m) => m.userId === userId);
}

function tokenChange(state: CampaignState, before: Token | null, after: Token | null): StateChange {
  return { type: "token", before, after, activeSceneId: state.activeSceneId };
}

export function applyCommand(state: CampaignState, command: unknown, actor: Actor): ApplyResult {
  const parsed = CommandSchema.safeParse(command);
  if (!parsed.success) return err("INVALID", MESSAGES.invalidCommand);
  try {
    return apply(state, parsed.data, actor);
  } catch {
    // Difesa in profondità: nessuna eccezione deve uscire dal riduttore.
    return err("INVALID", MESSAGES.invalidCommand);
  }
}

function apply(state: CampaignState, cmd: Command, actor: Actor): ApplyResult {
  const gm = isGm(actor);
  switch (cmd.type) {
    case "token.move": {
      const token = findVisibleToken(state, cmd.tokenId, actor);
      if (!token) return err("NOT_FOUND", MESSAGES.tokenNotFound);
      if (!gm && token.ownerUserId !== actor.userId) return err("FORBIDDEN", MESSAGES.notOwner);
      const scene = findScene(state, token.sceneId);
      if (!scene) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      if (!isInsideScene(cmd.x, cmd.y, scene)) return err("INVALID", MESSAGES.outOfBounds);
      const snap = cmd.snap ?? scene.grid.snap;
      const raw = snap ? snapToGrid(cmd.x, cmd.y, token.size, scene.grid) : { x: cmd.x, y: cmd.y };
      const pos = clampToScene(raw.x, raw.y, scene);
      if (pos.x === token.x && pos.y === token.y) return done(state, state, [], []);
      const next: Token = { ...token, x: pos.x, y: pos.y };
      return done(state, replaceToken(state, next), [tokenChange(state, token, next)], [
        { type: "token.move", tokenId: token.id, x: token.x, y: token.y, snap: false },
      ]);
    }

    case "token.create": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const t = cmd.token;
      const scene = findScene(state, t.sceneId);
      if (!scene) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      if (state.tokens.some((x) => x.id === t.id)) return err("CONFLICT", MESSAGES.duplicateId);
      if (state.tokens.length >= LIMITS.maxTokens) return err("INVALID", MESSAGES.tooMany);
      if (!isInsideScene(t.x, t.y, scene)) return err("INVALID", MESSAGES.outOfBounds);
      if (t.ownerUserId !== null && !isMember(state, t.ownerUserId)) {
        return err("INVALID", MESSAGES.unknownOwner);
      }
      const next: Token = { ...t, rotation: normalizeRotation(t.rotation) };
      return done(state, { ...state, tokens: [...state.tokens, next] }, [tokenChange(state, null, next)], [
        { type: "token.delete", tokenId: next.id },
      ]);
    }

    case "token.update": {
      const token = findVisibleToken(state, cmd.tokenId, actor);
      if (!token) return err("NOT_FOUND", MESSAGES.tokenNotFound);
      const patch = cmd.patch;
      if (!gm) {
        if (token.ownerUserId !== actor.userId) return err("FORBIDDEN", MESSAGES.notOwner);
        const keys = Object.keys(patch) as (keyof TokenPatch)[];
        if (keys.some((k) => !PLAYER_EDITABLE_TOKEN_FIELDS.includes(k))) {
          return err("FORBIDDEN", MESSAGES.fieldForbidden);
        }
      }
      if (patch.ownerUserId != null && !isMember(state, patch.ownerUserId)) {
        return err("INVALID", MESSAGES.unknownOwner);
      }
      const next: Token = { ...token };
      const old: TokenPatch = {};
      for (const key of Object.keys(patch) as (keyof TokenPatch)[]) {
        const value = key === "rotation" ? normalizeRotation(patch.rotation as number) : patch[key];
        (next as Record<string, unknown>)[key] = value;
        (old as Record<string, unknown>)[key] = token[key];
      }
      if (JSON.stringify(next) === JSON.stringify(token)) return done(state, state, [], []);
      return done(state, replaceToken(state, next), [tokenChange(state, token, next)], [
        { type: "token.update", tokenId: token.id, patch: old },
      ]);
    }

    case "token.delete": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const token = state.tokens.find((t) => t.id === cmd.tokenId);
      if (!token) return err("NOT_FOUND", MESSAGES.tokenNotFound);
      return done(
        state,
        { ...state, tokens: state.tokens.filter((t) => t.id !== token.id) },
        [tokenChange(state, token, null)],
        [{ type: "token.create", token }],
      );
    }

    case "scene.create": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      if (state.scenes.some((s) => s.id === cmd.scene.id)) return err("CONFLICT", MESSAGES.duplicateId);
      if (state.scenes.length >= LIMITS.maxScenes) return err("INVALID", MESSAGES.tooMany);
      const scene = cmd.scene;
      return done(
        state,
        { ...state, scenes: [...state.scenes, scene] },
        [{ type: "scene", before: null, after: scene, activeSceneId: state.activeSceneId }],
        [{ type: "scene.delete", sceneId: scene.id }],
      );
    }

    case "scene.update": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const scene = findScene(state, cmd.sceneId);
      if (!scene) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      const next: Scene = { ...scene, ...cmd.patch };
      if (JSON.stringify(next) === JSON.stringify(scene)) return done(state, state, [], []);
      const old: Record<string, unknown> = {};
      for (const k of Object.keys(cmd.patch) as (keyof Scene)[]) old[k] = scene[k];
      const oldPatch = old as ScenePatch;
      let s1: CampaignState = { ...state, scenes: state.scenes.map((s) => (s.id === scene.id ? next : s)) };
      const changes: StateChange[] = [
        { type: "scene", before: scene, after: next, activeSceneId: state.activeSceneId },
      ];
      const inverse: Command[] = [{ type: "scene.update", sceneId: scene.id, patch: oldPatch }];
      // Se la mappa si rimpicciolisce, i token restano dentro i nuovi limiti.
      for (const t of state.tokens) {
        if (t.sceneId !== scene.id || isInsideScene(t.x, t.y, next)) continue;
        const pos = clampToScene(t.x, t.y, next);
        const moved: Token = { ...t, ...pos };
        s1 = replaceToken(s1, moved);
        changes.push(tokenChange(state, t, moved));
        inverse.push({ type: "token.move", tokenId: t.id, x: t.x, y: t.y, snap: false });
      }
      return done(state, s1, changes, inverse);
    }

    case "scene.setGrid": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const scene = findScene(state, cmd.sceneId);
      if (!scene) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      const grid = GridSchema.safeParse({ ...scene.grid, ...cmd.grid });
      if (!grid.success) return err("INVALID", MESSAGES.invalidCommand);
      const next: Scene = { ...scene, grid: grid.data };
      if (JSON.stringify(next) === JSON.stringify(scene)) return done(state, state, [], []);
      return done(
        state,
        { ...state, scenes: state.scenes.map((s) => (s.id === scene.id ? next : s)) },
        [{ type: "scene", before: scene, after: next, activeSceneId: state.activeSceneId }],
        [{ type: "scene.setGrid", sceneId: scene.id, grid: { ...scene.grid } }],
      );
    }

    case "scene.delete": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const scene = findScene(state, cmd.sceneId);
      if (!scene) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      const wasActive = state.activeSceneId === scene.id;
      const changes: StateChange[] = [];
      const inverse: Command[] = [{ type: "scene.create", scene }];
      let s1: CampaignState = state;
      if (wasActive) {
        // Prima si disattiva: i giocatori ricevono "nessuna scena" e nient'altro.
        changes.push({ type: "activeScene", before: scene.id, after: null, scene: null, tokens: [] });
        s1 = { ...s1, activeSceneId: null };
      }
      const removed = state.tokens.filter((t) => t.sceneId === scene.id);
      for (const t of removed) {
        changes.push(tokenChange(s1, t, null));
        inverse.push({ type: "token.create", token: t });
      }
      if (wasActive) inverse.push({ type: "scene.activate", sceneId: scene.id });
      changes.push({ type: "scene", before: scene, after: null, activeSceneId: s1.activeSceneId });
      s1 = {
        ...s1,
        scenes: s1.scenes.filter((s) => s.id !== scene.id),
        tokens: s1.tokens.filter((t) => t.sceneId !== scene.id),
      };
      return done(state, s1, changes, inverse);
    }

    case "scene.activate": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const target = cmd.sceneId === null ? null : findScene(state, cmd.sceneId);
      if (target === undefined) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      const after = target ? target.id : null;
      if (after === state.activeSceneId) return done(state, state, [], []);
      return done(
        state,
        { ...state, activeSceneId: after },
        [
          {
            type: "activeScene",
            before: state.activeSceneId,
            after,
            scene: target,
            tokens: target ? state.tokens.filter((t) => t.sceneId === target.id) : [],
          },
        ],
        [{ type: "scene.activate", sceneId: state.activeSceneId }],
      );
    }
  }
}

/**
 * Applica più comandi in modo atomico: o tutti o nessuno.
 * Gli inversi sono in ordine di applicazione inverso (pronti per essere riapplicati).
 */
export function applyCommands(state: CampaignState, commands: readonly unknown[], actor: Actor): ApplyResult {
  let cur = state;
  const changes: StateChange[] = [];
  const inverse: Command[] = [];
  for (const c of commands) {
    const r = applyCommand(cur, c, actor);
    if (!r.ok) return r;
    cur = r.state;
    changes.push(...r.changes);
    inverse.unshift(...r.inverse);
  }
  if (changes.length === 0) return { ok: true, state, changes: [], inverse: [] };
  return { ok: true, state: { ...cur, version: state.version + 1 }, changes, inverse };
}
