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

export const CONDITION_LIST: ReadonlyArray<{ id: Condition; name: string }> = CONDITIONS.map((id) => ({ id, name: CONDITION_LABELS[id] }));

function isKnown(id: string): id is Condition {
  return (CONDITIONS as readonly string[]).includes(id);
}

/** Icona di una condizione; per un id sconosciuto (condizione personalizzata) una stella generica. */
export function ConditionIcon({ id, size = 16 }: { id: string; size?: number }): ReactNode {
  const Icon = isKnown(id) ? ICONS[id] : Sparkles;
  return <Icon size={size} aria-hidden="true" />;
}
