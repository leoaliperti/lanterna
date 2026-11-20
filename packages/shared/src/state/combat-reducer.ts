import type { StateChange } from "./changes.js";
import type { Command } from "./commands.js";
import {
  sortByInitiative,
  type Combat,
  type Effect,
  type EffectTiming,
  type Participant,
  type TokenGroup,
} from "./combat.js";
import { dropEffect, withCondition, withEffects } from "./combat-ops.js";
import { err, MESSAGES } from "./errors.js";
import { deepEqual } from "./filter.js";
import { done, findScene, replaceToken, tokenChange, type ApplyResult } from "./reducer-util.js";
import { LIMITS, combatOf, fogOf, type Actor, type CampaignState, type Token } from "./schema.js";
import { isGm } from "./view.js";

/**
 * Riduttore del combattimento (M7): iniziativa, turni, effetti con durata, gruppi. Tutto solo GM.
 * Restituisce `null` se il comando non è di sua competenza.
 *
 * I cambiamenti di combattimenti e gruppi non si scrivono qui: li deriva `done` confrontando gli stati.
 * Qui si producono i cambiamenti dei token (effetti e condizioni) e gli avvisi.
 */

type Cmd = Command;

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

function writeCombat(state: CampaignState, sceneId: string, combat: Combat | null): CampaignState {
  const list = state.combats ?? [];
  if (list.some((c) => c.sceneId === sceneId)) {
    const next = combat ? list.map((c) => (c.sceneId === sceneId ? combat : c)) : list.filter((c) => c.sceneId !== sceneId);
    return { ...state, combats: next };
  }
  return combat ? { ...state, combats: [...list, combat] } : state;
}

const restoreCombat = (sceneId: string, combat: Combat | null): Cmd => ({ type: "combat.restore", sceneId, combat });

function insertIndex(list: readonly Participant[], initiative: number | null): number {
  if (initiative === null) return list.length;
  const i = list.findIndex((p) => p.initiative === null || p.initiative < initiative);
  return i < 0 ? list.length : i;
}

const tokenOfParticipant = (state: CampaignState, p: Participant): Token | null =>
  p.tokenId ? (state.tokens.find((t) => t.id === p.tokenId) ?? null) : null;

/**
 * Lavagna delle modifiche ai token durante un passo di turno: tiene lo stato corrente, i token com'erano
 * all'inizio (per i cambiamenti e l'inverso) e gli avvisi da inviare.
 */
export class Tick {
  readonly originals = new Map<string, Token>();
  readonly notices: StateChange[] = [];
  constructor(public state: CampaignState) {}

  setToken(next: Token): void {
    if (!this.originals.has(next.id)) {
      const cur = this.state.tokens.find((t) => t.id === next.id);
      if (cur) this.originals.set(next.id, cur);
    }
    this.state = replaceToken(this.state, next);
  }

  notice(notice: Extract<StateChange, { type: "notice" }>["notice"], token: Token | null): void {
    this.notices.push({
      type: "notice",
      notice,
      token,
      activeSceneId: this.state.activeSceneId,
      fog: token ? fogOf(this.state, token.sceneId) : null,
    });
  }

  /** Cambiamenti e inverso dei token toccati, da unire a quelli del combattimento. */
  finish(): { changes: StateChange[]; inverse: Cmd[] } {
    const changes: StateChange[] = [];
    const inverse: Cmd[] = [];
    for (const [id, orig] of this.originals) {
      const cur = this.state.tokens.find((t) => t.id === id);
      if (!cur || deepEqual(orig, cur)) continue;
      changes.push(tokenChange(this.state, orig, cur));
      inverse.push({ type: "token.update", tokenId: id, patch: { effects: orig.effects ?? [], conditions: orig.conditions } });
    }
    return { changes, inverse };
  }
}

