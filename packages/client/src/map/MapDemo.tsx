import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, SegmentedControl, Toggle } from "../ui";
import { MapCanvas, type MapCanvasHandle } from "./MapCanvas";
import { generateProceduralMap, makeDemoTokens } from "./demoData";
import type { GridConfig, MapToken } from "./types";
import "./MapDemo.css";

/** Pagina di prova della mappa (solo sviluppo, `#/map`). Con `#/map?bench` esegue un test di carico visivo. */

const SIZES = { normale: { w: 4000, h: 3000 }, grande: { w: 8000, h: 6000 } } as const;
type SizeKey = keyof typeof SIZES;

interface BenchResult {
  frames: number;
  avgFps: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  tokens: number;
  /** Tempo CPU di renderer.frame() (logica + comandi alla GPU), non include il lavoro della GPU. */
  cpuSamples: number;
  cpuAvgMs: number;
  cpuP95Ms: number;
  note: string;
}

function isBench(): boolean {
  return /[?&]bench\b/.test(window.location.hash);
}

export function MapDemo() {
  const [role, setRole] = useState<"gm" | "player">("gm");
  const [count, setCount] = useState<"12" | "300">(isBench() ? "300" : "12");
  const [size, setSize] = useState<SizeKey>(/[?&]big\b/.test(window.location.hash) ? "grande" : "normale");
  const [snap, setSnap] = useState(true);
  const [gridOn, setGridOn] = useState(true);
  const [reject, setReject] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [fps, setFps] = useState<number | null>(null);
  const [bench, setBench] = useState<BenchResult | null>(null);
  const mapRef = useRef<MapCanvasHandle>(null);
  const cell = 70;
  const { w, h } = SIZES[size];

  const [tokens, setTokens] = useState<MapToken[]>(() => makeDemoTokens({ count: 12, mapWidth: 4000, mapHeight: 3000, cellSize: cell }));
  useEffect(() => {
    setTokens(makeDemoTokens({ count: Number(count), mapWidth: w, mapHeight: h, cellSize: cell }));
  }, [count, w, h]);

  useEffect(() => {
    let revoked = false;
    let made: string | null = null;
    setUrl(null);
    void generateProceduralMap(w, h).then((u) => {
      if (revoked) URL.revokeObjectURL(u);
      else {
        made = u;
        setUrl(u);
      }
    });
    return () => {
      revoked = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [w, h]);

  const push = useCallback((line: string) => setLog((l) => [line, ...l].slice(0, 6)), []);

  const grid = useMemo<GridConfig>(
    () => ({ cellSize: cell, color: "#ffffff", opacity: 0.35, offsetX: 0, offsetY: 0, snap, visible: gridOn }),
    [snap, gridOn]
  );
  const background = useMemo(() => (url ? { url, width: w, height: h } : null), [url, w, h]);
  const scale = useMemo(() => ({ unitsPerCell: 5, unitLabel: "piedi" }), []);
  const movable = useMemo(() => tokens.filter((t) => t.kind === "character").map((t) => t.id), [tokens]);
  const all = useMemo(() => tokens.map((t) => t.id), [tokens]);

  // Contatore di fps (media sull'ultimo secondo), solo informativo.
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const tick = (now: number) => {
      frames++;
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Benchmark visivo: pan e zoom continui per 6 secondi, tempi dei frame reali del browser.
  useEffect(() => {
    if (!isBench() || !background) return;
    let raf = 0;
    const times: number[] = [];
    let start = 0;
    let prev = 0;
    const warm = 1500;
    const cpu = (globalThis as unknown as { __mapFrameMs?: number[] });
    cpu.__mapFrameMs = [];
    const total = 6000 + warm;
    const step = (now: number) => {
      if (!start) start = now;
      const t = now - start;
      const api = mapRef.current;
      if (api) {
        api.centerOn({ x: w / 2 + Math.sin(t / 700) * (w / 3), y: h / 2 + Math.cos(t / 900) * (h / 3) });
        api.zoomBy(1 + Math.sin(t / 300) * 0.01);
      }
      if (prev && t > warm) times.push(now - prev);
      prev = now;
      if (t < total) {
        raf = requestAnimationFrame(step);
        return;
      }
      const sorted = [...times].sort((a, b) => a - b);
      const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
      const frameMs = (cpu.__mapFrameMs ?? []).slice(Math.floor((cpu.__mapFrameMs?.length ?? 0) * (warm / total)));
      const cpuSorted = [...frameMs].sort((a, b) => a - b);
      const cpuAvg = frameMs.reduce((a, b) => a + b, 0) / Math.max(1, frameMs.length);
      const result: BenchResult = {
        cpuSamples: frameMs.length,
        cpuAvgMs: Math.round(cpuAvg * 100) / 100,
        cpuP95Ms: Math.round((cpuSorted[Math.floor(cpuSorted.length * 0.95)] ?? 0) * 100) / 100,
        frames: times.length,
        avgFps: Math.round(1000 / avg),
        avgMs: Math.round(avg * 10) / 10,
        p95Ms: Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 10) / 10,
        maxMs: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
        tokens: tokens.length,
        note: "Misurato nel browser corrente: con GPU reale è rappresentativo, con rendering software (SwiftShader) è solo un limite inferiore."
      };
      (window as unknown as { __mapBench?: BenchResult }).__mapBench = result;
      setBench(result);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [background, tokens.length, w, h]);

  const move = (id: string, x: number, y: number) => {
    push(`onMoveToken ${id} -> (${Math.round(x)}, ${Math.round(y)})${reject ? " [il server rifiuta]" : ""}`);
    if (!reject) setTokens((ts) => ts.map((t) => (t.id === id ? { ...t, x, y } : t)));
  };

  return (
    <main className="map-demo">
      <header className="map-demo__bar">
        <h1 className="t-title3">Mappa (prova)</h1>
        <SegmentedControl aria-label="Ruolo" value={role} onValueChange={setRole} options={[{ value: "gm", label: "GM" }, { value: "player", label: "Giocatore" }]} />
        <SegmentedControl aria-label="Numero di token" value={count} onValueChange={setCount} options={[{ value: "12", label: "12 token" }, { value: "300", label: "300 token" }]} />
        <SegmentedControl aria-label="Dimensione mappa" value={size} onValueChange={setSize} options={[{ value: "normale", label: "4000x3000" }, { value: "grande", label: "8000x6000" }]} />
        <Toggle label="Snap" checked={snap} onCheckedChange={setSnap} />
        <Toggle label="Griglia" checked={gridOn} onCheckedChange={setGridOn} />
        <Toggle label="Il server rifiuta gli spostamenti" checked={reject} onCheckedChange={setReject} />
        <span className="t-footnote map-demo__fps" aria-live="off">{fps === null ? "" : `${fps} fps`}</span>
      </header>
      <div className="map-demo__stage">
        {background ? (
          <MapCanvas
            ref={mapRef}
            background={background}
            grid={grid}
            scale={scale}
            tokens={tokens}
            role={role}
            movableTokenIds={role === "gm" ? all : movable}
            onMoveToken={move}
            onResizeToken={(id, s) => {
              push(`onResizeToken ${id} -> ${s}`);
              setTokens((ts) => ts.map((t) => (t.id === id ? { ...t, size: s } : t)));
            }}
            onRotateToken={(id, r) => {
              push(`onRotateToken ${id} -> ${r}`);
              setTokens((ts) => ts.map((t) => (t.id === id ? { ...t, rotation: r } : t)));
            }}
            onSelectionChange={(ids) => push(`onSelectionChange [${ids.join(", ")}]`)}
          />
        ) : (
          <p className="t-footnote">Genero la mappa...</p>
        )}
      </div>
      <footer className="map-demo__log t-footnote">
        {bench ? (
          <Banner tone="info" title="Benchmark">
            <pre id="bench-result">{JSON.stringify(bench)}</pre>
          </Banner>
        ) : null}
        <ul aria-label="Eventi">
          {log.map((l, i) => (
            <li key={`${i}-${l}`}>{l}</li>
          ))}
        </ul>
      </footer>
    </main>
  );
}
