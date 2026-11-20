import { useEffect, useState, type ReactNode } from "react";
import { Eye } from "lucide-react";
import { Material } from "../ui";
import { useRealtimeState } from "../realtime/RealtimeProvider";
import { ConnectionBanner, ConnectionDot } from "../table/ConnectionStatus";
import "./windows.css";

/** Dopo quanto tempo senza puntatore o tastiera la barra si attenua (schermi esterni, proiettori). */
const IDLE_MS = 3000;

function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = setTimeout(() => setIdle(true), ms);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), ms);
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const e of events) window.addEventListener(e, wake, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, wake);
    };
  }, [ms]);
  return idle;
}

export interface ViewFrameProps {
  /** Nome della vista (barra, titolo della finestra, screen reader). */
  title: string;
  /** `map`: area a tutta finestra per il canvas; `panel`: contenuto che scorre. */
  layout: "map" | "panel";
  /** Vista giocatore: nome del membro guardato (banner "Stai guardando come..."). */
  viewingAs?: string | null;
  /** Azioni discrete nella barra (accanto allo stato della connessione). */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Cornice minimale delle finestre secondarie (M9): niente barra del tavolo, solo una pillola con il
 * nome della vista e lo stato della connessione, che si attenua quando nessuno tocca la finestra.
 * Ogni finestra ha la sua connessione: la riconnessione e gli avvisi sono indipendenti.
 */
export function ViewFrame({ title, layout, viewingAs, actions, children }: ViewFrameProps) {
  const idle = useIdle(IDLE_MS);
  const { status } = useRealtimeState();

  useEffect(() => {
    document.title = `${title} - Lanterna`;
  }, [title]);

  return (
    <div className="w-view" data-layout={layout} data-idle={idle && status === "connected" ? "true" : undefined}>
      <Material thickness="regular" className="w-view__bar" role="banner">
        <h1 className="w-view__title t-subhead">{title}</h1>
        <ConnectionDot />
        {actions}
      </Material>
      {viewingAs ? (
        <Material thickness="regular" className="w-view__as a-enter" role="note" aria-label={`Stai guardando come ${viewingAs}, in sola lettura`}>
          <Eye size={16} aria-hidden="true" />
          <span className="t-footnote">
            Stai guardando come <strong>{viewingAs}</strong>
          </span>
          <span className="w-view__ro t-caption1">Sola lettura</span>
        </Material>
      ) : null}
      <div className="w-view__banner">
        <ConnectionBanner />
      </div>
      <main id="vista" tabIndex={-1} className={layout === "map" ? "a-map w-view__body" : "w-view__panel"} aria-label={title}>
        {children}
      </main>
    </div>
  );
}
