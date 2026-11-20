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
import { deepEqual } from "./filter.js";
import {
  COVERED_MASK,
  FogGeometrySchema,
  REVEALED_MASK,
  maskCover,
  maskReveal,
  masksEqual,
  rasterizeShape,
  runCount,
  type Fog,
  type FogMask,
  type FogTarget,
  type PlayerMask,
} from "./fog.js";
import { WallSchema } from "./walls.js";
import type { WallPatch } from "./commands.js";
import { fogOf, wallsOf } from "./schema.js";

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
  return t && canSeeToken(t, actor, state.activeSceneId, fogOf(state, t.sceneId)) ? t : undefined;
}

function replaceToken(state: CampaignState, next: Token): CampaignState {
  return { ...state, tokens: state.tokens.map((t) => (t.id === next.id ? next : t)) };
}

function isMember(state: CampaignState, userId: string): boolean {
  return state.members.some((m) => m.userId === userId);
}

function tokenChange(state: CampaignState, before: Token | null, after: Token | null): StateChange {
  const sceneId = (after ?? before)?.sceneId;
  return { type: "token", before, after, activeSceneId: state.activeSceneId, fog: sceneId ? fogOf(state, sceneId) : null };
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
        (old as Record<string, unknown>)[key] = key === "vision" ? (token.vision ?? null) : token[key];
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
        { type: "scene", before: scene, after: next, activeSceneId: state.activeSceneId, fog: fogOf(state, scene.id) },
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
        [{ type: "scene", before: scene, after: next, activeSceneId: state.activeSceneId, fog: fogOf(state, scene.id) }],
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
        changes.push({ type: "activeScene", before: scene.id, after: null, scene: null, tokens: [], fog: null, walls: [] });
        s1 = { ...s1, activeSceneId: null };
      }
      const removed = state.tokens.filter((t) => t.sceneId === scene.id);
      for (const t of removed) {
        changes.push(tokenChange(s1, t, null));
        inverse.push({ type: "token.create", token: t });
      }
      const fog = fogOf(state, scene.id);
      for (const w of wallsOf(state, scene.id)) {
        changes.push({ type: "wall", before: w, after: null, activeSceneId: s1.activeSceneId, fog });
        inverse.push({ type: "wall.add", wall: w });
      }
      if (fog) {
        changes.push(fogChange(s1, scene.id, fog, null));
        inverse.push({ type: "fog.restore", fog });
      }
      if (wasActive) inverse.push({ type: "scene.activate", sceneId: scene.id });
      changes.push({ type: "scene", before: scene, after: null, activeSceneId: s1.activeSceneId, fog: null });
      s1 = {
        ...s1,
        scenes: s1.scenes.filter((s) => s.id !== scene.id),
        tokens: s1.tokens.filter((t) => t.sceneId !== scene.id),
        ...(state.fogs ? { fogs: state.fogs.filter((f) => f.sceneId !== scene.id) } : {}),
        ...(state.walls ? { walls: state.walls.filter((w) => w.sceneId !== scene.id) } : {}),
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
            fog: target ? fogOf(state, target.id) : null,
            walls: target ? wallsOf(state, target.id) : [],
          },
        ],
        [{ type: "scene.activate", sceneId: state.activeSceneId }],
      );
    }

    // -----------------------------------------------------------------------
    // Nebbia di guerra (M6): solo GM
    // -----------------------------------------------------------------------

    case "fog.enable": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const scene = findScene(state, cmd.sceneId);
      if (!scene) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      if (fogOf(state, scene.id)) return err("CONFLICT", MESSAGES.fogExists);
      const geometry = FogGeometrySchema.safeParse({
        cellSize: cmd.cellSize ?? scene.grid.cellSize,
        offsetX: cmd.offsetX ?? (cmd.cellSize === undefined ? scene.grid.offsetX : 0),
        offsetY: cmd.offsetY ?? (cmd.cellSize === undefined ? scene.grid.offsetY : 0),
      });
      if (!geometry.success) return err("INVALID", MESSAGES.invalidCommand);
      const fog: Fog = {
        sceneId: scene.id,
        ...geometry.data,
        lighting: cmd.lighting ?? "bright",
        everyone: cmd.initial === "covered" ? COVERED_MASK : REVEALED_MASK,
        players: [],
      };
      return setFog(state, scene.id, fog, [{ type: "fog.disable", sceneId: scene.id }]);
    }

    case "fog.disable": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const fog = fogOf(state, cmd.sceneId);
      if (!fog) return err("NOT_FOUND", MESSAGES.fogNotFound);
      return setFog(state, cmd.sceneId, null, [{ type: "fog.restore", fog }]);
    }

    case "fog.restore": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const scene = findScene(state, cmd.fog.sceneId);
      if (!scene) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      if (cmd.fog.players.some((p) => !isPlayer(state, p.userId))) return err("INVALID", MESSAGES.unknownPlayer);
      const before = fogOf(state, scene.id);
      const fog = normalizeFog(cmd.fog);
      return setFog(
        state,
        scene.id,
        fog,
        [before ? { type: "fog.restore", fog: before } : { type: "fog.disable", sceneId: scene.id }],
      );
    }

    case "fog.setLighting": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const fog = fogOf(state, cmd.sceneId);
      if (!fog) return err("NOT_FOUND", MESSAGES.fogNotFound);
      return setFog(state, cmd.sceneId, { ...fog, lighting: cmd.lighting }, [{ type: "fog.restore", fog }]);
    }

    case "fog.reveal":
    case "fog.cover":
    case "fog.revealAll":
    case "fog.coverAll": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const scene = findScene(state, cmd.sceneId);
      if (!scene) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      const fog = fogOf(state, scene.id);
      if (!fog) return err("NOT_FOUND", MESSAGES.fogNotFound);
      if (cmd.target.kind === "players" && cmd.target.userIds.some((u) => !isPlayer(state, u))) {
        return err("INVALID", MESSAGES.unknownPlayer);
      }
      let op: (m: FogMask) => FogMask;
      if (cmd.type === "fog.revealAll") op = () => REVEALED_MASK;
      else if (cmd.type === "fog.coverAll") op = () => COVERED_MASK;
      else {
        const cells = rasterizeShape(cmd.shape, fog, scene.width, scene.height);
        op = cmd.type === "fog.reveal" ? (m) => maskReveal(m, cells) : (m) => maskCover(m, cells);
      }
      const next = applyFogOp(fog, cmd.target, op);
      if (!next) return err("INVALID", MESSAGES.tooMany);
      return setFog(state, scene.id, next, [{ type: "fog.restore", fog }]);
    }

    // -----------------------------------------------------------------------
    // Muri e porte (M6): solo GM
    // -----------------------------------------------------------------------

    case "wall.add": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const w = cmd.wall;
      const scene = findScene(state, w.sceneId);
      if (!scene) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      const walls = state.walls ?? [];
      if (walls.some((x) => x.id === w.id)) return err("CONFLICT", MESSAGES.duplicateId);
      if (walls.length >= LIMITS.maxWalls) return err("INVALID", MESSAGES.tooMany);
      if (!isInsideScene(w.x1, w.y1, scene) || !isInsideScene(w.x2, w.y2, scene)) {
        return err("INVALID", MESSAGES.outOfBounds);
      }
      return done(
        state,
        { ...state, walls: [...walls, w] },
        [{ type: "wall", before: null, after: w, activeSceneId: state.activeSceneId, fog: fogOf(state, w.sceneId) }],
        [{ type: "wall.remove", wallId: w.id }],
      );
    }

    case "wall.update": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const wall = (state.walls ?? []).find((w) => w.id === cmd.wallId);
      if (!wall) return err("NOT_FOUND", MESSAGES.wallNotFound);
      const scene = findScene(state, wall.sceneId);
      if (!scene) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      const parsed = WallSchema.safeParse({ ...wall, ...cmd.patch });
      if (!parsed.success) return err("INVALID", MESSAGES.invalidCommand);
      const next = parsed.data;
      if (!isInsideScene(next.x1, next.y1, scene) || !isInsideScene(next.x2, next.y2, scene)) {
        return err("INVALID", MESSAGES.outOfBounds);
      }
      if (deepEqual(next, wall)) return done(state, state, [], []);
      const old: Record<string, unknown> = {};
      for (const k of Object.keys(cmd.patch) as (keyof WallPatch)[]) old[k] = wall[k];
      return done(
        state,
        { ...state, walls: (state.walls ?? []).map((w) => (w.id === wall.id ? next : w)) },
        [{ type: "wall", before: wall, after: next, activeSceneId: state.activeSceneId, fog: fogOf(state, wall.sceneId) }],
        [{ type: "wall.update", wallId: wall.id, patch: old as WallPatch }],
      );
    }

    case "wall.remove": {
      if (!gm) return err("FORBIDDEN", MESSAGES.gmOnly);
      const wall = (state.walls ?? []).find((w) => w.id === cmd.wallId);
      if (!wall) return err("NOT_FOUND", MESSAGES.wallNotFound);
      return done(
        state,
        { ...state, walls: (state.walls ?? []).filter((w) => w.id !== wall.id) },
        [{ type: "wall", before: wall, after: null, activeSceneId: state.activeSceneId, fog: fogOf(state, wall.sceneId) }],
        [{ type: "wall.add", wall }],
      );
    }
  }
}

