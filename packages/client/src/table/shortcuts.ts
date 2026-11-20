import { useEffect } from "react";

export type HistoryShortcut = "undo" | "redo";

/** Il bersaglio e' un campo di testo (li' Cmd/Ctrl+Z annulla la digitazione, non il tavolo)? */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(type);
  }
  return false;
}

/** Cmd/Ctrl+Z = annulla; Shift+Cmd/Ctrl+Z (o Ctrl+Y) = ripeti. */
export function historyShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "target">): HistoryShortcut | null {
  if (e.altKey || !(e.metaKey || e.ctrlKey) || isEditableTarget(e.target)) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey) return "redo";
  return null;
}

export function useHistoryShortcuts(handlers: { undo: () => void; redo: () => void; enabled: boolean }): void {
  const { undo, redo, enabled } = handlers;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      const action = historyShortcut(e);
      if (!action) return;
      e.preventDefault();
      if (action === "undo") undo();
      else redo();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [undo, redo, enabled]);
}