/** Il momento `when` del turno di `participant`: fa scalare gli effetti che lo aspettano. */
function fireTriggers(tick: Tick, combat: Combat, participant: Participant, when: EffectTiming): void {
  const anchor = participant.tokenId;
  if (!anchor) return;
  for (const t of tick.state.tokens) {
    if (t.sceneId !== combat.sceneId || !t.effects?.length) continue;
    let effects: Effect[] = [...t.effects];
    let conditions = t.conditions;
    const notices: Parameters<Tick["notice"]>[0][] = [];
    let changed = false;
    for (const e of t.effects) {
      if ((e.turnOf ?? t.id) !== anchor || e.remaining === null) continue;
      if (e.timing === when) {
        const remaining = e.remaining - 1;
        changed = true;
        if (remaining <= 0) {
          ({ effects, conditions } = dropEffect(effects, conditions, e));
          notices.push({
            kind: "expired",
            sceneId: combat.sceneId,
            round: combat.round,
            tokenId: t.id,
            effectId: e.id,
            name: e.name,
            reason: "elapsed",
            secret: e.secret,
          });
        } else {
          effects = effects.map((x) => (x.id === e.id ? { ...x, remaining } : x));
          if (remaining === 1) {
            notices.push({
              kind: "expiring",
              sceneId: combat.sceneId,
              round: combat.round,
              tokenId: t.id,
              effectId: e.id,
              name: e.name,
              remaining,
              secret: e.secret,
            });
          }
        }
      } else if (when === "start" && e.remaining === 1) {
        // Scade alla fine di questo stesso turno: avviso senza cambiare lo stato.
        notices.push({
          kind: "expiring",
          sceneId: combat.sceneId,
          round: combat.round,
          tokenId: t.id,
          effectId: e.id,
          name: e.name,
          remaining: 1,
          secret: e.secret,
        });
      }
    }
    const next = changed ? withEffects(t, effects, conditions) : t;
    if (changed) tick.setToken(next);
    for (const n of notices) tick.notice(n, next);
  }
}

/** Fine del combattimento: gli effetti con durata terminano (con avviso) e le loro condizioni vengono tolte. */
function expireAll(tick: Tick, combat: Combat): void {
  for (const t of tick.state.tokens) {
    if (t.sceneId !== combat.sceneId || !t.effects?.some((e) => e.remaining !== null)) continue;
    let effects: Effect[] = [...t.effects];
    let conditions = t.conditions;
    const expired: Effect[] = [];
    for (const e of t.effects) {
      if (e.remaining === null) continue;
      ({ effects, conditions } = dropEffect(effects, conditions, e));
      expired.push(e);
    }
    const next = withEffects(t, effects, conditions);
    tick.setToken(next);
    for (const e of expired) {
      tick.notice(
        { kind: "expired", sceneId: combat.sceneId, round: combat.round, tokenId: t.id, effectId: e.id, name: e.name, reason: "combatEnded", secret: e.secret },
        next,
      );
    }
  }
}

function turnNotice(tick: Tick, combat: Combat, p: Participant): void {
  tick.notice(
    { kind: "turn", sceneId: combat.sceneId, round: combat.round, participantId: p.id, tokenId: p.tokenId },
    tokenOfParticipant(tick.state, p),
  );
}

/** Esito di un comando che passa per la lavagna dei token. */
function finishTick(base: CampaignState, tick: Tick, extraInverse: Cmd[]): ApplyResult {
  const { changes, inverse } = tick.finish();
  return done(base, tick.state, [...changes, ...tick.notices], [...extraInverse, ...inverse]);
}

/** Toglie il partecipante `id`; se era di turno il turno passa al successivo. Usato da `combat.remove` e dalla cancellazione dei token. */
export function removeParticipant(tick: Tick, combat: Combat, id: string): Combat | null {
  const idx = combat.participants.findIndex((p) => p.id === id);
  if (idx < 0) return combat;
  const participants = combat.participants.filter((p) => p.id !== id);
  if (!combat.started) return participants.length > 0 ? { ...combat, participants } : null;
  if (participants.length === 0) {
    expireAll(tick, combat);
    return null;
  }
  if (combat.turnId !== id) return { ...combat, participants };
  // Era di turno: il turno passa a chi lo segue (con il giro dei round se era l'ultimo).
  const wrapped = idx >= participants.length;
  const round = combat.round + (wrapped ? 1 : 0);
  const step = combat.step + 1;
  const next: Combat = {
    ...combat,
    participants,
    round: Math.min(round, LIMITS.maxRound),
    turnId: participants[wrapped ? 0 : idx]!.id,
    step,
    maxStep: Math.max(combat.maxStep, step),
  };
  if (step > combat.maxStep) fireTriggers(tick, next, participants[wrapped ? 0 : idx]!, "start");
  turnNotice(tick, next, participants[wrapped ? 0 : idx]!);
  return next;
}

// ---------------------------------------------------------------------------
// Comandi
// ---------------------------------------------------------------------------

