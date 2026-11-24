import { type ReactNode, type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Circle, MapPin, Maximize, Minus, Plus, Ruler, Slash, Triangle } from "lucide-react";
import { Banner, IconButton, Material, SegmentedControl, type SegmentOption } from "../ui";
import "./MapCanvas.css";
import { screenToMap } from "./geometry";
import { MapController, type Tool, type ToolState } from "./controller";
import type { WallMode } from "./drawTools";
import type { FogBrush, FogMode } from "../fog/fogLogic";
import { bindCanvasInput } from "./input";
import { MEASURE_LABELS, MEASURE_TOOLS, isMeasureTool, type MeasureTool } from "./measure";
import type { PixiMapView } from "./renderer";
import type { MapHandlers, MapScene, Point, Viewport } from "./types";
import { isWebGLAvailable } from "../dice3d/webgl";

export interface MapCanvasHandle {
  /** Adatta tutta la mappa allo schermo. */
  fit(): void;
  zoomBy(factor: number): void;
  /** Centra lo schermo su un punto di mappa (pixel di mappa). */
  centerOn(point: Point): void;
  /** Punto di mappa sotto una coordinata di pagina (trascinamento dalla libreria), o `null` senza canvas. */
  clientToMap(clientX: number, clientY: number): Point | null;
  /** Strumenti GM: selezione, righello, nebbia, muri. */
  setTool(tool: Tool): void;
  setFogBrush(brush: FogBrush): void;
  setFogMode(mode: FogMode): void;
  setWallMode(mode: WallMode): void;
  /** Chiude il poligono della nebbia in costruzione. */
  closePolygon(): void;
  /** Imposta la selezione dei token (elenco dei bersagli, gruppi). */
  setSelection(ids: readonly string[]): void;
  /** Toglie la misura in costruzione senza segnalare un annullamento (e' stata consegnata dal padre). */
  clearMeasure(): void;
}

export interface MapCanvasProps extends MapScene, MapHandlers {
  ref?: Ref<MapCanvasHandle>;
  className?: string;
  /** Nome accessibile della mappa. */
  label?: string;
  /** Viewport iniziale; se manca la mappa viene adattata allo schermo. */
  defaultViewport?: Viewport;
  /** Chi vede le misure e le segnalazioni (scelta mostrata accanto agli strumenti). Senza, nessuna scelta. */
  measureAudience?: { value: string; options: Array<SegmentOption<string>>; onChange: (value: string) => void };
  /** Lo strumento attivo, il pennello o il modo sono cambiati (anche da tastiera). */
  onToolStateChange?: (state: ToolState) => void;
}

type Status = "loading" | "ready" | "unavailable";

const MEASURE_ICONS: Record<MeasureTool, ReactNode> = {
  ruler: <Ruler size={20} />,
  circle: <Circle size={20} />,
  cone: <Triangle size={20} />,
  line: <Slash size={20} />,
  arrow: <ArrowUpRight size={20} />,
  ping: <MapPin size={20} />
};
const MEASURE_KEYS: Record<MeasureTool, string> = { ruler: "R", circle: "O", cone: "C", line: "L", arrow: "F", ping: "P" };

/**
 * Canvas della mappa (PixiJS, caricato in modo lazy). E' controllato dalle props e non modifica
 * mai i dati: le callback segnalano le richieste dell'utente e il padre decide cosa farne.
 */
