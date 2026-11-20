import { TextField } from "../ui";

export interface NumberFieldProps {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  min?: number;
  max?: number;
  step?: number;
  error?: string | null;
  helper?: string;
  disabled?: boolean;
  className?: string;
}

/** Campo numerico del design system: il valore resta una stringa finche' non si conferma il modulo. */
export function NumberField({ label, value, onValueChange, min, max, step, error, helper, disabled, className }: NumberFieldProps) {
  return (
    <TextField
      className={className}
      label={label}
      type="number"
      inputMode="decimal"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      helper={helper}
      error={error ?? undefined}
      onChange={(e) => onValueChange(e.target.value)}
    />
  );
}

/** Numero valido nell'intervallo, altrimenti `null`. */
export function parseNumber(text: string, min: number, max: number, integer = false): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  if (integer && !Number.isInteger(n)) return null;
  return n;
}
