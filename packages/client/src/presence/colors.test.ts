import { describe, expect, it } from "vitest";
import { GM_COLOR, PLAYER_PALETTE, presenceColor } from "./colors";

describe("presenceColor", () => {
  it("il GM ha sempre lo stesso colore, fuori dalla tavolozza dei giocatori", () => {
    expect(presenceColor("gm-1", true)).toBe(GM_COLOR);
    expect(presenceColor("gm-2", true)).toBe(GM_COLOR);
    expect(PLAYER_PALETTE).not.toContain(GM_COLOR);
  });

  it("ogni giocatore ha un colore stabile dalla tavolozza", () => {
    const first = presenceColor("user-abc", false);
    expect(presenceColor("user-abc", false)).toBe(first);
    expect(PLAYER_PALETTE).toContain(first);
  });

  it("giocatori diversi ricevono colori diversi quando la tavolozza lo permette", () => {
    const ids = ["luca", "sara", "marco", "elena"];
    const colors = new Set(ids.map((id) => presenceColor(id, false)));
    expect(colors.size).toBeGreaterThan(1);
  });
});
