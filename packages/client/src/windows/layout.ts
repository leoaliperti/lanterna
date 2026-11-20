import { useEffect } from "react";
import { formatViewRoute, type SecondaryRoute } from "./routes";

/**
 * Disposizione delle finestre (M9): posizione e dimensioni preferite di ogni vista, salvate in
 * `localStorage` (solo comodita' locale: se lo storage non c'e' o fallisce si usano i valori di default).
 * Nessun dato di gioco passa da qui: le finestre si sincronizzano solo tramite il server.
 */

export const LAYOUT_KEY = "lanterna.windows.v1";

export interface Geometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface StoredLayout {
  geometry: Record<string, Geometry>;
}

/** Dimensioni di partenza sensate per ogni tipo di vista. */
const DEFAULT_SIZE: Record<SecondaryRoute["kind"], { width: number; height: number }> = {
  map: { width: 1280, height: 800 },
  scene: { width: 1280, height: 800 },
  player: { width: 1280, height: 800 },
  notes: { width: 960, height: 860 },
  chat: { width: 440, height: 780 },
  combat: { width: 400, height: 680 }
};

const MIN = { width: 320, height: 320 };

function isGeometry(v: unknown): v is Geometry {
  if (!v || typeof v !== "object") return false;
  const g = v as Record<string, unknown>;
  return ["left", "top", "width", "height"].every((k) => typeof g[k] === "number" && Number.isFinite(g[k]));
}

export function readLayout(storage: Pick<Storage, "getItem"> | null = safeStorage()): StoredLayout {
  try {
    const raw = storage?.getItem(LAYOUT_KEY);
    if (!raw) return { geometry: {} };
    const parsed = JSON.parse(raw) as { geometry?: unknown };
    const geometry: Record<string, Geometry> = {};
    if (parsed.geometry && typeof parsed.geometry === "object") {
      for (const [k, v] of Object.entries(parsed.geometry as Record<string, unknown>)) if (isGeometry(v)) geometry[k] = v;
    }
    return { geometry };
  } catch {
    return { geometry: {} };
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Chiave della disposizione: per tipo di vista (la scena o il giocatore guardato non contano). */
export function layoutKey(route: SecondaryRoute): string {
  return route.kind;
}

export function saveGeometry(route: SecondaryRoute, g: Geometry, storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): void {
  if (!isGeometry(g) || g.width < MIN.width || g.height < MIN.height) return;
  try {
    const layout = readLayout(storage);
    layout.geometry[layoutKey(route)] = { left: Math.round(g.left), top: Math.round(g.top), width: Math.round(g.width), height: Math.round(g.height) };
    storage?.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* storage pieno o bloccato: la disposizione semplicemente non si ricorda */
  }
}

export interface ScreenArea {
  availLeft?: number;
  availTop?: number;
  availWidth: number;
  availHeight: number;
}

/**
 * Stringa `features` di `window.open`: la geometria salvata (riportata dentro lo schermo) o le
 * dimensioni di default, centrate. Una finestra salvata su un secondo schermo resta li' se c'e' ancora.
 */
export function windowFeatures(route: SecondaryRoute, saved: Geometry | undefined, screen: ScreenArea): string {
  const size = DEFAULT_SIZE[route.kind];
  const sl = screen.availLeft ?? 0;
  const st = screen.availTop ?? 0;
  let { width, height } = saved ?? size;
  width = Math.max(MIN.width, Math.round(width));
  height = Math.max(MIN.height, Math.round(height));
  let left: number;
  let top: number;
  if (saved) {
    // Su piu' schermi le coordinate possono essere negative o oltre lo schermo principale: si tengono.
    left = Math.round(saved.left);
    top = Math.round(saved.top);
  } else {
    width = Math.min(width, screen.availWidth);
    height = Math.min(height, screen.availHeight);
    left = Math.round(sl + (screen.availWidth - width) / 2);
    top = Math.round(st + (screen.availHeight - height) / 2);
  }
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

/** Nome della finestra: la stessa vista riapre (e porta in primo piano) la stessa finestra. */
export function windowName(route: SecondaryRoute): string {
  return `lanterna${formatViewRoute(route).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** URL della vista nella stessa app (stessa origine: stesso cookie di sessione). */
export function viewHref(route: SecondaryRoute, loc: Pick<Location, "pathname" | "search"> = window.location): string {
  return `${loc.pathname}${loc.search}#${formatViewRoute(route)}`;
}

/**
 * Apre la vista in una nuova finestra (o riporta in primo piano quella gia' aperta).
 * Restituisce `false` se il browser l'ha bloccata.
 */
export function openViewWindow(route: SecondaryRoute): boolean {
  const saved = readLayout().geometry[layoutKey(route)];
  const features = windowFeatures(route, saved, window.screen as unknown as ScreenArea);
  const win = window.open(viewHref(route), windowName(route), features);
  if (!win) return false;
  try {
    win.focus();
  } catch {
    /* alcuni browser non lo permettono */
  }
  return true;
}

/** Nelle finestre secondarie: ricorda posizione e dimensioni quando cambiano e alla chiusura. */
export function useRememberWindowGeometry(route: SecondaryRoute | null): void {
  // `key` identifica la vista: `route` cambia oggetto a ogni render.
  const key = route ? formatViewRoute(route) : null;
  const kind = route?.kind ?? null;
  useEffect(() => {
    if (!kind) return;
    const target = { kind } as SecondaryRoute;
    const save = () => saveGeometry(target, { left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, 400);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("pagehide", save);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pagehide", save);
    };
  }, [key, kind]);
}
