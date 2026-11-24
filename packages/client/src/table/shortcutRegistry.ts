import { useEffect } from "react";
import { isEditableTarget } from "./shortcuts";

/**
 * Registro unico delle scorciatoie da tastiera. E' la fonte della finestra di aiuto (`?`) e dei test
 * anti-conflitto; i gestori veri restano dove vivono (mappa, combattimento, chat, cronologia).
 * Chi aggiunge una scorciatoia la scrive qui: `shortcutRegistry.test.ts` fallisce se un tasto e' gia' usato
 * nello stesso contesto.
 */
export type ShortcutScope =
  /** Sempre attiva sul tavolo. */
  | "global"
  /** Con il focus sulla mappa. */
  | "map"
  /** Con il focus sulla mappa e almeno un token selezionato (solo GM). */
  | "selection"
  /** Con il focus sulla mappa, solo GM. */
  | "gm";

export interface ShortcutDef {
  id: string;
  /** Tasti equivalenti, nella forma di `KeyboardEvent.key` (lettere in minuscolo) con modificatori espliciti. */
  keys: readonly string[];
  label: string;
  group: "Generali" | "Mappa" | "Misure" | "Selezione" | "Strumenti del GM";
  scope: ShortcutScope;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "help", keys: ["?"], label: "Mostra questo elenco", group: "Generali", scope: "global" },
  { id: "chat", keys: ["/", "Enter"], label: "Vai alla chat", group: "Generali", scope: "global" },
  { id: "undo", keys: ["Mod+z"], label: "Annulla", group: "Generali", scope: "global" },
  { id: "redo", keys: ["Mod+Shift+z", "Ctrl+y"], label: "Ripeti", group: "Generali", scope: "global" },
  { id: "escape", keys: ["Escape"], label: "Annulla il gesto, chiudi la finestra", group: "Generali", scope: "global" },

  { id: "pan", keys: [" "], label: "Trascina la mappa (tieni premuto)", group: "Mappa", scope: "map" },
  { id: "zoom-in", keys: ["+", "="], label: "Ingrandisci", group: "Mappa", scope: "map" },
  { id: "zoom-out", keys: ["-", "_"], label: "Riduci", group: "Mappa", scope: "map" },
  { id: "fit", keys: ["0"], label: "Adatta la mappa allo schermo", group: "Mappa", scope: "map" },
  { id: "nudge", keys: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d"], label: "Sposta il token selezionato di una cella (frecce o WASD)", group: "Mappa", scope: "map" },

  { id: "ruler", keys: ["r"], label: "Righello", group: "Misure", scope: "map" },
  { id: "circle", keys: ["o"], label: "Cerchio", group: "Misure", scope: "map" },
  { id: "cone", keys: ["c"], label: "Cono", group: "Misure", scope: "map" },
  { id: "line", keys: ["l"], label: "Linea", group: "Misure", scope: "map" },
  { id: "arrow", keys: ["f"], label: "Freccia", group: "Misure", scope: "map" },
  { id: "ping", keys: ["p"], label: "Segnalazione", group: "Misure", scope: "map" },

  { id: "damage", keys: ["x"], label: "Danno", group: "Selezione", scope: "selection" },
  { id: "heal", keys: ["h"], label: "Cura", group: "Selezione", scope: "selection" },
  { id: "condition", keys: ["k"], label: "Condizione", group: "Selezione", scope: "selection" },
  { id: "effect", keys: ["e"], label: "Effetto", group: "Selezione", scope: "selection" },
  { id: "edit", keys: ["m"], label: "Modifica il token selezionato", group: "Selezione", scope: "selection" },

  { id: "select", keys: ["v"], label: "Strumento di selezione", group: "Strumenti del GM", scope: "gm" },
  { id: "fog", keys: ["n"], label: "Nebbia di guerra", group: "Strumenti del GM", scope: "gm" },
  { id: "wall", keys: ["b"], label: "Muri e porte", group: "Strumenti del GM", scope: "gm" }
];

/** Quali contesti possono essere attivi insieme: due scorciatoie in contesti sovrapposti non possono avere lo stesso tasto. */
const OVERLAP: Record<ShortcutScope, readonly ShortcutScope[]> = {
  global: ["global", "map", "selection", "gm"],
  map: ["global", "map", "selection", "gm"],
  selection: ["global", "map", "selection", "gm"],
  gm: ["global", "map", "selection", "gm"]
};

/** Coppie in conflitto (stesso tasto, contesti che si sovrappongono). Vuoto se il registro e' coerente. */
export function shortcutConflicts(list: readonly ShortcutDef[] = SHORTCUTS): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]!;
      const b = list[j]!;
      if (!OVERLAP[a.scope].includes(b.scope)) continue;
      for (const k of a.keys) if (b.keys.includes(k)) out.push([a.id, b.id, k]);
    }
  }
  return out;
}

/** Testo di un tasto per l'aiuto (Mod = Cmd su Mac, Ctrl altrove). */
export function keyLabel(key: string, mac = /Mac|iPhone|iPad/.test(typeof navigator === "undefined" ? "" : navigator.platform)): string {
  const map: Record<string, string> = { " ": "Spazio", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  return key
    .split("+")
    .map((part) => map[part] ?? (part === "Mod" ? (mac ? "Cmd" : "Ctrl") : part.length === 1 ? part.toUpperCase() : part))
    .join("+");
}

/** `?` (a focus fuori dai campi di testo e dai dialoghi) apre l'aiuto. */
export function isHelpKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target" | "defaultPrevented">): boolean {
  if (e.defaultPrevented || e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (isEditableTarget(e.target)) return false;
  const t = e.target instanceof HTMLElement ? e.target : null;
  return !t?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]');
}

export function useHelpShortcut(open: () => void): void {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!isHelpKey(e)) return;
      e.preventDefault();
      open();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open]);
}
