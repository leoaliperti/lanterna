import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiceTray, type DiceTrayHandle } from "./DiceTray";
import type { PhysicalDie } from "./dice";

const sceneMock = vi.hoisted(() => ({
  instances: [] as { dispose: ReturnType<typeof vi.fn>; roll: ReturnType<typeof vi.fn> }[],
}));

vi.mock("./scene", () => ({
  DiceScene: class {
    dispose = vi.fn();
    roll = vi.fn<(dice: readonly PhysicalDie[], reduced: boolean) => Promise<void>>(() => Promise.resolve());
    clear = vi.fn();
    resize = vi.fn();
    constructor() {
      sceneMock.instances.push(this);
    }
  },
}));

function stubWebGL(available: boolean) {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() =>
    available ? { getExtension: () => null } : null) as never);
}

beforeEach(() => {
  sceneMock.instances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DiceTray senza WebGL", () => {
  it("mostra solo il risultato testuale e avvisa", async () => {
    stubWebGL(false);
    const ref = createRef<DiceTrayHandle>();
    const onSettled = vi.fn();
    const { container } = render(<DiceTray ref={ref} onSettled={onSettled} />);
    expect(container.querySelector(".lanterna-dice-tray__stage")?.hasAttribute("hidden")).toBe(true);
    expect(screen.getByText(/Anteprima 3D non disponibile/)).toBeTruthy();

    const dice = [
      { sides: 20, value: 14 },
      { sides: 100, value: 42 },
    ] as const;
    await act(() => ref.current!.roll(dice));
    expect(screen.getByRole("status").textContent).toBe("d20 14 · d% 42");
    expect(onSettled).toHaveBeenCalledWith(dice);
    expect(sceneMock.instances).toHaveLength(0); // Three.js non viene nemmeno caricato
  });

  it("rifiuta dadi o valori non validi e non cambia il risultato", async () => {
    stubWebGL(false);
    const ref = createRef<DiceTrayHandle>();
    render(<DiceTray ref={ref} />);
    await expect(ref.current!.roll([{ sides: 6, value: 9 }])).rejects.toBeInstanceOf(RangeError);
    await expect(ref.current!.roll([{ sides: 7 as 6, value: 1 }])).rejects.toBeInstanceOf(RangeError);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("clear svuota il risultato", async () => {
    stubWebGL(false);
    const ref = createRef<DiceTrayHandle>();
    render(<DiceTray ref={ref} />);
    await act(() => ref.current!.roll([{ sides: 4, value: 3 }]));
    expect(screen.getByRole("status").textContent).toBe("d4 3");
    act(() => ref.current!.clear());
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("senza onActivate il tavolo non e' un pulsante; con onActivate si attiva da tastiera e clic", async () => {
    stubWebGL(true);
    const onActivate = vi.fn();
    const { container, rerender } = render(<DiceTray />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<DiceTray onActivate={onActivate} />);
    const btn = screen.getByRole("button", { name: "Tavolo dei dadi" });
    act(() => btn.click());
    act(() => {
      btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(container).toBeTruthy();
  });
});

describe("DiceTray con WebGL (scena simulata)", () => {
  it("carica la scena, anima con i valori ricevuti e la rilascia allo smontaggio", async () => {
    stubWebGL(true);
    const ref = createRef<DiceTrayHandle>();
    const { unmount } = render(<DiceTray ref={ref} />);
    await waitFor(() => expect(sceneMock.instances).toHaveLength(1));

    await act(() => ref.current!.roll([{ sides: 100, value: 100 }, { sides: 8, value: 5 }]));
    const scene = sceneMock.instances[0]!;
    expect(scene.roll).toHaveBeenCalledTimes(1);
    expect(scene.roll.mock.calls[0]![0]).toEqual([
      { kind: "d10tens", value: 0, request: 0 },
      { kind: "d10units", value: 0, request: 0 },
      { kind: "d8", value: 5, request: 1 },
    ]);
    expect(screen.getByRole("status").textContent).toBe("d% 100 · d8 5");

    unmount();
    expect(scene.dispose).toHaveBeenCalledTimes(1);
  });

  it("rispetta prefers-reduced-motion", async () => {
    stubWebGL(true);
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    const ref = createRef<DiceTrayHandle>();
    render(<DiceTray ref={ref} />);
    await waitFor(() => expect(sceneMock.instances).toHaveLength(1));
    await act(() => ref.current!.roll([{ sides: 6, value: 2 }]));
    expect(sceneMock.instances[0]!.roll.mock.calls[0]![1]).toBe(true);
  });

  it("in StrictMode ogni scena creata viene rilasciata", async () => {
    stubWebGL(true);
    const { unmount } = render(
      <StrictMode>
        <DiceTray />
      </StrictMode>,
    );
    await waitFor(() => expect(sceneMock.instances.length).toBeGreaterThanOrEqual(1));
    unmount();
    await waitFor(() => {
      for (const s of sceneMock.instances) expect(s.dispose).toHaveBeenCalledTimes(1);
    });
  });

  it("un tiro sostituito da uno piu' recente non mostra il vecchio risultato", async () => {
    stubWebGL(true);
    const ref = createRef<DiceTrayHandle>();
    render(<DiceTray ref={ref} />);
    await waitFor(() => expect(sceneMock.instances).toHaveLength(1));
    const scene = sceneMock.instances[0]!;
    let releaseFirst: () => void = () => {};
    scene.roll.mockImplementationOnce(() => new Promise<void>((r) => (releaseFirst = r)));
    let first!: Promise<void>;
    act(() => {
      first = ref.current!.roll([{ sides: 6, value: 1 }]);
    });
    await act(() => ref.current!.roll([{ sides: 6, value: 6 }]));
    await act(async () => {
      releaseFirst();
      await first;
    });
    expect(screen.getByRole("status").textContent).toBe("d6 6");
  });
});
