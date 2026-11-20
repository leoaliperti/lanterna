import type { MapToken, TokenCondition, TokenKind } from "./types";

/** Dati finti e mappa procedurale per la pagina di prova `#/map`. Nessuna immagine con copyright. */

/** PRNG deterministico (mulberry32): stessi dati a ogni avvio, utile a confrontare le misure. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: TokenKind[] = ["character", "npc", "monster", "monster", "object"];
const COLORS = ["#5e9cff", "#ff9f5e", "#e5624f", "#7bc86c", "#b184e8", "#e8c34f"];
const CONDITIONS: TokenCondition[] = [
  { id: "prone", label: "Prono", icon: "P", color: "#8e6bd1" },
  { id: "poisoned", label: "Avvelenato", icon: "V", color: "#3f9a4c" },
  { id: "stunned", label: "Stordito", icon: "S", color: "#d1802f" }
];

export interface DemoTokenOptions {
  count: number;
  mapWidth: number;
  mapHeight: number;
  cellSize: number;
  seed?: number;
}

export function makeDemoTokens({ count, mapWidth, mapHeight, cellSize, seed = 7 }: DemoTokenOptions): MapToken[] {
  const rnd = seededRandom(seed);
  const cols = Math.max(1, Math.floor(mapWidth / cellSize));
  const rows = Math.max(1, Math.floor(mapHeight / cellSize));
  const used = new Set<number>();
  const tokens: MapToken[] = [];
  for (let i = 0; i < count; i++) {
    let cell = Math.floor(rnd() * cols * rows);
    for (let tries = 0; used.has(cell) && tries < 20; tries++) cell = Math.floor(rnd() * cols * rows);
    used.add(cell);
    const size = rnd() < 0.08 ? 2 : 1;
    const kind = KINDS[Math.floor(rnd() * KINDS.length)]!;
    const conditions = rnd() < 0.2 ? [CONDITIONS[Math.floor(rnd() * CONDITIONS.length)]!] : undefined;
    const max = 10 + Math.floor(rnd() * 40);
    tokens.push({
      id: `t${i}`,
      x: (cell % cols) * cellSize + (size * cellSize) / 2,
      y: Math.floor(cell / cols) * cellSize + (size * cellSize) / 2,
      size,
      rotation: Math.floor(rnd() * 24) * 15,
      color: COLORS[Math.floor(rnd() * COLORS.length)],
      label: `${kind === "character" ? "PG" : kind === "npc" ? "PNG" : kind === "monster" ? "Mostro" : "Oggetto"} ${i + 1}`,
      kind,
      hidden: rnd() < 0.06,
      conditions,
      health: kind === "object" ? undefined : { current: Math.max(1, Math.floor(max * rnd())), max }
    });
  }
  return tokens;
}

/**
 * Disegna una mappa "dungeon" procedurale (stanze, corridoi, macchie) su un canvas e la restituisce
 * come URL di un Blob (da revocare con URL.revokeObjectURL).
 */
export async function generateProceduralMap(width: number, height: number, seed = 42): Promise<string> {
  const rnd = seededRandom(seed);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D non disponibile");
  ctx.fillStyle = "#3a3d46";
  ctx.fillRect(0, 0, width, height);
  // Macchie di roccia
  for (let i = 0; i < (width * height) / 40000; i++) {
    ctx.fillStyle = `rgba(${20 + rnd() * 40}, ${20 + rnd() * 40}, ${30 + rnd() * 40}, 0.25)`;
    ctx.beginPath();
    ctx.arc(rnd() * width, rnd() * height, 20 + rnd() * 120, 0, Math.PI * 2);
    ctx.fill();
  }
  // Stanze collegate da corridoi
  const rooms: { x: number; y: number; w: number; h: number }[] = [];
  const n = Math.max(6, Math.round((width * height) / 900000));
  for (let i = 0; i < n; i++) {
    const w = 250 + rnd() * 500;
    const h = 200 + rnd() * 400;
    rooms.push({ x: rnd() * (width - w), y: rnd() * (height - h), w, h });
  }
  ctx.fillStyle = "#b9a98a";
  ctx.strokeStyle = "#1f2127";
  ctx.lineWidth = 10;
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1]!;
    const b = rooms[i]!;
    ctx.lineWidth = 90;
    ctx.strokeStyle = "#a39578";
    ctx.beginPath();
    ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2);
    ctx.lineTo(b.x + b.w / 2, a.y + a.h / 2);
    ctx.lineTo(b.x + b.w / 2, b.y + b.h / 2);
    ctx.stroke();
  }
  for (const r of rooms) {
    ctx.fillStyle = "#c2b394";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(90, 75, 50, ${0.05 + rnd() * 0.1})`;
      ctx.fillRect(r.x + rnd() * r.w, r.y + rnd() * r.h, 10 + rnd() * 60, 10 + rnd() * 60);
    }
    ctx.lineWidth = 12;
    ctx.strokeStyle = "#1f2127";
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  canvas.width = canvas.height = 0; // libera subito la memoria del canvas di lavoro
  if (!blob) throw new Error("Impossibile generare la mappa");
  return URL.createObjectURL(blob);
}
