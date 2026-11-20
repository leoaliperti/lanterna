import type { StateChange } from "./changes.js";
import type { Command } from "./commands.js";
import type { CommandError } from "./errors.js";
import { deepEqual } from "./filter.js";
import type { Combat, TokenGroup } from "./combat.js";
import { combatOf, fogOf, type Actor, type CampaignState, type Scene, type Token } from "./schema.js";
import { canSeeToken } from "./view.js";

/** Risultato di `applyCommand`. */
export type ApplyResult =
  | { ok: true; state: CampaignState; changes: StateChange[]; inverse: Command[] }
  | { ok: false; error: CommandError };

export type Ok = Extract<ApplyResult, { ok: true }>;

export function findScene(state: CampaignState, id: string): Scene | undefined {
  return state.scenes.find((s) => s.id === id);
}

/** Cerca un token tra quelli che l'attore può vedere. */
export function findVisibleToken(state: CampaignState, id: string, actor: Actor): Token | undefined {
  const t = state.tokens.find((x) => x.id === id);
  return t && canSeeToken(t, actor, state.activeSceneId, fogOf(state, t.sceneId)) ? t : undefined;
}

export function replaceToken(state: CampaignState, next: Token): CampaignState {
  return { ...state, tokens: state.tokens.map((t) => (t.id === next.id ? next : t)) };
}

export function isMember(state: CampaignState, userId: string): boolean {
  return state.members.some((m) => m.userId === userId);
}

export function tokenChange(state: CampaignState, before: Token | null, after: Token | null): StateChange {
  const sceneId = (after ?? before)?.sceneId;
  return { type: "token", before, after, activeSceneId: state.activeSceneId, fog: sceneId ? fogOf(state, sceneId) : null };
}

/** Campi del token che decidono cosa un giocatore vede del partecipante (nome, posizione, proprietà, nascosto). */
const sameVisibility = (a: Token, b: Token): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.hidden === b.hidden &&
  a.x === b.x &&
  a.y === b.y &&
  a.size === b.size &&
  a.ownerUserId === b.ownerUserId &&
  a.sceneId === b.sceneId;

function participantTokens(state: CampaignState, combat: Combat | null): Token[] {
  if (!combat) return [];
  const ids = new Set(combat.participants.flatMap((p) => (p.tokenId ? [p.tokenId] : [])));
  return state.tokens.filter((t) => ids.has(t.id));
}

/**
 * Cambiamenti derivati dal confronto fra stato prima e dopo: combattimenti e gruppi.
 * Un combattimento cambia "per gli altri" anche quando non cambia lui ma un token, la nebbia o la
 * scena attiva (decidono quali partecipanti vede un giocatore): il confronto li copre tutti.
 */
function derivedChanges(prev: CampaignState, next: CampaignState): StateChange[] {
  const out: StateChange[] = [];
  const sceneIds = new Set([...(prev.combats ?? []), ...(next.combats ?? [])].map((c) => c.sceneId));
  for (const sceneId of sceneIds) {
    const before = combatOf(prev, sceneId);
    const after = combatOf(next, sceneId);
    const fogBefore = fogOf(prev, sceneId);
    const fogAfter = fogOf(next, sceneId);
    const tokensBefore = participantTokens(prev, before);
    const tokensAfter = participantTokens(next, after);
    const same =
      deepEqual(before, after) &&
      prev.activeSceneId === next.activeSceneId &&
      deepEqual(fogBefore, fogAfter) &&
      tokensBefore.length === tokensAfter.length &&
      tokensBefore.every((t, i) => sameVisibility(t, tokensAfter[i]!));
    if (same) continue;
    out.push({
      type: "combat",
      sceneId,
      before,
      after,
      activeBefore: prev.activeSceneId,
      activeAfter: next.activeSceneId,
      fogBefore,
      fogAfter,
      tokensBefore,
      tokensAfter,
    });
  }
  const ids = new Set([...(prev.groups ?? []), ...(next.groups ?? [])].map((g) => g.id));
  for (const id of ids) {
    const before: TokenGroup | null = prev.groups?.find((g) => g.id === id) ?? null;
    const after: TokenGroup | null = next.groups?.find((g) => g.id === id) ?? null;
    if (!deepEqual(before, after)) out.push({ type: "group", before, after });
  }
  return out;
}

/**
 * Chiude un comando: se non è cambiato nulla restituisce lo stato invariato; altrimenti aggiunge i
 * cambiamenti derivati (combattimenti e gruppi), mette gli avvisi in fondo e alza la versione di 1.
 */
export function done(state: CampaignState, next: CampaignState, changes: StateChange[], inverse: Command[]): Ok {
  const derived = state === next ? [] : derivedChanges(state, next);
  const real = changes.filter((c) => c.type !== "notice");
  if (real.length === 0 && derived.length === 0) return { ok: true, state, changes: [], inverse: [] };
  const notices = changes.filter((c) => c.type === "notice");
  return {
    ok: true,
    state: { ...next, version: state.version + 1 },
    changes: [...real, ...derived, ...notices],
    inverse,
  };
}
