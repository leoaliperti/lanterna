import type { ReactNode } from "react";
import {
  ArrowDownToLine, BatteryLow, Ban, Eye, EyeOff, Ghost, Gem, Heart, Link, Moon, Skull, Sparkles, VolumeX, Zap, Hand
} from "lucide-react";
import { CONDITIONS, type Condition } from "@lanterna/shared";

/** Nome italiano e icona (Lucide) di ogni condizione. L'id e' quello del motore delle regole 5e. */
export const CONDITION_LABELS: Record<Condition, string> = {
  blinded: "Accecato",
  charmed: "Affascinato",
  deafened: "Assordato",
  exhaustion: "Esaurimento",
  frightened: "Spaventato",
  grappled: "Afferrato",
  incapacitated: "Incapacitato",
  invisible: "Invisibile",
  paralyzed: "Paralizzato",
  petrified: "Pietrificato",
  poisoned: "Avvelenato",
  prone: "Prono",
  restrained: "Trattenuto",
  stunned: "Stordito",
  unconscious: "Privo di sensi"
};

const ICONS: Record<Condition, typeof Eye> = {
  blinded: EyeOff,
  charmed: Heart,
  deafened: VolumeX,
  exhaustion: BatteryLow,
  frightened: Ghost,
  grappled: Hand,
  incapacitated: Ban,
  invisible: Eye,
  paralyzed: Zap,
  petrified: Gem,
  poisoned: Skull,
  prone: ArrowDownToLine,
  restrained: Link,
  stunned: Sparkles,
  unconscious: Moon
};

/**
 * Condizioni del token: le 15 della 5e più "Morto" (non è una condizione 5e, ma uno stato del token).
 * Esaurimento compare nell'elenco come le altre; il livello (1-6) si sceglie a parte.
 */
export const DEAD_ID = "dead";
export const CONDITION_LIST: ReadonlyArray<{ id: string; name: string }> = [
  ...CONDITIONS.map((id) => ({ id, name: CONDITION_LABELS[id] })),
  { id: DEAD_ID, name: "Morto" }
];

/** Simbolo disegnato sulla mappa al posto della lettera (le emoji si vedono su tutti i sistemi). */
export const CONDITION_SYMBOLS: Record<string, string> = {
  blinded: "🙈",
  charmed: "💖",
  deafened: "🔇",
  exhaustion: "🔋",
  frightened: "😱",
  grappled: "✊",
  incapacitated: "🚫",
  invisible: "👻",
  paralyzed: "⚡",
  petrified: "🗿",
  poisoned: "☠️",
  prone: "⬇️",
  restrained: "⛓️",
  stunned: "💫",
  unconscious: "💤",
  [DEAD_ID]: "💀"
};

export function conditionSymbol(id: string): string {
  return CONDITION_SYMBOLS[id] ?? "✦";
}

function isKnown(id: string): id is Condition {
  return (CONDITIONS as readonly string[]).includes(id);
}

/** Icona di una condizione; per un id sconosciuto (condizione personalizzata) una stella generica. */
export function ConditionIcon({ id, size = 16 }: { id: string; size?: number }): ReactNode {
  const Icon = id === DEAD_ID ? Skull : isKnown(id) ? ICONS[id] : Sparkles;
  return <Icon size={size} aria-hidden="true" />;
}
