import { describe, expect, it } from "vitest";
import { parseCssColor } from "./color";

describe("parseCssColor", () => {
  it("legge l'esadecimale", () => {
    expect(parseCssColor("#007aff")).toEqual({ value: 0x007aff, alpha: 1 });
    expect(parseCssColor("#fc0")).toEqual({ value: 0xffcc00, alpha: 1 });
    expect(parseCssColor("#00000080").alpha).toBeCloseTo(0.502, 2);
  });
  it("legge rgb() e rgba() con virgole o spazi", () => {
    expect(parseCssColor("rgb(10, 132, 255)")).toEqual({ value: 0x0a84ff, alpha: 1 });
    expect(parseCssColor("rgb(10 132 255 / 0.22)")).toEqual({ value: 0x0a84ff, alpha: 0.22 });
    expect(parseCssColor("rgba(255, 0, 0, 0.5)")).toEqual({ value: 0xff0000, alpha: 0.5 });
    expect(parseCssColor("rgb(0 0 0 / 50%)").alpha).toBe(0.5);
  });
  it("legge color(srgb ...)", () => {
    expect(parseCssColor("color(srgb 1 0 0)")).toEqual({ value: 0xff0000, alpha: 1 });
    expect(parseCssColor("color(srgb 0 0.5 1 / 0.4)").alpha).toBe(0.4);
  });
  it("usa il fallback per input non riconosciuti", () => {
    expect(parseCssColor("tomato", { value: 1, alpha: 1 })).toEqual({ value: 1, alpha: 1 });
    expect(parseCssColor("#12", { value: 2, alpha: 1 }).value).toBe(2);
    expect(parseCssColor("color(display-p3 1 0 0)", { value: 3, alpha: 1 }).value).toBe(3);
    expect(parseCssColor("rgb(a b c)", { value: 4, alpha: 1 }).value).toBe(4);
  });
});
