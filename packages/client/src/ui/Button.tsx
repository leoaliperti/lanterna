import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./internal";

export type ButtonVariant = "filled" | "tinted" | "gray" | "plain" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "filled", size = "md", icon, loading, fullWidth, className, children, disabled, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("l-btn", `l-btn--${variant}`, `l-btn--${size}`, fullWidth && "l-btn--full", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="l-btn__spin" aria-hidden="true" /> : icon ? <span className="l-btn__icon" aria-hidden="true">{icon}</span> : null}
      <span className="l-btn__label">{children}</span>
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Obbligatoria: nome accessibile (le icone da sole non sono leggibili dagli screen reader). */
  label: string;
  icon: ReactNode;
  variant?: "plain" | "tinted" | "gray" | "filled";
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = "plain", size = "md", className, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cx("l-iconbtn", `l-iconbtn--${variant}`, `l-iconbtn--${size}`, className)}
      {...rest}
    >
      <span className="l-iconbtn__face" aria-hidden="true">{icon}</span>
    </button>
  );
});
