import { describe, expect, it } from "vitest";
import { CONE_ANGLE_DEG, ShapeSchema, coneContains, shapeCells } from "@lanterna/shared";
import { cellRects, directionDeg, ephemeralAlpha, measureLabel, measureShape, outlinePolygon } from "./measure";

const scale = { unitsPerCell: 5, unitLabel: "piedi" };
const CELL = 70;

describe("misure e segnalazioni", () => {
  it("produce forme valide per il protocollo", () => {
    const a = { x: 105, y: 105 };
    const b = { x: 455, y: 105 };
    for (const tool of ["ruler", "circle", "cone", "line", "arrow", "ping"] as const) {
      const s = measureShape(tool, a, b, CELL);
      expect(s, tool).not.toBeNull();
      expect(ShapeSchema.safeParse(s).success, tool).toBe(true);
    }
    expect(measureShape("circle", a, a, CELL)).toBeNull();
    expect(measureShape("ping", a, a, CELL)).toEqual({ kind: "ping", x: 105, y: 105 });
  });

  it("il cono 5e usa l'angolo di 53,13 gradi e punta dove si trascina", () => {
    const shape = measureShape("cone", { x: 0, y: 0 }, { x: 0, y: 210 }, CELL)!;
    expect(shape).toMatchObject({ kind: "cone", direction: 90, length: 210 });
    expect("angle" in shape).toBe(false); // il server usa CONE_ANGLE_DEG
    expect(CONE_ANGLE_DEG).toBeCloseTo(53.13, 2);
    // Larghezza del cono alla distanza d: uguale a d (regola 5e).
    if (shape.kind !== "cone") throw new Error("cono atteso");
    const c = { ...shape, x: 500, y: 100 };
    expect(coneContains(c, 500 + 100, 100 + 0)).toBe(false); // sul lato, oltre l'angolo
    expect(coneContains(c, 500 + 10, 100 + 100)).toBe(true);
    expect(coneContains(c, 500 + 50.4, 100 + 100)).toBe(false);
    expect(directionDeg({ x: 0, y: 0 }, { x: -1, y: 0 })).toBe(180);
    expect(directionDeg({ x: 0, y: 0 }, { x: 0, y: -1 })).toBe(270);
  });

  it("scrive le misure nelle unita' di gioco", () => {
    const origin = { x: 70, y: 70 };
    expect(measureLabel(measureShape("circle", origin, { x: 70 + 140, y: 70 }, CELL)!, CELL, scale)).toBe("Raggio 10 piedi");
    expect(measureLabel(measureShape("cone", origin, { x: 70 + 420, y: 70 }, CELL)!, CELL, scale)).toBe("Cono 30 piedi");
    expect(measureLabel(measureShape("line", origin, { x: 70 + 840, y: 70 }, CELL)!, CELL, scale)).toBe("Linea 60 piedi x 5 piedi");
    expect(measureLabel(measureShape("ruler", origin, { x: 70 + 210, y: 70 + 210 }, CELL)!, CELL, scale, "grid")).toBe("15 piedi");
    expect(measureLabel(measureShape("ruler", origin, { x: 70 + 210, y: 70 + 210 }, CELL)!, CELL, scale, "euclidean")).toBe("21,2 piedi");
    expect(measureLabel(measureShape("arrow", origin, { x: 200, y: 200 }, CELL)!, CELL, scale)).toBe("");
  });

  it("disegna i contorni e le celle ricevute senza ricostruire nulla", () => {
    expect(outlinePolygon({ kind: "circle", x: 0, y: 0, radius: 10 })!.length).toBe(128);
    const cone = outlinePolygon({ kind: "cone", x: 0, y: 0, direction: 0, length: 100 })!;
    expect(cone.slice(0, 2)).toEqual([0, 0]);
    expect(outlinePolygon({ kind: "ping", x: 0, y: 0 })).toBeNull();
    const line = outlinePolygon({ kind: "line", x1: 0, y1: 0, x2: 100, y2: 0, width: 20 })!;
    expect(line.map((n) => n + 0)).toEqual([0, 10, 100, 10, 100, -10, 0, -10]);
    // Le celle `cells` ritagliate dal server restano celle: nessuna coordinata da dedurre.
    expect(cellRects([1, 2, 3, 4], { cellSize: 70, offsetX: 10, offsetY: 20 })).toEqual([
      { x: 80, y: 160, width: 70, height: 70 },
      { x: 220, y: 300, width: 70, height: 70 }
    ]);
    expect(shapeCells({ kind: "ping", x: 100, y: 100 }, { cellSize: 70, offsetX: 0, offsetY: 0 })).toEqual([1, 1]);
  });

  it("la dissolvenza c'e' solo con il movimento normale", () => {
    expect(ephemeralAlpha(5000, 700, false)).toBe(1);
    expect(ephemeralAlpha(350, 700, false)).toBeCloseTo(0.5);
    expect(ephemeralAlpha(350, 700, true)).toBe(1);
    expect(ephemeralAlpha(0, 700, true)).toBe(0);
    expect(ephemeralAlpha(-5, 700, false)).toBe(0);
  });
});
