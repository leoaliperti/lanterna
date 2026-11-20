/**
 * Benchmark della LOGICA della mappa (senza browser ne' GPU): tempo per frame di pan/zoom, culling
 * dei token, hit test e anteprima di trascinamento con 300 token e griglia attiva.
 *
 *   npm run bench:map -w @lanterna/client
 *
 * Misura solo la CPU. I fps reali dipendono dalla GPU e si misurano in browser con la pagina di prova
 * `npm run dev` -> http://localhost:5173/#/map?bench (aggiungi `&big` per la mappa 8000x6000).
 * Budget per 60 fps: 16,7 ms a frame in totale; la logica deve occuparne una frazione minima.
 */
import { performance } from "node:perf_hooks";
import { MapController } from "../controller";
import { makeDemoTokens } from "../demoData";
import { cullTokens, hitTestToken, visibleRect } from "../geometry";
import type { MapScene } from "../types";

const TOKENS = Number(process.env.TOKENS ?? 300);
const FRAMES = Number(process.env.FRAMES ?? 5000);
const W = 8000;
const H = 6000;
const CELL = 70;

const scene: MapScene = {
  background: { url: "bench.png", width: W, height: H },
  grid: { cellSize: CELL, color: "#ffffff", opacity: 0.35, offsetX: 0, offsetY: 0, snap: true },
  scale: { unitsPerCell: 5, unitLabel: "piedi" },
  tokens: makeDemoTokens({ count: TOKENS, mapWidth: W, mapHeight: H, cellSize: CELL }),
  role: "gm",
  movableTokenIds: Array.from({ length: TOKENS }, (_, i) => `t${i}`)
};

const c = new MapController();
c.init({ x: 0, y: 0, scale: 0.5 });
c.setSize(1920, 1080);
c.setScene(scene);

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { avg, p50: s[Math.floor(s.length * 0.5)]!, p95: s[Math.floor(s.length * 0.95)]!, p99: s[Math.floor(s.length * 0.99)]!, max: s[s.length - 1]! };
}

const fmt = (n: number) => `${(n * 1000).toFixed(1)} us`;

function run(name: string, frame: (i: number) => void) {
  for (let i = 0; i < 300; i++) frame(i); // riscaldamento JIT
  const samples: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const t0 = performance.now();
    frame(i);
    samples.push(performance.now() - t0);
  }
  const st = stats(samples);
  console.log(`${name.padEnd(46)} avg ${fmt(st.avg)}  p50 ${fmt(st.p50)}  p95 ${fmt(st.p95)}  p99 ${fmt(st.p99)}  max ${fmt(st.max)}`);
  return st;
}

console.log(`Benchmark logica mappa: ${TOKENS} token, griglia ${CELL}px attiva, mappa ${W}x${H}, ${FRAMES} frame.`);
console.log("(solo CPU, senza rendering: per i fps reali vedi la pagina #/map?bench)\n");

const results = [
  run("pan + zoom (viewport, clamp)", (i) => {
    c.zoomBy(1 + Math.sin(i / 40) * 0.01, { x: 960, y: 540 });
    c.setViewport({ ...c.viewport, x: c.viewport.x + Math.sin(i / 30) * 8, y: c.viewport.y + Math.cos(i / 25) * 8 });
  }),
  run("culling dei token visibili", () => {
    cullTokens(scene.tokens, visibleRect(c.viewport, c.size), CELL, CELL * 1.6);
  }),
  run("hit test (cursore in movimento)", (i) => {
    hitTestToken(scene.tokens, { x: (i * 37) % W, y: (i * 53) % H }, CELL, 22 / c.viewport.scale);
  }),
  run("trascinamento di 300 token selezionati (anteprima)", (i) => {
    c.selection = new Set(scene.tokens.map((t) => t.id));
    if (i === 0) c.pointerDown({ id: 1, type: "mouse", button: 0, x: 100, y: 100 });
    c.pointerMove({ id: 1, type: "mouse", button: 0, x: 100 + (i % 200), y: 100 + (i % 120) });
  })
];
c.keyDown("Escape");

const total = results.reduce((a, r) => a + r.p95, 0);
console.log(`\nSomma dei p95: ${fmt(total)} (budget 60 fps: ${(1000 / 60).toFixed(1)} ms = 16700 us)`);
