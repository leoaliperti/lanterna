import { parseCssColor } from "./color";
import type { TokenKind } from "./types";

/** Colori del design system risolti in numeri, per PixiJS (che non legge le variabili CSS). */
export interface MapTheme {
  tint: number;
  onTint: number;
  label: number;
  red: number;
  green: number;
  orange: number;
  gray: number;
  /** Sfondo della mappa mentre l'immagine carica. */
  surface: number;
  /** Fondo di barre e badge. */
  scrim: number;
}

const FALLBACK: MapTheme = {
  tint: 0x007aff, onTint: 0xffffff, label: 0x000000, red: 0xd70015, green: 0x248a3d, orange: 0xc93400, gray: 0x8e8e93, surface: 0xd1d1d6, scrim: 0x1c1c1e
};

const VARS: Record<keyof MapTheme, string> = {
  tint: "--tint", onTint: "--on-tint", label: "--label", red: "--red", green: "--green", orange: "--orange", gray: "--gray", surface: "--bg-tertiary", scrim: "--bg-grouped-secondary"
};

/**
 * Legge i token CSS dal punto dell'albero dato (rispetta `data-theme` e `prefers-color-scheme`):
 * un elemento sonda riceve `color: var(--token)` e si legge il colore calcolato.
 */
export function readTheme(host: HTMLElement): MapTheme {
  const theme = { ...FALLBACK };
  if (typeof getComputedStyle !== "function") return theme;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  host.appendChild(probe);
  try {
    for (const key of Object.keys(VARS) as (keyof MapTheme)[]) {
      probe.style.color = `var(${VARS[key]})`;
      const css = getComputedStyle(probe).color;
      if (css) theme[key] = parseCssColor(css, { value: FALLBACK[key], alpha: 1 }).value;
    }
  } finally {
    probe.remove();
  }
  return theme;
}

export function kindColor(theme: MapTheme, kind: TokenKind): number {
  switch (kind) {
    case "character":
      return theme.tint;
    case "npc":
      return theme.orange;
    case "monster":
      return theme.red;
    default:
      return theme.gray;
  }
}

export function healthColor(theme: MapTheme, ratio: number): number {
  return ratio > 0.5 ? theme.green : ratio > 0.25 ? theme.orange : theme.red;
}
