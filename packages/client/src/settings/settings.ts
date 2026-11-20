import { useSyncExternalStore } from "react";

/** Preferenze locali dell'utente su questo dispositivo (non sincronizzate col server). */
export interface Settings {
  /** Animazione 3D dei dadi sopra la mappa. */
  dice3d: boolean;
}

const KEY = "lanterna.settings.v1";
const DEFAULTS: Settings = { dice3d: true };

let current: Settings | null = null;
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return { dice3d: typeof parsed.dice3d === "boolean" ? parsed.dice3d : DEFAULTS.dice3d };
    }
  } catch {
    /* archivio non disponibile o contenuto illeggibile: valori predefiniti */
  }
  return { ...DEFAULTS };
}

export function getSettings(): Settings {
  current ??= load();
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...getSettings(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* la preferenza vale comunque per questa sessione */
  }
  for (const l of [...listeners]) l();
}

/** Solo per i test: dimentica la copia in memoria. */
export function resetSettingsCache(): void {
  current = null;
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}
