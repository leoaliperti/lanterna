import { useState, type CSSProperties, type ReactNode } from "react";
import { cx } from "./internal";

/* ---------------- Badge ---------------- */

export interface BadgeProps {
  tone?: "tint" | "red" | "green" | "orange" | "gray";
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = "tint", children, className }: BadgeProps) {
  return <span className={cx("l-badge", `l-badge--${tone}`, className)}>{children}</span>;
}

/* ---------------- Avatar ---------------- */

const PALETTE = ["#0062cc", "#248a3d", "#8a2fb5", "#c93400", "#0f7c8f", "#d30f45", "#4a4ad6", "#6c6c70"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

export interface AvatarProps {
  name: string;
  src?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/** Immagine con ripiego sulle iniziali. Il nome e' sempre esposto agli screen reader. */
export function Avatar({ name, src, size = "md", className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const style = { "--avatar-bg": PALETTE[hash(name) % PALETTE.length] } as CSSProperties;
  return (
    <span role="img" aria-label={name} className={cx("l-avatar", `l-avatar--${size}`, className)} style={style}>
      {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : <span aria-hidden="true">{initials(name)}</span>}
    </span>
  );
}

/* ---------------- Spinner / ProgressView ---------------- */

export function Spinner({ label = "Caricamento", size = "md" }: { label?: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span role="status" aria-label={label} className={cx("l-spinner", `l-spinner--${size}`)}>
      {Array.from({ length: 12 }, (_, i) => (
        <i key={i} style={{ "--i": i } as CSSProperties} />
      ))}
    </span>
  );
}

export interface ProgressViewProps {
  /** 0..1. Se assente, indeterminato. */
  value?: number;
  label: string;
  className?: string;
}

export function ProgressView({ value, label, className }: ProgressViewProps) {
  const determinate = value !== undefined;
  const pct = determinate ? Math.round(Math.min(1, Math.max(0, value)) * 100) : undefined;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cx("l-progress", !determinate && "l-progress--indeterminate", className)}
    >
      <span className="l-progress__bar" style={determinate ? ({ "--p": pct! / 100 } as CSSProperties) : undefined} />
    </div>
  );
}
