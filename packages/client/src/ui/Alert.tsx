import { useId, useRef, type ReactNode } from "react";
import { Portal, useEscape, useFocusTrap, usePresence, useScrollLock } from "./internal";
import { Button } from "./Button";

export interface AlertAction {
  label: string;
  onPress?: () => void;
  role?: "default" | "cancel" | "destructive";
}

export interface AlertProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message?: ReactNode;
  /** Massimo due azioni affiancate, altrimenti impilate. L'azione "cancel" e' quella predefinita per Esc. */
  actions: AlertAction[];
}

/** Dialog di conferma centrato (role="alertdialog"). Il focus iniziale va sull'azione non distruttiva. */
export function Alert({ open, onOpenChange, title, message, actions }: AlertProps) {
  const { mounted, state } = usePresence(open);
  const panel = useRef<HTMLDivElement>(null);
  const initial = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();

  useScrollLock(open);
  useEscape(open, () => onOpenChange(false));
  useFocusTrap(panel, open && mounted, initial);

  if (!mounted) return null;

  const safeIndex = Math.max(0, actions.findIndex((a) => a.role !== "destructive"));
  return (
    <Portal>
      <div className="l-overlay l-alert-root" data-state={state}>
        <div className="l-scrim" aria-hidden="true" />
        <div
          ref={panel}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={message ? descId : undefined}
          tabIndex={-1}
          data-state={state}
          className="l-alert"
        >
          <div className="l-alert__content">
            <h2 id={titleId} className="l-alert__title">{title}</h2>
            {message ? <p id={descId} className="l-alert__message">{message}</p> : null}
          </div>
          <div className="l-alert__actions" data-count={actions.length}>
            {actions.map((a, i) => (
              <Button
                key={a.label}
                ref={i === safeIndex ? initial : undefined}
                variant="plain"
                className={a.role === "destructive" ? "l-alert__btn l-alert__btn--destructive" : a.role === "cancel" ? "l-alert__btn l-alert__btn--cancel" : "l-alert__btn"}
                onClick={() => {
                  a.onPress?.();
                  onOpenChange(false);
                }}
              >
                {a.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </Portal>
  );
}
