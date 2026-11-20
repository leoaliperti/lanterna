import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Maximize, Minus, Plus, Ruler } from "lucide-react";
import { Banner, IconButton, Material } from "../ui";
import "./MapCanvas.css";
import { MapController, type Tool } from "./controller";
import { bindCanvasInput } from "./input";
import type { PixiMapView } from "./renderer";
import type { MapHandlers, MapScene, Point, Viewport } from "./types";
import { isWebGLAvailable } from "../dice3d/webgl";

export interface MapCanvasHandle {
  /** Adatta tutta la mappa allo schermo. */
  fit(): void;
  zoomBy(factor: number): void;
  /** Centra lo schermo su un punto di mappa (pixel di mappa). */
  centerOn(point: Point): void;
}

export interface MapCanvasProps extends MapScene, MapHandlers {
  ref?: Ref<MapCanvasHandle>;
  className?: string;
  /** Nome accessibile della mappa. */
  label?: string;
  /** Viewport iniziale; se manca la mappa viene adattata allo schermo. */
  defaultViewport?: Viewport;
}

type Status = "loading" | "ready" | "unavailable";

/**
 * Canvas della mappa (PixiJS, caricato in modo lazy). E' controllato dalle props e non modifica
 * mai i dati: le callback segnalano le richieste dell'utente e il padre decide cosa farne.
 */