function isPlayer(state: CampaignState, userId: string): boolean {
  return state.members.some((m) => m.userId === userId && m.role === "player");
}

function fogChange(state: CampaignState, sceneId: string, before: Fog | null, after: Fog | null): StateChange {
  return {
    type: "fog",
    sceneId,
    before,
    after,
    activeSceneId: state.activeSceneId,
    scene: findScene(state, sceneId) ?? null,
    tokens: state.tokens.filter((t) => t.sceneId === sceneId),
    walls: wallsOf(state, sceneId),
  };
}

/** Sostituisce (o toglie) la nebbia di una scena. */
function setFog(state: CampaignState, sceneId: string, fog: Fog | null, inverse: Command[]): ApplyResult {
  const before = fogOf(state, sceneId);
  if (deepEqual(before, fog)) return done(state, state, [], []);
  const others = (state.fogs ?? []).filter((f) => f.sceneId !== sceneId);
  const fogs = fog ? [...others, fog] : others;
  return done(state, { ...state, fogs }, [fogChange(state, sceneId, before, fog)], inverse);
}

/** Forma canonica: maschere personali ordinate e solo se diverse da quella di tutti. */
function normalizeFog(fog: Fog): Fog {
  const players = fog.players
    .filter((p) => !masksEqual(p.mask, fog.everyone))
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return { ...fog, players };
}

/** Applica `op` alle maschere dei destinatari; `null` se una maschera supera i limiti. */
function applyFogOp(fog: Fog, target: FogTarget, op: (m: FogMask) => FogMask): Fog | null {
  let everyone = fog.everyone;
  let players: PlayerMask[];
  if (target.kind === "all") {
    everyone = op(fog.everyone);
    players = fog.players.map((p) => ({ userId: p.userId, mask: op(p.mask) }));
  } else {
    const ids = new Set(target.userIds);
    players = fog.players.map((p) => (ids.has(p.userId) ? { userId: p.userId, mask: op(p.mask) } : p));
    for (const id of ids) {
      if (!fog.players.some((p) => p.userId === id)) players.push({ userId: id, mask: op(fog.everyone) });
    }
  }
  const next = normalizeFog({ ...fog, everyone, players });
  if (next.players.length > LIMITS.fogMaxPlayers) return null;
  if ([next.everyone, ...next.players.map((p) => p.mask)].some((m) => runCount(m.runs) > LIMITS.fogMaxRuns)) return null;
  return next;
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
