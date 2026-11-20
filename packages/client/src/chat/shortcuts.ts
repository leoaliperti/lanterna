import { useEffect } from "react";
import { isEditableTarget } from "../table/shortcuts";

/**
 * `/` oppure Invio (a focus sul tavolo o sul corpo della pagina) portano il cursore nella chat.
 * Si ignora dentro i campi di testo, nei dialoghi e con modificatori. Esc dal campo e' gestito dal campo stesso.
 */
export function isChatFocusKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target" | "defaultPrevented">): boolean {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (isEditableTarget(e.target)) return false;
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (t?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return false;
  if (e.key === "/") return true;
  if (e.key === "Enter") return t === null || t === document.body || t.id === "mappa";
  return false;
}

export function useChatShortcuts(focusChat: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (!isChatFocusKey(e)) return;
      e.preventDefault();
      focusChat();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [focusChat, enabled]);
}
