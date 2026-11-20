import type { MapProp, MapScene } from "./types";

/** Il punto e' dentro il rettangolo (ruotato) dell'oggetto? */
export function pointInProp(p: Pick<MapProp, "x" | "y" | "width" | "height" | "rotation">, x: number, y: number): boolean {
  const r = (-p.rotation * Math.PI) / 180;
  const dx = x - p.x;
  const dy = y - p.y;
  const lx = dx * Math.cos(r) - dy * Math.sin(r);
  const ly = dx * Math.sin(r) + dy * Math.cos(r);
  return Math.abs(lx) <= p.width / 2 && Math.abs(ly) <= p.height / 2;
}

/**
 * Oggetti `above` con `fade` che vanno schiariti: c'e' sotto un token "dell'osservatore".
 * Giocatore: solo i token che puo' muovere (i suoi). GM: i personaggi (tipo `character`).
 * Usa solo i token che il server ha gia' inviato: nessuna informazione nascosta.
 */
export function propFadeTargets(props: readonly MapProp[], scene: Pick<MapScene, "tokens" | "role" | "movableTokenIds">): Set<string> {
  const out = new Set<string>();
  const movable = new Set(scene.movableTokenIds);
  const watchers = scene.tokens.filter((t) => (scene.role === "player" ? movable.has(t.id) : t.kind === "character"));
  if (watchers.length === 0) return out;
  for (const p of props) {
    if (p.layer !== "above" || !p.fade) continue;
    if (watchers.some((t) => pointInProp(p, t.x, t.y))) out.add(p.id);
  }
  return out;
}

const FADE_MS = 180;

/** Un passo verso `goal` (0 o 1) in `dt` millisecondi, senza oltrepassarlo. */
export function fadeFactorStep(current: number, goal: number, dt: number): number {
  const step = dt / FADE_MS;
  if (current < goal) return Math.min(goal, current + step);
  if (current > goal) return Math.max(goal, current - step);
  return current;
}
