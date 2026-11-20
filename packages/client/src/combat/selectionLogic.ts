import {
  LIMITS,
  type Command,
  type GroupAction,
  type TokenGroup,
  type TokenView
} from "@lanterna/shared";
import { conditionName, effectInput, type EffectDraft } from "./effectsLogic";

/**
 * Selezione per categoria, gruppi salvati e azioni rapide: logica pura. Il server resta l'arbitro: ogni azione
 * e' un solo `group.apply` (atomico, annullabile in un colpo) e i permessi si verificano li'.
 */

export type KindFilter = "all" | "pc" | "monster" | "object";

export interface Category {
  kind: KindFilter;
  /** Fazione esatta; `null` = qualunque. */
  faction: string | null;
}

export const ALL_TOKENS: Category = { kind: "all", faction: null };

export const KIND_LABELS: Record<TokenView["kind"], string> = { pc: "Personaggio", monster: "Mostro", object: "Oggetto" };

/** Token della scena che corrispondono alla categoria. Il GM include anche quelli nascosti (solo lui li riceve). */
export function selectByCategory(tokens: readonly TokenView[], sceneId: string, cat: Category): TokenView[] {
  return tokens.filter((t) => t.sceneId === sceneId && (cat.kind === "all" || t.kind === cat.kind) && (cat.faction === null || t.faction === cat.faction));
}

/** Fazioni presenti nella scena, in ordine alfabetico. */
export function factionsOf(tokens: readonly TokenView[], sceneId: string): string[] {
  const set = new Set<string>();
  for (const t of tokens) if (t.sceneId === sceneId && t.faction) set.add(t.faction);
  return [...set].sort((a, b) => a.localeCompare(b, "it"));
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Ricerca per nome, fazione e tipo (senza distinguere maiuscole e accenti). */
export function filterTokens(tokens: readonly TokenView[], query: string): TokenView[] {
  const q = normalize(query);
  if (!q) return [...tokens];
  return tokens.filter((t) => normalize(`${t.name} ${t.faction ?? ""} ${KIND_LABELS[t.kind]}`).includes(q));
}

export function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/* ---------- gruppi ---------- */

export function createGroupCommand(id: string, name: string, tokenIds: readonly string[]): Command | null {
  const clean = name.trim();
  if (!clean || clean.length > LIMITS.nameMaxLength || tokenIds.length === 0 || tokenIds.length > LIMITS.maxGroupTokens) return null;
  return { type: "group.create", group: { id, name: clean, tokenIds: [...new Set(tokenIds)] } };
}

export function renameGroupCommand(groupId: string, name: string): Command | null {
  const clean = name.trim();
  if (!clean || clean.length > LIMITS.nameMaxLength) return null;
  return { type: "group.update", groupId, patch: { name: clean } };
}

export function replaceGroupTokensCommand(groupId: string, tokenIds: readonly string[]): Command | null {
  if (tokenIds.length === 0 || tokenIds.length > LIMITS.maxGroupTokens) return null;
  return { type: "group.update", groupId, patch: { tokenIds: [...new Set(tokenIds)] } };
}

export function deleteGroupCommand(groupId: string): Command {
  return { type: "group.delete", groupId };
}

/** Token del gruppo ancora presenti nella scena mostrata (il gruppo puo' contenerne di altre scene o cancellati). */
export function recallGroup(group: TokenGroup, tokens: readonly TokenView[], sceneId: string): string[] {
  const here = new Set(tokens.filter((t) => t.sceneId === sceneId).map((t) => t.id));
  return group.tokenIds.filter((id) => here.has(id));
}

/* ---------- azioni rapide ---------- */

export type ActionKind = "damage" | "heal" | "tempHp" | "condition" | "effect" | "move";

export const ACTION_LABELS: Record<ActionKind, string> = {
  damage: "Danno",
  heal: "Cura",
  tempHp: "PF temporanei",
  condition: "Condizione",
  effect: "Effetto",
  move: "Sposta"
};

/** Scorciatoie da tastiera (con il focus sulla mappa): una lettera per azione. */
export const ACTION_KEYS: Record<string, ActionKind> = { d: "damage", h: "heal", k: "condition", e: "effect", m: "move" };

export function actionForKey(key: string): ActionKind | null {
  return ACTION_KEYS[key.toLowerCase()] ?? null;
}

/** Il focus e' su un campo di testo: le scorciatoie a lettera non devono scattare. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export interface ActionDraft {
  kind: ActionKind;
  /** Danno, cura, PF temporanei. Come testo. */
  amount: string;
  critical: boolean;
  /** Condizione: aggiungere o togliere. */
  conditionId: string;
  removeCondition: boolean;
  effect: EffectDraft;
  /** Sposta: celle in orizzontale (destra positivo) e verticale (giu' positivo). */
  dx: string;
  dy: string;
}

export function parseAmount(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n <= LIMITS.hpMax ? n : null;
}

export function parseCells(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (t === "") return 0;
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Math.abs(n) <= 200 ? n : null;
}

/** Azione di gruppo per la bozza; `null` se i valori non sono validi. `cellSize` converte le celle in pixel. */
export function groupAction(d: ActionDraft, effectId: string, cellSize: number): GroupAction | null {
  switch (d.kind) {
    case "damage": {
      const amount = parseAmount(d.amount);
      return amount === null ? null : { kind: "damage", amount, ...(d.critical ? { critical: true } : {}) };
    }
    case "heal": {
      const amount = parseAmount(d.amount);
      return amount === null ? null : { kind: "heal", amount };
    }
    case "tempHp": {
      const amount = parseAmount(d.amount);
      return amount === null ? null : { kind: "tempHp", amount };
    }
    case "condition":
      if (!d.conditionId) return null;
      return d.removeCondition
        ? { kind: "removeCondition", conditionId: d.conditionId }
        : { kind: "addCondition", condition: { id: d.conditionId, name: conditionName(d.conditionId) } };
    case "effect":
      if (!d.effect.name.trim()) return null;
      return { kind: "addEffect", effect: effectInput(effectId, d.effect) };
    case "move": {
      const dx = parseCells(d.dx);
      const dy = parseCells(d.dy);
      if (dx === null || dy === null || (dx === 0 && dy === 0)) return null;
      return { kind: "move", dx: dx * cellSize, dy: dy * cellSize };
    }
  }
}

export function applyCommand(tokenIds: readonly string[], action: GroupAction): Command {
  return { type: "group.apply", target: { kind: "tokens", tokenIds: [...tokenIds] }, action };
}

/** Frase per la conferma dopo l'azione, ad esempio "Danno 7 a 3 token". */
export function describeAction(d: ActionDraft, count: number): string {
  const who = count === 1 ? "1 token" : `${count} token`;
  switch (d.kind) {
    case "damage":
      return `Danno ${d.amount.trim()}${d.critical ? " (critico)" : ""} a ${who}`;
    case "heal":
      return `Cura ${d.amount.trim()} a ${who}`;
    case "tempHp":
      return `${d.amount.trim()} PF temporanei a ${who}`;
    case "condition":
      return d.removeCondition ? `${conditionName(d.conditionId)} tolta a ${who}` : `${conditionName(d.conditionId)} su ${who}`;
    case "effect":
      return `Effetto «${d.effect.name.trim()}» su ${who}`;
    case "move":
      return `${who} spostati`;
  }
}
