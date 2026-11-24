import { applyDamage, decideInstantDeath, grantTempHp, heal, type HpState } from "../rules5e/hp.js";
import {
  DEAD_CONDITION,
  UNCONSCIOUS_CONDITION,
  type Effect,
  type EffectCondition,
  type TokenTarget,
} from "./combat.js";
import type { TokenPatch } from "./commands.js";
import { err, MESSAGES, type CommandError } from "./errors.js";
import { findVisibleToken } from "./reducer-util.js";
import { LIMITS, type Actor, type CampaignState, type Token, type TokenCondition } from "./schema.js";
import { isGm } from "./view.js";

/**
 * Operazioni pure sui token per il combattimento (M7): danno/cura con le regole dei PF 5e, condizioni,
 * effetti e selezione dei bersagli. Nessun permesso qui: li controlla il riduttore.
 */

export const hasCondition = (token: Pick<Token, "conditions">, id: string): boolean =>
  token.conditions.some((c) => c.id === id);

/** Aggiunge una condizione (se manca e c'è posto). */
export function withCondition(conditions: TokenCondition[], c: EffectCondition): TokenCondition[] {
  if (conditions.some((x) => x.id === c.id) || conditions.length >= LIMITS.maxConditions) return conditions;
  return [...conditions, { id: c.id, name: c.name }];
}

export const withoutCondition = (conditions: TokenCondition[], id: string): TokenCondition[] =>
  conditions.some((c) => c.id === id) ? conditions.filter((c) => c.id !== id) : conditions;

/** Una condizione è sostenuta da un effetto ancora attivo sul token? */
function effectProvides(token: Token, id: string): boolean {
  return (token.effects ?? []).some((e) => e.condition?.id === id);
}

function hpOf(token: Token): HpState {
  const h = token.health!;
  return {
    current: h.current,
    max: h.max,
    temp: h.temp,
    deathSaves: { successes: 0, failures: 0 },
    stable: false,
    dead: false,
  };
}