export function applyCombatCommand(state: CampaignState, cmd: Cmd, actor: Actor): ApplyResult | null {
  switch (cmd.type) {
    case "combat.add":
    case "combat.update":
    case "combat.remove":
    case "combat.reorder":
    case "combat.setInitiative":
    case "combat.sort":
    case "combat.start":
    case "combat.next":
    case "combat.previous":
    case "combat.end":
    case "combat.restore":
      if (!isGm(actor)) return err("FORBIDDEN", MESSAGES.gmOnly);
      return combatCommand(state, cmd);
    case "effect.add":
    case "effect.update":
    case "effect.remove":
      if (!isGm(actor)) return err("FORBIDDEN", MESSAGES.gmOnly);
      return effectCommand(state, cmd);
    case "group.create":
    case "group.update":
    case "group.delete":
    case "group.restore":
      if (!isGm(actor)) return err("FORBIDDEN", MESSAGES.gmOnly);
      return groupCommand(state, cmd);
    default:
      return null;
  }
}

type CombatCmd = Extract<Cmd, { type: `combat.${string}` }>;

function combatCommand(state: CampaignState, cmd: CombatCmd): ApplyResult {
  const scene = findScene(state, cmd.sceneId);
  if (!scene) return err("NOT_FOUND", MESSAGES.sceneNotFound);
  const prev = combatOf(state, cmd.sceneId);
  const undo = restoreCombat(cmd.sceneId, prev);
  const write = (c: Combat | null): ApplyResult => done(state, writeCombat(state, cmd.sceneId, c), [], [undo]);

  switch (cmd.type) {
    case "combat.add": {
      const p = cmd.participant;
      if (p.tokenId !== null) {
        const t = state.tokens.find((x) => x.id === p.tokenId);
        if (!t || t.sceneId !== cmd.sceneId) return err("NOT_FOUND", MESSAGES.tokenNotFound);
      }
      const base: Combat = prev ?? { sceneId: cmd.sceneId, started: false, round: 0, turnId: null, step: 0, maxStep: 0, participants: [] };
      if (base.participants.some((x) => x.id === p.id || (p.tokenId !== null && x.tokenId === p.tokenId))) {
        return err("CONFLICT", MESSAGES.duplicateId);
      }
      if (base.participants.length >= LIMITS.maxParticipants) return err("INVALID", MESSAGES.tooMany);
      const participants = [...base.participants];
      participants.splice(insertIndex(participants, p.initiative), 0, p);
      return write({ ...base, participants });
    }

    case "combat.update": {
      if (!prev) return err("NOT_FOUND", MESSAGES.combatNotFound);
      const cur = prev.participants.find((p) => p.id === cmd.participantId);
      if (!cur) return err("NOT_FOUND", MESSAGES.participantNotFound);
      if (cmd.patch.name !== undefined && cur.tokenId !== null) return err("INVALID", MESSAGES.invalidCommand);
      const next: Participant = { ...cur, ...cmd.patch };
      return write({ ...prev, participants: prev.participants.map((p) => (p.id === cur.id ? next : p)) });
    }

    case "combat.remove": {
      if (!prev) return err("NOT_FOUND", MESSAGES.combatNotFound);
      if (!prev.participants.some((p) => p.id === cmd.participantId)) return err("NOT_FOUND", MESSAGES.participantNotFound);
      const tick = new Tick(state);
      const next = removeParticipant(tick, prev, cmd.participantId);
      tick.state = writeCombat(tick.state, cmd.sceneId, next);
      return finishTick(state, tick, [undo]);
    }

    case "combat.reorder": {
      if (!prev) return err("NOT_FOUND", MESSAGES.combatNotFound);
      const cur = prev.participants.find((p) => p.id === cmd.participantId);
      if (!cur) return err("NOT_FOUND", MESSAGES.participantNotFound);
      const rest = prev.participants.filter((p) => p.id !== cur.id);
      rest.splice(Math.min(cmd.toIndex, rest.length), 0, cur);
      return write({ ...prev, participants: rest });
    }

    case "combat.setInitiative": {
      if (!prev) return err("NOT_FOUND", MESSAGES.combatNotFound);
      const values = new Map(cmd.values.map((v) => [v.participantId, v.initiative]));
      for (const id of values.keys()) if (!prev.participants.some((p) => p.id === id)) return err("NOT_FOUND", MESSAGES.participantNotFound);
      let participants = prev.participants.map((p) => (values.has(p.id) ? { ...p, initiative: values.get(p.id)! } : p));
      if (cmd.sort) participants = sortByInitiative(participants);
      return write({ ...prev, participants });
    }

    case "combat.sort": {
      if (!prev) return err("NOT_FOUND", MESSAGES.combatNotFound);
      return write({ ...prev, participants: sortByInitiative(prev.participants) });
    }

    case "combat.start": {
      if (!prev) return err("NOT_FOUND", MESSAGES.combatNotFound);
      if (prev.started) return err("CONFLICT", MESSAGES.combatStarted);
      if (prev.participants.length === 0) return err("INVALID", MESSAGES.noParticipants);
      const participants = cmd.sort ? sortByInitiative(prev.participants) : prev.participants;
      const first = participants[0]!;
      const next: Combat = { ...prev, participants, started: true, round: 1, turnId: first.id, step: 0, maxStep: 0 };
      const tick = new Tick(writeCombat(state, cmd.sceneId, next));
      fireTriggers(tick, next, first, "start");
      turnNotice(tick, next, first);
      return finishTick(state, tick, [undo]);
    }

    case "combat.next": {
      if (!prev || !prev.started) return err(prev ? "CONFLICT" : "NOT_FOUND", prev ? MESSAGES.combatNotStarted : MESSAGES.combatNotFound);
      const idx = prev.participants.findIndex((p) => p.id === prev.turnId);
      const cur = prev.participants[idx]!;
      const wrapped = idx + 1 >= prev.participants.length;
      if (wrapped && prev.round >= LIMITS.maxRound) return err("INVALID", MESSAGES.tooMany);
      const nextP = prev.participants[wrapped ? 0 : idx + 1]!;
      const step = prev.step + 1;
      const fresh = step > prev.maxStep;
      const next: Combat = {
        ...prev,
        round: prev.round + (wrapped ? 1 : 0),
        turnId: nextP.id,
        step,
        maxStep: Math.max(prev.maxStep, step),
      };
      const tick = new Tick(writeCombat(state, cmd.sceneId, next));
      // Fine del turno di chi ha giocato (nel suo round), poi inizio del turno di chi segue.
      if (fresh) fireTriggers(tick, prev, cur, "end");
      if (fresh) fireTriggers(tick, next, nextP, "start");
      turnNotice(tick, next, nextP);
      return finishTick(state, tick, [undo]);
    }

    case "combat.previous": {
      if (!prev || !prev.started) return err(prev ? "CONFLICT" : "NOT_FOUND", prev ? MESSAGES.combatNotStarted : MESSAGES.combatNotFound);
      if (prev.step === 0) return err("CONFLICT", MESSAGES.firstTurn);
      const idx = prev.participants.findIndex((p) => p.id === prev.turnId);
      const wrapped = idx === 0;
      if (wrapped && prev.round <= 1) return err("CONFLICT", MESSAGES.firstTurn);
      const before = prev.participants[wrapped ? prev.participants.length - 1 : idx - 1]!;
      // Indietro non fa scalare né ripristina gli effetti: il massimo raggiunto evita di scalarli due volte.
      return write({ ...prev, round: prev.round - (wrapped ? 1 : 0), turnId: before.id, step: prev.step - 1 });
    }

    case "combat.end": {
      if (!prev) return err("NOT_FOUND", MESSAGES.combatNotFound);
      const tick = new Tick(writeCombat(state, cmd.sceneId, null));
      expireAll(tick, prev);
      return finishTick(state, tick, [undo]);
    }

    case "combat.restore": {
      if (cmd.combat) {
        if (cmd.combat.sceneId !== cmd.sceneId) return err("INVALID", MESSAGES.invalidCommand);
        for (const p of cmd.combat.participants) {
          if (p.tokenId === null) continue;
          const t = state.tokens.find((x) => x.id === p.tokenId);
          if (!t || t.sceneId !== cmd.sceneId) return err("INVALID", MESSAGES.tokenNotFound);
        }
      }
      return write(cmd.combat);
    }
  }
}

