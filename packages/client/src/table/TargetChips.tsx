import type { Member } from "@lanterna/shared";
import { toggleTarget } from "./fogControls";

export interface TargetChipsProps {
  players: readonly Member[];
  /** Giocatori scelti; vuoto = tutti. */
  value: readonly string[];
  onChange: (ids: readonly string[]) => void;
  className?: string;
}

/** Selettore a chip dei destinatari: "Tutti" oppure uno o piu' giocatori. */
export function TargetChips({ players, value, onChange, className }: TargetChipsProps) {
  const ids = players.map((p) => p.userId);
  return (
    <fieldset className={["a-chips", className].filter(Boolean).join(" ")}>
      <legend className="a-chips__legend t-caption1 a-muted">Per chi</legend>
      <div className="a-chips__row">
        <button type="button" className="a-chip a-chip--sm" aria-pressed={value.length === 0} onClick={() => onChange([])}>
          Tutti
        </button>
        {players.map((p) => (
          <button
            key={p.userId}
            type="button"
            className="a-chip a-chip--sm"
            aria-pressed={value.includes(p.userId)}
            onClick={() => onChange(toggleTarget(value, p.userId, ids))}
          >
            {p.displayName}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
