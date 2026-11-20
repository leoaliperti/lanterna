import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PointMenu, Sheet, TextField } from "./index";

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
});
afterEach(() => cleanup());

/** Come la mappa: il menu si apre da un listener NATIVO di pointerdown (non da un handler di React). */
function Harness() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [picked, setPicked] = useState("");
  return (
    <div>
      <div
        data-testid="surface"
        ref={(el) => {
          if (el && !el.dataset.bound) {
            el.dataset.bound = "1";
            el.addEventListener("pointerdown", (e) => flushSync(() => setPos({ x: e.clientX, y: e.clientY })));
          }
        }}
      >
        superficie
      </div>
      <button type="button">fuori</button>
      <PointMenu position={pos} label="Azioni" items={[{ id: "a", label: "Danno (D)", onSelect: () => setPicked("danno") }]} onClose={() => setPos(null)} />
      <p data-testid="picked">{picked}</p>
    </div>
  );
}

describe("PointMenu", () => {
  it("resta aperto dopo il pointerdown che lo apre, e si chiude con un clic fuori, Esc o la scelta di una voce", async () => {
    const u = userEvent.setup();
    render(<Harness />);
    await u.pointer({ keys: "[MouseRight]", target: screen.getByTestId("surface") });
    // Il document riceve lo stesso pointerdown dopo il listener nativo: il menu non deve chiudersi da solo.
    expect(await screen.findByRole("menu", { name: "Azioni" })).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.getByRole("menu", { name: "Azioni" })).toBeTruthy();

    await u.click(screen.getByRole("button", { name: "fuori" }));
    expect(screen.queryByRole("menu")).toBeNull();

    await u.pointer({ keys: "[MouseRight]", target: screen.getByTestId("surface") });
    await screen.findByRole("menu");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    await u.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    await u.pointer({ keys: "[MouseRight]", target: screen.getByTestId("surface") });
    await u.click(await screen.findByRole("menuitem", { name: "Danno (D)" }));
    expect(screen.getByTestId("picked").textContent).toBe("danno");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Sheet: focus iniziale", () => {
  function WithField() {
    const field = useRef<HTMLInputElement>(null);
    return (
      <Sheet open onOpenChange={() => undefined} title="Prova" initialFocus={field}>
        <TextField ref={field} label="Valore" />
      </Sheet>
    );
  }

  it("puo' partire da un campo invece che dal pulsante Fine", async () => {
    render(<WithField />);
    await screen.findByRole("dialog", { name: "Prova" });
    expect(document.activeElement).toBe(screen.getByLabelText("Valore"));
  });
});
