import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, getSettings, resetSettingsCache, updateSettings } from "./settings";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  resetSettingsCache();
});

describe("tema", () => {
  it("di default è automatico e non forza nulla", () => {
    expect(getSettings().theme).toBe("auto");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("scegliere chiaro o scuro lo applica alla pagina e lo ricorda; auto lo toglie", () => {
    updateSettings({ theme: "dark" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    resetSettingsCache();
    expect(getSettings().theme).toBe("dark");
    updateSettings({ theme: "auto" });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("un valore salvato non valido torna a automatico", () => {
    window.localStorage.setItem("lanterna.settings.v1", JSON.stringify({ dice3d: false, theme: "viola" }));
    resetSettingsCache();
    expect(getSettings()).toEqual({ dice3d: false, theme: "auto" });
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
