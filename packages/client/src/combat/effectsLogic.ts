import { LIMITS, type Command, type EffectInput, type EffectView, type TokenView } from "@lanterna/shared";
import type { Condition } from "@lanterna/shared";
import { CONDITION_LABELS } from "../table/conditions";

/** Bozza di un effetto temporaneo come la scrive il GM: numeri come testo, ancora per id. */
export interface EffectDraft {
  name: string;
  /** Id di una condizione 5e, oppure `null` (effetto senza condizione collegata). */
  conditionId: string | null;
  /** Durata in turni dell'ancora (round); vuoto = senza scadenza. */
  duration: string;
  timing: "start" | "end";
  /** `null` = il token stesso; altrimenti il token di cui conta il turno (es. l'incantatore). */
  anchorTokenId: string | null;
  secret: boolean;
}

export function emptyEffectDraft(): EffectDraft {
  return { name: "", conditionId: null, duration: "1", timing: "end", anchorTokenId: null, secret: false };
}

export interface EffectErrors {
  name: string | null;
  duration: string | null;
}

export function validateEffectDraft(d: EffectDraft): EffectErrors {
  const name = d.name.trim();
  const duration = d.duration.trim();
  const n = Number(duration);
  return {
    name: name ? (name.length > LIMITS.nameMaxLength ? "Nome troppo lungo" : null) : "Serve un nome",
    duration:
      duration === ""
        ? null
        : !/^\d+$/.test(duration) || n < 1 || n > LIMITS.maxEffectRounds
          ? `Un numero intero da 1 a ${LIMITS.maxEffectRounds}, oppure vuoto`
          : null
  };
}

export const hasEffectErrors = (e: EffectErrors): boolean => e.name !== null || e.duration !== null;

export function conditionName(id: string): string {
  return (CONDITION_LABELS as Record<string, string>)[id] ?? id;
}

export function effectInput(id: string, d: EffectDraft): EffectInput {
  const duration = d.duration.trim();
  return {
    id,
    name: d.name.trim(),
    condition: d.conditionId ? { id: d.conditionId, name: conditionName(d.conditionId) } : null,
    remaining: duration === "" ? null : Number(duration),
    timing: d.timing,
    turnOf: d.anchorTokenId,
    secret: d.secret
  };
}

export function addEffectCommand(tokenId: string, input: EffectInput): Command {
  return { type: "effect.add", tokenId, effect: input };
}

/** "3 round, a fine turno" oppure "senza scadenza". */
export function describeDuration(e: Pick<EffectView, "remaining" | "timing">): string {
  if (e.remaining === null) return "senza scadenza";
  return `${e.remaining} round, ${e.timing === "start" ? "a inizio turno" : "a fine turno"}`;
}

/** Testo breve della durata residua per il badge ("3 round"). */
export function remainingShort(e: Pick<EffectView, "remaining">): string {
  return e.remaining === null ? "∞" : `${e.remaining}`;
}

export function visibleEffects(token: Pick<TokenView, "effects">): EffectView[] {
  return token.effects ?? [];
}

export function knownCondition(id: string): id is Condition {
  return id in CONDITION_LABELS;
}
