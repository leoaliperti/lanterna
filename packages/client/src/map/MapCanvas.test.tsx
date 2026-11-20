import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapCanvas } from "./MapCanvas";
import { MapController } from "./controller";
import { bindCanvasInput } from "./input";
import type { MapScene, MapToken } from "./types";

const tok = (id: string, label: string, extra: Partial<MapToken> = {}): MapToken => ({ id, x: 100, y: 100, size: 1, rotation: 0, kind: "npc", label, ...extra });
const scene: MapScene = {
  background: { url: "x.png", width: 1000, height: 800 },
  grid: { cellSize: 50, color: "#ffffff", opacity: 0.3, offsetX: 0, offsetY: 0, snap: true },
  scale: { unitsPerCell: 5, unitLabel: "piedi" },
  tokens: [tok("a", "Aria"), tok("g", "Goblin segreto", { hidden: true })],
  role: "player",
  movableTokenIds: ["a"]
};

afterEach(cleanup);

describe("MapCanvas senza WebGL (jsdom)", () => {
  it("mostra l'avviso e l'elenco dei token, senza i nascosti per un giocatore", () => {
    render(<MapCanvas {...scene} />);
    expect(screen.getByText("Mappa non disponibile")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Token sulla mappa" }).textContent).toBe("Aria");
  });
  it("il GM vede anche i nascosti, marcati", () => {
    render(<MapCanvas {...scene} role="gm" />);
    expect(screen.getByRole("list", { name: "Token sulla mappa" }).textContent).toContain("Goblin segreto (nascosto)");
  });
  it("si smonta senza errori", () => {
    const { unmount } = render(<MapCanvas {...scene} />);
    expect(() => unmount()).not.toThrow();
  });
});

describe("bindCanvasInput", () => {
  it("traduce gli eventi DOM in chiamate al controller e si stacca", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const c = new MapController();
    c.init({ x: 0, y: 0, scale: 1 });
    c.setSize(1000, 800);
    c.setScene(scene);
    const onSel = vi.fn();
    c.handlers = { onSelectionChange: onSel };
    const unbind = bindCanvasInput(el, c);

    const wheel = new WheelEvent("wheel", { deltaY: -200, clientX: 400, clientY: 300, cancelable: true });
    el.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(c.viewport.scale).toBeGreaterThan(1);

    const key = new KeyboardEvent("keydown", { key: "r", cancelable: true });
    el.dispatchEvent(key);
    expect(c.tool).toBe("ruler");
    expect(key.defaultPrevented).toBe(true);

    unbind();
    const before = c.viewport.scale;
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, cancelable: true }));
    expect(c.viewport.scale).toBe(before);
  });
});
