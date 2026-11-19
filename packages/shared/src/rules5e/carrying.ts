/** Capacita di carico (libbre). */

export type CreatureSize = "tiny" | "small" | "medium" | "large" | "huge" | "gargantuan";

export const SIZE_CARRY_MULTIPLIER: Record<CreatureSize, number> = {
  tiny: 0.5,
  small: 1,
  medium: 1,
  large: 2,
  huge: 4,
  gargantuan: 8,
};

export interface CarryingCapacity {
  /** Forza x 15, per taglia. */
  carry: number;
  /** Spingere, trascinare, sollevare: Forza x 30, per taglia. */
  pushDragLift: number;
}

export function carryingCapacity(strScore: number, size: CreatureSize = "medium"): CarryingCapacity {
  const m = SIZE_CARRY_MULTIPLIER[size];
  return { carry: strScore * 15 * m, pushDragLift: strScore * 30 * m };
}
