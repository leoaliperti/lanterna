import { useEffect, useState } from "react";
import type { DerivedSheet, RollSpec, SheetDoc } from "@lanterna/shared";
import { TextField } from "../ui";
import { modeNote, signed } from "./sheetLogic";
import type { SheetRoller } from "./useSheetRoll";

export interface SectionProps {
  doc: SheetDoc;
  kind: "pc" | "monster";
  derived: DerivedSheet;
  change: (fn: (d: SheetDoc) => SheetDoc) => void;
  roller: SheetRoller;
  /** Testo della ricerca della scheda: ogni sezione filtra le proprie voci. */
  query: string;
}

export interface NumInputProps {
  label: string;
  value: number;
  onValueChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  hideLabel?: boolean;
  disabled?: boolean;
  className?: string;
  helper?: string;
}

/**
 * Campo numerico: mentre si scrive il testo resta libero; il valore passa alla scheda solo se è un numero valido
 * nell'intervallo (altrimenti il campo mostra l'errore e alla fine torna all'ultimo valore valido).
 */
export function NumInput({ label, value, onValueChange, min = -Infinity, max = Infinity, step = 1, hideLabel, disabled, className, helper }: NumInputProps) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  const parsed = text.trim() === "" ? null : Number(text);
  const valid = parsed !== null && Number.isFinite(parsed) && parsed >= min && parsed <= max && (step % 1 !== 0 || Number.isInteger(parsed));
  return (
    <TextField
      className={className}
      label={label}
      hideLabel={hideLabel}
      type="number"
      inputMode={step % 1 === 0 ? "numeric" : "decimal"}
      value={text}
      min={Number.isFinite(min) ? min : undefined}
      max={Number.isFinite(max) ? max : undefined}
      step={step}
      disabled={disabled}
      helper={helper}
      error={editing && !valid ? `Valore tra ${Number.isFinite(min) ? min : "..."} e ${Number.isFinite(max) ? max : "..."}` : undefined}
      onFocus={() => setEditing(true)}
      onBlur={() => {
        setEditing(false);
        setText(String(value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(n) && n >= min && n <= max && (step % 1 !== 0 || Number.isInteger(n))) onValueChange(n);
      }}
    />
  );
}

/** Testo di un bonus con segno e, se serve, vantaggio/svantaggio (per etichette e screen reader). */
export function bonusLabel(spec: RollSpec): string {
  const note = modeNote(spec);
  return note ? `${signed(spec.modifier)}, ${note}` : signed(spec.modifier);
}
