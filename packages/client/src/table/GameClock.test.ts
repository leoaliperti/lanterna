import { describe, expect, it } from "vitest";
import { advanceClock, formatClock } from "./GameClock";

describe("orologio di gioco", () => {
  it("formatta giorno e ora", () => {
    expect(formatClock({ day: 3, minute: 14 * 60 + 5 })).toBe("Giorno 3 · 14:05");
  });

  it("avanza dentro la giornata", () => {
    expect(advanceClock({ day: 1, minute: 480 }, 60)).toEqual({ day: 1, minute: 540 });
  });

  it("passa al giorno successivo oltre la mezzanotte", () => {
    expect(advanceClock({ day: 1, minute: 23 * 60 + 50 }, 20)).toEqual({ day: 2, minute: 10 });
    expect(advanceClock({ day: 4, minute: 0 }, 8 * 60 * 3)).toEqual({ day: 5, minute: 0 });
  });
});
