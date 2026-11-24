import { describe, expect, it } from "vitest";
import { cellFromCalibration } from "./GridPreview";

describe("calibrazione della cella dalla distanza reale", () => {
  it("300 px valgono 30 piedi, una cella 5 piedi: cella di 50 px", () => {
    expect(cellFromCalibration({ x: 0, y: 0 }, { x: 300, y: 0 }, 30, 5)).toBeCloseTo(50, 6);
  });

  it("la distanza è in linea retta (diagonale)", () => {
    // 3-4-5: 500 px in diagonale, 50 unità reali, una cella vale 5 unità: 500 * 5 / 50 = 50.
    expect(cellFromCalibration({ x: 0, y: 0 }, { x: 300, y: 400 }, 50, 5)).toBeCloseTo(50, 6);
  });

  it("valori non validi non producono una cella", () => {
    expect(cellFromCalibration({ x: 5, y: 5 }, { x: 5, y: 5 }, 30, 5)).toBeNull();
    expect(cellFromCalibration({ x: 0, y: 0 }, { x: 300, y: 0 }, 0, 5)).toBeNull();
    expect(cellFromCalibration({ x: 0, y: 0 }, { x: 300, y: 0 }, 30, 0)).toBeNull();
  });
});