/** Patch con i soli campi cambiati; `null` se non cambia nulla. */
function patchOf(token: Token, health: Token["health"], conditions: TokenCondition[]): TokenPatch | null {
  const patch: TokenPatch = {};
  if (health && token.health && (health.current !== token.health.current || health.temp !== token.health.temp)) {
    patch.health = health;
  }
  if (conditions !== token.conditions) patch.conditions = conditions;
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Danno con le regole 5e (`applyDamage`): prima i PF temporanei, poi i PF; a 0 PF un PG diventa
 * "Privo di sensi", un mostro o un oggetto "Morto"; la morte istantanea (resto >= PF massimi) toglie il
 * Privo di sensi e mette "Morto". I tiri salvezza contro la morte stanno nella scheda (M8), non nel token.
 * Un token morto non subisce altro danno. Senza barra della vita non cambia nulla.
 */
export function damagePatch(token: Token, amount: number, critical = false): TokenPatch | null {
  if (!token.health || amount <= 0 || hasCondition(token, DEAD_CONDITION.id)) return null;
  const first = applyDamage(hpOf(token), amount, { critical });
  // Mostri e oggetti muoiono sul colpo; per un PG la morte istantanea la decide il GM (resta privo di sensi).
  const r = token.kind !== "pc" && first.instantDeathPending ? decideInstantDeath(first, true) : first;
  let conditions = token.conditions;
  if (r.dead) {
    conditions = withCondition(withoutCondition(conditions, UNCONSCIOUS_CONDITION.id), DEAD_CONDITION);
  } else if (r.current === 0 && token.health.current > 0) {
    conditions = withCondition(conditions, token.kind === "pc" ? UNCONSCIOUS_CONDITION : DEAD_CONDITION);
  }
  return patchOf(token, { current: r.current, max: token.health.max, temp: r.temp }, conditions);
}

/** Cura (non i morti, non oltre il massimo). Chi si rialza da 0 PF perde "Privo di sensi" se nulla lo sostiene. */
export function healPatch(token: Token, amount: number): TokenPatch | null {
  if (!token.health || amount <= 0 || hasCondition(token, DEAD_CONDITION.id)) return null;
  const r = heal(hpOf(token), amount);
  let conditions = token.conditions;
  if (token.health.current === 0 && r.current > 0 && !effectProvides(token, UNCONSCIOUS_CONDITION.id)) {
    conditions = withoutCondition(conditions, UNCONSCIOUS_CONDITION.id);
  }
  return patchOf(token, { current: r.current, max: token.health.max, temp: r.temp }, conditions);
}

/** PF temporanei: non si sommano, vale il più alto. */
export function tempHpPatch(token: Token, amount: number): TokenPatch | null {
  if (!token.health || amount <= 0 || hasCondition(token, DEAD_CONDITION.id)) return null;
  const r = grantTempHp(hpOf(token), amount);
  return patchOf(token, { current: token.health.current, max: token.health.max, temp: r.temp }, token.conditions);
}

// ---------------------------------------------------------------------------
// Effetti
// ---------------------------------------------------------------------------

/** Forma canonica del token: niente `effects` se vuoto. */
export function withEffects(token: Token, effects: Effect[], conditions: TokenCondition[] = token.conditions): Token {
  const { effects: _old, ...rest } = token;
  void _old;
  return effects.length > 0 ? { ...rest, conditions, effects } : { ...rest, conditions };
}

/**
 * Toglie un effetto e, se la sua condizione l'aveva aggiunta lui, anche la condizione. Se un altro effetto
 * del token regge la stessa condizione, il "possesso" passa a quello e la condizione resta.
 */
export function dropEffect(
  effects: Effect[],
  conditions: TokenCondition[],
  effect: Effect,
): { effects: Effect[]; conditions: TokenCondition[] } {
  let rest = effects.filter((e) => e.id !== effect.id);
  let conds = conditions;
  if (effect.condition && effect.addedCondition) {
    const heir = rest.find((e) => e.condition?.id === effect.condition!.id);
    if (heir) rest = rest.map((e) => (e.id === heir.id ? { ...e, addedCondition: true } : e));
    else conds = withoutCondition(conds, effect.condition.id);
  }
  return { effects: rest, conditions: conds };
}

// ---------------------------------------------------------------------------
// Selezione
// ---------------------------------------------------------------------------

/**
 * Risolve un bersaglio in id di token, senza duplicati.
 * - `tokens`: ogni id deve essere visibile all'attore (altrimenti NOT_FOUND, come per un token inesistente);
 * - `group` e `category`: solo GM (FORBIDDEN per gli altri, prima di guardare lo stato).
 * Serve sia al riduttore sia al client (selezione per categoria).
 */
export function resolveTarget(
  state: CampaignState,
  target: TokenTarget,
  actor: Actor,
): { ok: true; ids: string[] } | { ok: false; error: CommandError } {
  switch (target.kind) {
    case "tokens": {
      const ids = [...new Set(target.tokenIds)];
      for (const id of ids) if (!findVisibleToken(state, id, actor)) return err("NOT_FOUND", MESSAGES.tokenNotFound);
      return { ok: true, ids };
    }
    case "group": {
      if (!isGm(actor)) return err("FORBIDDEN", MESSAGES.gmOnly);
      const group = state.groups?.find((g) => g.id === target.groupId);
      if (!group) return err("NOT_FOUND", MESSAGES.groupNotFound);
      return { ok: true, ids: group.tokenIds.filter((id) => state.tokens.some((t) => t.id === id)) };
    }
    case "category": {
      if (!isGm(actor)) return err("FORBIDDEN", MESSAGES.gmOnly);
      if (!state.scenes.some((s) => s.id === target.sceneId)) return err("NOT_FOUND", MESSAGES.sceneNotFound);
      const ids = state.tokens
        .filter(
          (t) =>
            t.sceneId === target.sceneId &&
            (target.tokenKind === undefined || t.kind === target.tokenKind) &&
            (target.faction === undefined || t.faction === target.faction) &&
            (target.includeHidden !== false || !t.hidden),
        )
        .map((t) => t.id);
      return { ok: true, ids };
    }
  }
}
