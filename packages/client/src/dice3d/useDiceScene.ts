import { type RefObject, useEffect, useRef, useState } from "react";
import type { PhysicalDie } from "./dice";
import type { DiceScene } from "./scene";
import { isWebGLAvailable } from "./webgl";

export type SceneStatus = "loading" | "ready" | "unavailable";

export interface SceneController {
  status: SceneStatus;
  /**
   * Anima i dadi. Risolve a fine animazione (o se un tiro successivo la interrompe).
   * Senza WebGL risolve subito: il chiamante mostra il risultato in testo.
   */
  animate(dice: readonly PhysicalDie[], reducedMotion: boolean): Promise<void>;
  clear(): void;
}

/**
 * Crea la scena Three.js (caricata in modo lazy) sul canvas dato e la rilascia allo smontaggio:
 * renderer, geometrie, materiali e texture vengono liberati da DiceScene.dispose().
 */
export function useDiceScene(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  hostRef: RefObject<HTMLElement | null>,
): SceneController {
  const [status, setStatus] = useState<SceneStatus>("loading");
  const sceneRef = useRef<Promise<DiceScene | null>>(Promise.resolve(null));
  const liveRef = useRef<DiceScene | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host || !isWebGLAvailable()) {
      sceneRef.current = Promise.resolve(null);
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let scene: DiceScene | null = null;

    const lose = () => {
      liveRef.current = null;
      setStatus("unavailable");
    };
    const onContextLost = (e: Event) => {
      e.preventDefault();
      lose();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);

    const loading = import("./scene")
      .then(({ DiceScene: Scene }) => {
        if (cancelled) return null;
        return new Scene(canvas);
      })
      .catch((err: unknown) => {
        console.error("Dadi 3D non disponibili:", err);
        return null;
      });
    sceneRef.current = loading;

    void loading.then((s) => {
      if (cancelled) {
        s?.dispose();
        return;
      }
      if (!s) {
        setStatus("unavailable");
        return;
      }
      scene = s;
      liveRef.current = s;
      const fit = () => s.resize(host.clientWidth, host.clientHeight);
      fit();
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(fit);
        observer.observe(host);
      }
      setStatus("ready");
    });

    return () => {
      cancelled = true;
      canvas.removeEventListener("webglcontextlost", onContextLost);
      observer?.disconnect();
      scene?.dispose();
      scene = null;
      liveRef.current = null;
      sceneRef.current = Promise.resolve(null);
    };
  }, [canvasRef, hostRef]);

  return {
    status,
    async animate(dice, reducedMotion) {
      await sceneRef.current;
      await liveRef.current?.roll(dice, reducedMotion);
    },
    clear() {
      liveRef.current?.clear();
    },
  };
}