// ---------------------------------------------------------------------------
// Effetti
// ---------------------------------------------------------------------------

type EffectCmd = Extract<Cmd, { type: `effect.${string}` }>;

function effectCommand(state: CampaignState, cmd: EffectCmd): ApplyResult {
  const token = state.tokens.find((t) => t.id === cmd.tokenId);
  if (!token) return err("NOT_FOUND", MESSAGES.tokenNotFound);
  const old = { effects: token.effects ?? [], conditions: token.conditions };
  const undo: Cmd = { type: "token.update", tokenId: token.id, patch: { effects: old.effects, conditions: old.conditions } };
  const commit = (next: Token): ApplyResult => done(state, replaceToken(state, next), [tokenChange(state, token, next)], [undo]);

  switch (cmd.type) {
    case "effect.add": {
      const input = cmd.effect;
      if (old.effects.some((e) => e.id === input.id)) return err("CONFLICT", MESSAGES.duplicateId);
      if (old.effects.length >= LIMITS.maxEffectsPerToken) return err("INVALID", MESSAGES.tooMany);
      if (input.turnOf !== null) {
        const anchor = state.tokens.find((t) => t.id === input.turnOf);
        if (!anchor || anchor.sceneId !== token.sceneId) return err("INVALID", MESSAGES.unknownTurnOf);
      }
      let conditions = token.conditions;
      let addedCondition = false;
      if (input.condition && !conditions.some((c) => c.id === input.condition!.id)) {
        conditions = withCondition(conditions, input.condition);
        if (conditions === token.conditions) return err("INVALID", MESSAGES.tooMany);
        addedCondition = true;
      }
      return commit(withEffects(token, [...old.effects, { ...input, addedCondition }], conditions));
    }

    case "effect.update": {
      const cur = old.effects.find((e) => e.id === cmd.effectId);
      if (!cur) return err("NOT_FOUND", MESSAGES.effectNotFound);
      const next: Effect = { ...cur, ...cmd.patch };
      if (deepEqual(next, cur)) return done(state, state, [], []);
      return commit(withEffects(token, old.effects.map((e) => (e.id === cur.id ? next : e))));
    }

    case "effect.remove": {
      const cur = old.effects.find((e) => e.id === cmd.effectId);
      if (!cur) return err("NOT_FOUND", MESSAGES.effectNotFound);
      const r = dropEffect(old.effects, old.conditions, cur);
      return commit(withEffects(token, r.effects, r.conditions));
    }
  }
}

