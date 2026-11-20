import { useId } from "react";
import type { Member } from "@lanterna/shared";

export interface RecipientSelectProps {
  targets: readonly Member[];
  value: string | null;
  onChange: (userId: string | null) => void;
  /** Testo dell'opzione "nessun destinatario" (per i tiri: scegli). */
  allLabel?: string;
  label?: string;
}

/** Destinatario di un whisper. Elenco gia' filtrato dalle regole (il giocatore vede solo i GM). Il server verifica comunque. */
export function RecipientSelect({ targets, value, onChange, allLabel = "Tutti", label = "Destinatario" }: RecipientSelectProps) {
  const id = useId();
  return (
    <div className="a-chat__recipient">
      <label htmlFor={id} className="t-caption1 a-muted">
        {label}
      </label>
      <select id={id} className="a-chat__select" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{allLabel}</option>
        {targets.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.displayName}
            {m.role === "admin" ? " (GM)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
