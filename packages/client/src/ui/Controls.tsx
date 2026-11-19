import { useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import { cx, useControllable } from "./internal";

/* ---------------- SegmentedControl ---------------- */

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: Array<SegmentOption<T>>;
  value?: T;
  defaultValue?: T;
  onValueChange?: (v: T) => void;
  "aria-label": string;
  className?: string;
}

export function SegmentedControl<T extends string>({ options, value, defaultValue, onValueChange, className, ...aria }: SegmentedControlProps<T>) {
  const [current, setCurrent] = useControllable<T | undefined>(value, defaultValue ?? options[0]?.value, onValueChange as ((v: T | undefined) => void) | undefined);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === current));

  const move = (from: number, dir: 1 | -1 | "first" | "last") => {
    const n = options.length;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = dir === "first" ? step : dir === "last" ? n - 1 - step : (i + dir + n) % n;
      if (!options[i]?.disabled) {
        setCurrent(options[i]!.value);
        refs.current[i]?.focus();
        return;
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const next = rtl ? "ArrowLeft" : "ArrowRight";
    const prev = rtl ? "ArrowRight" : "ArrowLeft";
    if (e.key === next || e.key === "ArrowDown") move(i, 1);
    else if (e.key === prev || e.key === "ArrowUp") move(i, -1);
    else if (e.key === "Home") move(i, "first");
    else if (e.key === "End") move(i, "last");
    else return;
    e.preventDefault();
  };

  const style = { "--seg-count": options.length, "--seg-index": index } as CSSProperties;
  return (
    <div role="radiogroup" aria-label={aria["aria-label"]} className={cx("l-seg", className)} style={style}>
      <span className="l-seg__thumb" aria-hidden="true" />
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === index}
          tabIndex={i === index ? 0 : -1}
          disabled={o.disabled}
          className="l-seg__item"
          onClick={() => setCurrent(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Toggle (switch) ---------------- */

export interface ToggleProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Toggle({ checked, defaultChecked = false, onCheckedChange, label, disabled, className }: ToggleProps) {
  const [on, setOn] = useControllable(checked, defaultChecked, onCheckedChange);
  const id = useId();
  return (
    <div className={cx("l-toggle", className)}>
      <span id={id} className="l-toggle__label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={id}
        disabled={disabled}
        className="l-toggle__switch"
        onClick={() => setOn(!on)}
      >
        <span className="l-toggle__track" aria-hidden="true">
          <span className="l-toggle__knob" />
        </span>
      </button>
    </div>
  );
}

/* ---------------- Slider ---------------- */

export interface SliderProps {
  value?: number;
  defaultValue?: number;
  onValueChange?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  "aria-label": string;
  disabled?: boolean;
  className?: string;
}

export function Slider({ value, defaultValue = 0, onValueChange, min = 0, max = 100, step = 1, disabled, className, ...aria }: SliderProps) {
  const [v, setV] = useControllable(value, defaultValue, onValueChange);
  const pct = max === min ? 0 : ((v - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      className={cx("l-slider", className)}
      style={{ "--pct": `${pct}%` } as CSSProperties}
      min={min}
      max={max}
      step={step}
      value={v}
      disabled={disabled}
      aria-label={aria["aria-label"]}
      onChange={(e) => setV(Number(e.target.value))}
    />
  );
}

/* ---------------- Stepper ---------------- */

export interface StepperProps {
  value?: number;
  defaultValue?: number;
  onValueChange?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  className?: string;
}

export function Stepper({ value, defaultValue = 0, onValueChange, min = -Infinity, max = Infinity, step = 1, label, className }: StepperProps) {
  const [v, setV] = useControllable(value, defaultValue, onValueChange);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div role="group" aria-label={label} className={cx("l-stepper", className)}>
      <button type="button" className="l-stepper__btn" aria-label={`Diminuisci ${label}`} disabled={v <= min} onClick={() => setV(clamp(v - step))}>
        <Minus size={18} aria-hidden="true" />
      </button>
      <span className="l-stepper__sep" aria-hidden="true" />
      <button type="button" className="l-stepper__btn" aria-label={`Aumenta ${label}`} disabled={v >= max} onClick={() => setV(clamp(v + step))}>
        <Plus size={18} aria-hidden="true" />
      </button>
      <output className="l-sr-only" aria-live="polite">{v}</output>
    </div>
  );
}
