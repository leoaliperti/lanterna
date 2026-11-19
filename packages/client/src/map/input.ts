import type { MapController, PointerInput } from "./controller";

/** Collega gli eventi DOM del canvas al controller. Ritorna la funzione che toglie i listener. */
export function bindCanvasInput(canvas: HTMLElement, controller: MapController): () => void {
  const local = (e: MouseEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toInput = (e: PointerEvent): PointerInput => ({
    id: e.pointerId, type: e.pointerType || "mouse", button: e.button, ...local(e),
    shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey
  });

  const down = (e: PointerEvent) => {
    if (e.button === 1) e.preventDefault(); // niente autoscroll del tasto centrale
    canvas.focus({ preventScroll: true });
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* puntatore gia' rilasciato: ignora */
    }
    controller.pointerDown(toInput(e));
  };
  const move = (e: PointerEvent) => controller.pointerMove(toInput(e));
  const up = (e: PointerEvent) => controller.pointerUp(toInput(e));
  const cancel = (e: PointerEvent) => controller.pointerCancel(toInput(e));
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    controller.wheel(p.x, p.y, e.deltaY, e.deltaMode, e.ctrlKey);
  };
  const keydown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (controller.keyDown(e.key, e.shiftKey)) e.preventDefault();
  };
  const keyup = (e: KeyboardEvent) => controller.keyUp(e.key);
  const blur = () => controller.blur();
  const noMenu = (e: Event) => e.preventDefault();

  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("keydown", keydown);
  canvas.addEventListener("keyup", keyup);
  canvas.addEventListener("blur", blur);
  canvas.addEventListener("contextmenu", noMenu);
  return () => {
    canvas.removeEventListener("pointerdown", down);
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", cancel);
    canvas.removeEventListener("wheel", wheel);
    canvas.removeEventListener("keydown", keydown);
    canvas.removeEventListener("keyup", keyup);
    canvas.removeEventListener("blur", blur);
    canvas.removeEventListener("contextmenu", noMenu);
  };
}
