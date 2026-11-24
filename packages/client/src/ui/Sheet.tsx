import { useId, useRef, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from "react";
import { Portal, cx, useEscape, useFocusTrap, usePresence, useScrollLock } from "./internal";
import { Button } from "./Button";

/** Resistenza progressiva oltre il limite (rubber-banding). */
export function rubberband(overshoot: number, dimension = 300, c = 0.55): number {
  return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
}

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Mostra il titolo visivamente (default true). Il nome accessibile resta sempre. */
  showTitle?: boolean;
  children: ReactNode;
  className?: string;
  /** Elemento che riceve il focus all'apertura (default: il primo controllo, di solito "Fine"). */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * "Fine" in alto: di norma chiude; con un form, salva e chiude (il form decide se può chiudersi).
   * Esc e il click sullo sfondo restano "chiudi senza salvare".
   */
  onDone?: () => void;
}

interface Sample { y: number; t: number }

/**
 * Modale dal basso: maniglia, trascinamento per chiudere (con velocita'), molla di ritorno,
 * focus trap, Esc, click sullo sfondo. Il trascinamento parte dalla maniglia/intestazione.
 */
export function Sheet({ open, onOpenChange, title, showTitle = true, children, className, initialFocus, onDone }: SheetProps) {
  const { mounted, state } = usePresence(open);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const drag = useRef<{ startY: number; base: number; samples: Sample[]; id: number } | null>(null);

  useScrollLock(open);
  useEscape(open, () => onOpenChange(false));
  useFocusTrap(panel, open && mounted, initialFocus);

  if (!mounted) return null;

  const currentOffset = () => {
    const el = panel.current;
    if (!el) return 0;
    const m = getComputedStyle(el).transform;
    if (!m || m === "none") return 0;
    return new DOMMatrixReadOnly(m).m42 || 0;
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    const el = panel.current;
    if (!el || drag.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    // interrompibile: si riparte dalla posizione attuale, non da quella di destinazione
    const base = currentOffset();
    el.style.transition = "none";
    el.style.transform = `translateY(${base}px)`;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, base, samples: [{ y: e.clientY, t: e.timeStamp }], id: e.pointerId };
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = panel.current;
    if (!d || !el || e.pointerId !== d.id) return;
    d.samples.push({ y: e.clientY, t: e.timeStamp });
    if (d.samples.length > 6) d.samples.shift();
    const raw = d.base + (e.clientY - d.startY);
    const y = raw >= 0 ? raw : rubberband(raw, el.offsetHeight);
    el.style.transform = `translateY(${y}px)`;
  };

  const end = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = panel.current;
    if (!d || !el || e.pointerId !== d.id) return;
    drag.current = null;
    const first = d.samples[0]!;
    const last = d.samples[d.samples.length - 1]!;
    const velocity = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0; // px/ms
    const offset = Math.max(0, d.base + (last.y - d.startY));
    // proiezione del punto di arrivo (decelerazione 0.998 come lo scroll iOS)
    const projected = offset + velocity * (0.998 / (1 - 0.998)); // velocity in px/ms
    const dismiss = velocity > 0.5 || projected > el.offsetHeight * 0.5;
    if (dismiss) {
      el.style.transition = "transform var(--dur-slow) var(--ease-ios)";
      el.style.transform = "translateY(100%)";
      onOpenChange(false);
    } else {
      el.style.transition = "transform var(--dur-slow) var(--ease-spring)";
      el.style.transform = "translateY(0)";
      const clear = () => {
        el.style.transition = "";
        el.style.transform = "";
        el.removeEventListener("transitionend", clear);
      };
      el.addEventListener("transitionend", clear);
    }
  };

  return (
    <Portal>
      <div className="l-overlay l-sheet-root" data-state={state}>
        <div className="l-scrim" onClick={() => onOpenChange(false)} aria-hidden="true" />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          data-state={state}
          className={cx("l-sheet", className)}
        >
          <div
            className="l-sheet__grab"
            data-testid="sheet-grab"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <span className="l-sheet__handle" aria-hidden="true" />
            <div className="l-sheet__header">
              <h2 id={titleId} className={cx("l-sheet__title", !showTitle && "l-sr-only")}>{title}</h2>
              <Button variant="plain" size="sm" onClick={() => (onDone ? onDone() : onOpenChange(false))} onPointerDown={(e) => e.stopPropagation()}>
                Fine
              </Button>
            </div>
          </div>
          <div className="l-sheet__body">{children}</div>
        </div>
      </div>
    </Portal>
  );
}