export function MapCanvas({
  ref, className, label = "Mappa di gioco", defaultViewport,
  background, grid, scale, tokens, role, movableTokenIds, rulerMode, fog, walls, wallsVisible, sight, ephemerals, pulses, objects,
  onShape, onShapeCancel, onContextMenu, onKey, measureAudience,
  onMoveToken, onResizeToken, onRotateToken, onSelectionChange, onViewportChange,
  onFogShape, onWallAdd, onWallUpdate, onWallRemove, onWallSelect, onToolStateChange
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
  const [hoverTokenId, setHoverTokenId] = useState<string | null>(null);
  const [measuresOpen, setMeasuresOpen] = useState(false);

  const scene = useMemo<MapScene>(
    () => ({ background, grid, scale, tokens, role, movableTokenIds, rulerMode, fog, walls, wallsVisible, sight, ephemerals, pulses, objects, hoverTokenId }),
    [background, grid, scale, tokens, role, movableTokenIds, rulerMode, fog, walls, wallsVisible, sight, ephemerals, pulses, objects, hoverTokenId]
  );
  const toolStateRef = useRef(onToolStateChange);
  toolStateRef.current = onToolStateChange;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // Le callback piu' recenti, senza ricreare nulla.
  useEffect(() => {
    controller.handlers = {
      onShape, onShapeCancel, onKey,
      // Il menu si apre in coordinate della finestra: il controller conosce solo quelle del canvas.
      onContextMenu: onContextMenu
        ? (x, y, tokenId) => {
            const r = canvasRef.current?.getBoundingClientRect();
            onContextMenu(x + (r?.left ?? 0), y + (r?.top ?? 0), tokenId);
          }
        : undefined,
      onMoveToken, onResizeToken, onRotateToken, onSelectionChange, onFogShape, onWallAdd, onWallUpdate, onWallRemove, onWallSelect,
      onHoverToken: setHoverTokenId,
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
      setTool: (t) => controller.setTool(t),
      setFogBrush: (b) => controller.setFogBrush(b),
      setFogMode: (m) => controller.setFogMode(m),
      setWallMode: (m) => controller.setWallMode(m),
      setSelection: (ids) => controller.setSelection(ids),
      clearMeasure: () => controller.clearMeasurements(),
      closePolygon: () => {
        controller.draw.closePolygon();
        controller.onToolState(controller.toolState);
      },
      clientToMap: (cx, cy) => {
        const r = canvasRef.current?.getBoundingClientRect();
        return r ? screenToMap(controller.viewport, { x: cx - r.left, y: cy - r.top }) : null;
      },
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
    controller.onToolState = (st) => toolStateRef.current?.(st);
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
      controller.onToolState = () => {};
    };
  }, [controller]);

  const unavailable = status === "unavailable";
  const gmNote =
    role === "gm"
      ? " Come GM puoi anche ruotare e ridimensionare i token selezionati. N nebbia (1 rettangolo, 2 cerchio, 3 poligono, 4 celle, X rivela o copri, Invio chiude il poligono), W muri (1 disegna, 2 porta, 3 modifica, 4 elimina), V torna alla selezione. Con dei token selezionati: D danno, H cura, K condizione, E effetto, M sposta, tasto destro o pressione lunga per il menu."
      : "";
  const description = `Trascina per spostare i token, rotella o pizzico per lo zoom, tasto centrale o due dita per scorrere. Frecce, più e meno, zero per adattare. Misure e segnalazioni: R righello, O cerchio, C cono, L linea, F freccia, P segnalazione; Esc le toglie.${gmNote}`;
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
              label={isMeasureTool(tool) ? `${MEASURE_LABELS[tool]} attivo: apri gli strumenti di misura` : "Misure e segnalazioni"}
              aria-expanded={measuresOpen}
              variant={isMeasureTool(tool) ? "tinted" : "plain"}
              icon={<Ruler size={20} />}
              onClick={() => setMeasuresOpen((v) => !v)}
            />
          </Material>
          {measuresOpen ? (
            <Material thickness="regular" className="lanterna-map__group lanterna-map__measures a-enter" role="toolbar" aria-label="Strumenti di misura e segnalazione">
              <div className="lanterna-map__row">
                {MEASURE_TOOLS.map((m) => (
                  <IconButton
                    key={m}
                    label={`${MEASURE_LABELS[m]}${tool === m ? ": attivo, premi per uscire" : ` (${MEASURE_KEYS[m]})`}`}
                    aria-pressed={tool === m}
                    variant={tool === m ? "tinted" : "plain"}
                    icon={MEASURE_ICONS[m]}
                    onClick={() => controller.setTool(tool === m ? "select" : m)}
                  />
                ))}
              </div>
              {measureAudience ? (
                <SegmentedControl aria-label="Chi vede la misura" value={measureAudience.value} onValueChange={measureAudience.onChange} options={measureAudience.options} />
              ) : null}
            </Material>
          ) : null}
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
