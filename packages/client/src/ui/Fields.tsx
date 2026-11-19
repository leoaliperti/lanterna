import { forwardRef, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff, Search, X } from "lucide-react";
import { cx, useControllable } from "./internal";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label: string;
  hideLabel?: boolean;
  helper?: ReactNode;
  error?: ReactNode;
  trailing?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hideLabel, helper, error, trailing, className, id, ...rest },
  ref
) {
  const auto = useId();
  const fid = id ?? auto;
  const hintId = `${fid}-hint`;
  const hint = error ?? helper;
  return (
    <div className={cx("l-field", error && "l-field--error", className)}>
      <label htmlFor={fid} className={cx("l-field__label", hideLabel && "l-sr-only")}>
        {label}
      </label>
      <div className="l-field__box">
        <input
          ref={ref}
          id={fid}
          className="l-field__input"
          aria-invalid={error ? true : undefined}
          aria-describedby={hint ? hintId : undefined}
          {...rest}
        />
        {trailing}
      </div>
      {hint ? (
        <p id={hintId} className="l-field__hint" role={error ? "alert" : undefined}>
          {hint}
        </p>
      ) : null}
    </div>
  );
});

export const SecureField = forwardRef<HTMLInputElement, Omit<TextFieldProps, "type" | "trailing">>(function SecureField(props, ref) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      ref={ref}
      {...props}
      type={shown ? "text" : "password"}
      autoComplete={props.autoComplete ?? "current-password"}
      trailing={
        <button
          type="button"
          className="l-field__action"
          aria-label={shown ? "Nascondi password" : "Mostra password"}
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      }
    />
  );
});

export interface SearchFieldProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
}

export function SearchField({ value, defaultValue = "", onValueChange, placeholder = "Cerca", label = "Cerca", className }: SearchFieldProps) {
  const [v, setV] = useControllable(value, defaultValue, onValueChange);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div role="search" className={cx("l-search", className)}>
      <Search size={16} className="l-search__icon" aria-hidden="true" />
      <input
        ref={ref}
        type="search"
        className="l-search__input"
        aria-label={label}
        placeholder={placeholder}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && v) {
            e.preventDefault();
            setV("");
          }
        }}
      />
      {v ? (
        <button
          type="button"
          className="l-search__clear"
          aria-label="Cancella testo"
          onClick={() => {
            setV("");
            ref.current?.focus();
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