export function MapCanvas({
  ref, className, label = "Mappa di gioco", defaultViewport,
  background, grid, scale, tokens, role, movableTokenIds, rulerMode,
  onMoveToken, onResizeToken, onRotateToken, onSelectionChange, onViewportChange
}: MapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLParagraphElement>(null);
  const viewRef = useRef<PixiMapView | null>(null);
  const [controller] = useState(() => {
    const c = new MapController();
    c.init(defaultViewport);
    return c;
  });
  const [status, setStatus] = useState<Status>("loading");
  const [tool, setTool] = useState<Tool>("select");
  const [zoom, setZoom] = useState(() => Math.round((defaultViewport?.scale ?? 1) * 100));

  const scene = useMemo<MapScene>(
    () => ({ background, grid, scale, tokens, role, movableTokenIds, rulerMode }),
    [background, grid, scale, tokens, role, movableTokenIds, rulerMode]
  );
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // Le callback piu' recenti, senza ricreare nulla.
  useEffect(() => {
    controller.handlers = {
      onMoveToken, onResizeToken, onRotateToken, onSelectionChange,
      onViewportChange: (vp) => {
        setZoom(Math.round(vp.scale * 100));
        onViewportChange?.(vp);
      }
    };
  });

  useImperativeHandle(
    ref,
    () => ({
      fit: () => controller.fit(),
      zoomBy: (f) => controller.zoomBy(f),
      centerOn: (p) => {
        const vp = controller.viewport;
        controller.setViewport({ ...vp, x: controller.size.width / 2 - p.x * vp.scale, y: controller.size.height / 2 - p.y * vp.scale });
      }
    }),
    [controller]
  );

  // Dati: sempre al controller (logica), alla resa quando e' pronta.
  useEffect(() => {
    controller.setScene(scene);
    viewRef.current?.update(scene);
  }, [controller, scene]);

  // Ciclo di vita: WebGL, resa, input, ridimensionamento.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!isWebGLAvailable()) {
      setStatus("unavailable");
      return;
    }
    // Un canvas nuovo a ogni montaggio: distruggere PixiJS fa perdere il contesto WebGL, e un canvas
    // con contesto perso non e' riutilizzabile (succede con il doppio montaggio di StrictMode).
    const canvas = document.createElement("canvas");
    canvas.className = "lanterna-map__canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "application");
    host.prepend(canvas);
    canvasRef.current = canvas;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let unbind: (() => void) | null = null;
    let view: PixiMapView | null = null;

    controller.onCursor = (cursor) => {
      canvas.style.cursor = cursor;
    };
    controller.onRuler = (text) => {
      if (readoutRef.current) readoutRef.current.textContent = text ? `Distanza: ${text}` : "";
    };
    controller.onTool = setTool;
    const onLost = (e: Event) => {
      e.preventDefault();
      setStatus("unavailable");
    };
    canvas.addEventListener("webglcontextlost", onLost);

    import("./renderer")
      .then(async ({ PixiMapView: View }) => {
        const v = await View.create(canvas, host, controller);
        if (cancelled) {
          v.dispose();
          return;
        }
        view = v;
        viewRef.current = v;
        v.attach();
        unbind = bindCanvasInput(canvas, controller);
        const fit = () => v.resize(host.clientWidth, host.clientHeight);
        fit();
        v.update(sceneRef.current);
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(fit);
          observer.observe(host);
        }
        setStatus("ready");
      })
      .catch((err: unknown) => {
        console.error("Canvas della mappa non disponibile:", err);
        if (!cancelled) setStatus("unavailable");
      });

    return () => {
      cancelled = true;
      canvas.removeEventListener("webglcontextlost", onLost);
      observer?.disconnect();
      unbind?.();
      view?.dispose();
      viewRef.current = null;
      canvas.remove();
      canvasRef.current = null;
      controller.onCursor = () => {};
      controller.onRuler = () => {};
      controller.onTool = () => {};
    };
  }, [controller]);

  const unavailable = status === "unavailable";
  const gmNote = role === "gm" ? " Come GM puoi anche ruotare e ridimensionare i token selezionati." : "";
  const description = `Trascina per spostare i token, rotella o pizzico per lo zoom, tasto centrale o due dita per scorrere. Frecce, più e meno, zero per adattare, R per il righello.${gmNote}`;
  useEffect(() => {
    canvasRef.current?.setAttribute("aria-label", label);
    canvasRef.current?.setAttribute("aria-description", description);
  }, [label, description, status]);
  const unit = scene.scale.unitLabel;

  return (
    <div className={["lanterna-map", className].filter(Boolean).join(" ")} data-status={status}>
      <div ref={hostRef} className="lanterna-map__stage" hidden={unavailable}>
        <div className="lanterna-map__controls" role="toolbar" aria-label="Controlli della mappa" aria-orientation="vertical">
          <Material thickness="regular" className="lanterna-map__group">
            <IconButton label="Ingrandisci" icon={<Plus size={20} />} onClick={() => controller.zoomBy(1.25)} />
            <IconButton label="Riduci" icon={<Minus size={20} />} onClick={() => controller.zoomBy(0.8)} />
            <IconButton label="Adatta la mappa allo schermo" icon={<Maximize size={20} />} onClick={() => controller.fit()} />
            <IconButton
              label={tool === "ruler" ? "Righello attivo: premi per uscire" : "Righello"}
              aria-pressed={tool === "ruler"}
              variant={tool === "ruler" ? "tinted" : "plain"}
              icon={<Ruler size={20} />}
              onClick={() => controller.setTool(tool === "ruler" ? "select" : "ruler")}
            />
          </Material>
        </div>
        <Material thickness="ultrathin" className="lanterna-map__scale t-caption1">
          <span>1 cella = {scene.scale.unitsPerCell} {unit}</span>
          <span aria-hidden="true">·</span>
          <span>{zoom}%</span>
        </Material>
        <p ref={readoutRef} className="l-sr-only" role="status" aria-live="polite" />
      </div>
      {unavailable ? (
        <div className="lanterna-map__fallback">
          <Banner tone="warning" title="Mappa non disponibile">
            Questo dispositivo o browser non supporta WebGL: la mappa non può essere disegnata. Ecco l&apos;elenco dei token.
          </Banner>
          <ul className="lanterna-map__list" aria-label="Token sulla mappa">
            {tokens.filter((t) => role === "gm" || !t.hidden).map((t) => (
              <li key={t.id}>
                {t.label ?? t.id}
                {t.hidden ? " (nascosto)" : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
