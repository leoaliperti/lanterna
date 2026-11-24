import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle, X } from "lucide-react";
import { Portal, cx } from "./internal";

/* ---------------- Tooltip ---------------- */

let lastTooltipClosedAt = 0;

export interface TooltipProps {
  content: string;
  children: ReactNode;
  placement?: "top" | "bottom";
  /** Ritardo di apertura (ms). Dopo un altro tooltip appena chiuso si apre subito. */
  delay?: number;
}

export function Tooltip({ content, children, placement = "top", delay = 500 }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();

  const show = (immediate: boolean) => {
    clearTimeout(timer.current);
    const skip = immediate || Date.now() - lastTooltipClosedAt < 300;
    setInstant(skip);
    if (skip) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen((was) => {
      if (was) lastTooltipClosedAt = Date.now();
      return false;
    });
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <span
      className="l-anchor l-tooltip-anchor"
      aria-describedby={open ? id : undefined}
      onPointerEnter={(e) => e.pointerType !== "touch" && show(false)}
      onPointerLeave={hide}
      onFocus={() => show(true)}
      onBlur={hide}
      onKeyDown={(e) => e.key === "Escape" && open && hide()}
    >
      {children}
      {open ? (
        <span id={id} role="tooltip" data-placement={placement} data-instant={instant || undefined} className="l-tooltip">
          {content}
        </span>
      ) : null}
    </span>
  );
}

/* ---------------- Banner (inline) ---------------- */

export type Tone = "info" | "success" | "warning" | "danger";
const toneIcon = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle } as const;

export interface BannerProps {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

/** Messaggio non invasivo nel flusso della pagina. Gli errori usano role="alert", il resto "status". */
export function Banner({ tone = "info", title, children, onDismiss, className }: BannerProps) {
  const Icon = toneIcon[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("l-banner", `l-banner--${tone}`, className)}>
      <Icon size={20} className="l-banner__icon" aria-hidden="true" />
      <div className="l-banner__text">
        {title ? <p className="l-banner__title">{title}</p> : null}
        {children ? <p className="l-banner__body">{children}</p> : null}
      </div>
      {onDismiss ? (
        <button type="button" className="l-banner__close" aria-label="Chiudi" onClick={onDismiss}>
          <X size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/* ---------------- Toast ---------------- */

export interface ToastInput {
  title: string;
  message?: string;
  tone?: Tone;
  /** ms; 0 = non si chiude da solo. Default 4000. */
  duration?: number;
  /** Azione breve accanto al testo (es. "Annulla"): chiude la notifica dopo averla eseguita. */
  action?: { label: string; onPress: () => void };
}
interface ToastItem extends ToastInput { id: number }

const ToastContext = createContext<{ show: (t: ToastInput) => number; dismiss: (id: number) => void } | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast va usato dentro <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const show = useCallback((t: ToastInput) => {
    const id = next.current++;
    setItems((l) => [...l.slice(-2), { ...t, id }]);
    return id;
  }, []);
  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Portal>
        <div className="l-toasts" role="region" aria-label="Notifiche" aria-live="polite">
          {items.map((t) => (
            <ToastView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
          ))}
        </div>
      </Portal>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const tone = item.tone ?? "info";
  const Icon = toneIcon[tone];
  const duration = item.duration ?? 4000;
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (!duration || hover) return;
    const t = setTimeout(onDismiss, duration);
    return () => clearTimeout(t);
  }, [duration, hover, onDismiss]);
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx("l-toast l-material l-material--thick", `l-toast--${tone}`)}
      style={{ "--toast-dur": `${duration}ms` } as CSSProperties}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <Icon size={20} className="l-toast__icon" aria-hidden="true" />
      <div className="l-toast__text">
        <p className="l-toast__title">{item.title}</p>
        {item.message ? <p className="l-toast__msg">{item.message}</p> : null}
      </div>
      {item.action ? (
        <button
          type="button"
          className="l-toast__action"
          onClick={() => {
            item.action?.onPress();
            onDismiss();
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      <button type="button" className="l-toast__close" aria-label="Chiudi notifica" onClick={onDismiss}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
