import { type KeyboardEvent, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import "./DiceTray.css";
import { type DieRequest, expandRequests, formatResults } from "./dice";
import { useDiceScene } from "./useDiceScene";
import { prefersReducedMotion } from "./webgl";

export interface DiceTrayHandle {
  /**
   * Anima i dadi fino a fermarli sul valore dato (deciso dal server: qui non si sceglie mai l'esito).
   * Per d% passare `{ sides: 100, value: 1..100 }`; il componente usa due d10 (decine e unita').
   * Risolve a fine animazione, o subito se un tiro successivo la interrompe. Rifiuta con RangeError
   * se un dado o un valore non e' valido.
   */
  roll(dice: readonly DieRequest[]): Promise<void>;
  /** Toglie i dadi dal tavolo e svuota il risultato. */
  clear(): void;
}

export interface DiceTrayProps {
  ref?: Ref<DiceTrayHandle>;
  className?: string;
  /** Chiamata a fine animazione (o subito, senza WebGL) con i dadi mostrati. */
  onSettled?: (dice: readonly DieRequest[]) => void;
  /** Se presente, il tavolo diventa un pulsante (clic, tocco, Invio, Spazio): utile per chiedere un nuovo tiro. */
  onActivate?: () => void;
  /** Nome accessibile del tavolo. */
  label?: string;
}

type View = { phase: "idle" } | { phase: "rolling" } | { phase: "done"; dice: readonly DieRequest[] };

export function DiceTray({ ref, className, onSettled, onActivate, label = "Tavolo dei dadi" }: DiceTrayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const scene = useDiceScene(canvasRef, hostRef);
  const [view, setView] = useState<View>({ phase: "idle" });

  // Valori correnti per i metodi esposti, senza ricreare l'handle a ogni render.
  const latest = useRef({ scene, onSettled });
  latest.current = { scene, onSettled };
  const token = useRef(0);
  useEffect(
    () => () => {
      token.current++; // dopo lo smontaggio i tiri in volo non aggiornano più lo stato ne' chiamano onSettled
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      async roll(dice) {
        const physical = expandRequests(dice); // valida e rifiuta prima di toccare lo stato
        const mine = ++token.current;
        if (physical.length === 0) {
          latest.current.scene.clear();
          setView({ phase: "idle" });
          return;
        }
        setView({ phase: "rolling" });
        await latest.current.scene.animate(physical, prefersReducedMotion());
        if (mine !== token.current) return; // sostituito da un tiro più recente, o smontato
        setView({ phase: "done", dice });
        latest.current.onSettled?.(dice);
      },
      clear() {
        token.current++;
        latest.current.scene.clear();
        setView({ phase: "idle" });
      },
    }),
    [],
  );

  const unavailable = scene.status === "unavailable";
  const interactive = onActivate !== undefined;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate?.();
    }
  };

  return (
    <div className={["lanterna-dice-tray", className].filter(Boolean).join(" ")}>
      <div
        ref={hostRef}
        className="lanterna-dice-tray__stage"
        hidden={unavailable}
        data-status={scene.status}
        aria-label={interactive ? label : undefined}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={interactive ? onActivate : undefined}
        onKeyDown={interactive ? onKeyDown : undefined}
      >
        <canvas ref={canvasRef} className="lanterna-dice-tray__canvas" aria-hidden="true" />
      </div>
      <p className="lanterna-dice-tray__result" role="status" aria-live="polite">
        {view.phase === "rolling" ? "Tiro in corso..." : null}
        {view.phase === "done" ? formatResults(view.dice) : null}
      </p>
      {unavailable ? (
        <p className="lanterna-dice-tray__note">Anteprima 3D non disponibile su questo dispositivo: vedi il risultato in testo.</p>
      ) : null}
    </div>
  );
}