// ---------------------------------------------------------------------------
// Gruppi
// ---------------------------------------------------------------------------

type GroupCmd = Exclude<Extract<Cmd, { type: `group.${string}` }>, { type: "group.apply" }>;

function writeGroup(state: CampaignState, id: string, group: TokenGroup | null): CampaignState {
  const list = state.groups ?? [];
  if (list.some((g) => g.id === id)) return { ...state, groups: group ? list.map((g) => (g.id === id ? group : g)) : list.filter((g) => g.id !== id) };
  return group ? { ...state, groups: [...list, group] } : state;
}

const allTokensExist = (state: CampaignState, ids: readonly string[]): boolean =>
  ids.every((id) => state.tokens.some((t) => t.id === id));

function groupCommand(state: CampaignState, cmd: GroupCmd): ApplyResult {
  const find = (id: string) => (state.groups ?? []).find((g) => g.id === id) ?? null;
  const restore = (id: string, g: TokenGroup | null): Cmd => ({ type: "group.restore", groupId: id, group: g });

  switch (cmd.type) {
    case "group.create": {
      const g = cmd.group;
      if (find(g.id)) return err("CONFLICT", MESSAGES.duplicateId);
      if ((state.groups ?? []).length >= LIMITS.maxGroups) return err("INVALID", MESSAGES.tooMany);
      if (!allTokensExist(state, g.tokenIds)) return err("NOT_FOUND", MESSAGES.tokenNotFound);
      return done(state, writeGroup(state, g.id, g), [], [{ type: "group.delete", groupId: g.id }]);
    }
    case "group.update": {
      const cur = find(cmd.groupId);
      if (!cur) return err("NOT_FOUND", MESSAGES.groupNotFound);
      if (cmd.patch.tokenIds && !allTokensExist(state, cmd.patch.tokenIds)) return err("NOT_FOUND", MESSAGES.tokenNotFound);
      return done(state, writeGroup(state, cur.id, { ...cur, ...cmd.patch }), [], [restore(cur.id, cur)]);
    }
    case "group.delete": {
      const cur = find(cmd.groupId);
      if (!cur) return err("NOT_FOUND", MESSAGES.groupNotFound);
      return done(state, writeGroup(state, cur.id, null), [], [restore(cur.id, cur)]);
    }
    case "group.restore": {
      if (cmd.group) {
        if (cmd.group.id !== cmd.groupId) return err("INVALID", MESSAGES.invalidCommand);
        if (!allTokensExist(state, cmd.group.tokenIds)) return err("INVALID", MESSAGES.tokenNotFound);
        if (!find(cmd.groupId) && (state.groups ?? []).length >= LIMITS.maxGroups) return err("INVALID", MESSAGES.tooMany);
      }
      return done(state, writeGroup(state, cmd.groupId, cmd.group), [], [restore(cmd.groupId, find(cmd.groupId))]);
    }
  }
}
