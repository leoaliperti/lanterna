import { describe, expect, it } from "vitest";
import { ACTION_KEYS } from "../combat/selectionLogic";
import { isChatFocusKey } from "../chat/shortcuts";
import { SHORTCUTS, isHelpKey, keyLabel, shortcutConflicts } from "./shortcutRegistry";

describe("registro delle scorciatoie", () => {
  it("nessun tasto e' usato due volte in contesti sovrapposti", () => {
    expect(shortcutConflicts()).toEqual([]);
  });

  it("rileva un conflitto vero", () => {
    expect(shortcutConflicts([...SHORTCUTS, { id: "x", keys: ["d"], label: "x", group: "Mappa", scope: "map" }]).length).toBe(1);
  });

  it("X/H/K/E restano le azioni sulla selezione, come nella tabella usata dal tavolo (M apre la modifica)", () => {
    const reg = Object.fromEntries(SHORTCUTS.filter((s) => s.scope === "selection" && s.id !== "edit").map((s) => [s.keys[0], s.id]));
    expect(reg).toEqual(ACTION_KEYS);
  });

  it("gli id sono unici", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("? apre l'aiuto fuori dai campi di testo e non dentro", () => {
    const base = { metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false };
    expect(isHelpKey({ ...base, key: "?", target: document.body })).toBe(true);
    expect(isHelpKey({ ...base, key: "?", target: document.createElement("input") })).toBe(false);
    expect(isHelpKey({ ...base, key: "h", target: document.body })).toBe(false);
    expect(isChatFocusKey({ ...base, key: "?", target: document.body })).toBe(false);
  });

  it("etichette dei tasti", () => {
    expect(keyLabel("Mod+Shift+z", true)).toBe("Cmd+Shift+Z");
    expect(keyLabel("Mod+z", false)).toBe("Ctrl+Z");
    expect(keyLabel(" ")).toBe("Spazio");
  });
});
