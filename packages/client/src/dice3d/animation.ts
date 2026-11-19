// Piano e campionamento dell'animazione di un dado, in funzioni pure.
// L'orientamento finale deriva SOLO dal valore ricevuto (restQuaternion). Il generatore casuale `rng`
// serve soltanto per il movimento cosmetico (rotazione iniziale, assi, giri, durata, direzione di ingresso).

import { type DieKind, restQuaternion } from "./dice";
import { type Quat, type Vec3, quatFromAxisAngle, quatMul, quatNormalize, quatSlerp } from "./math";

export type Rng = () => number;

export interface RollPlan {
  readonly qStart: Quat;
  readonly qEnd: Quat;
  readonly axis: Vec3;
  readonly spins: number;
  readonly durationMs: number;
  readonly from: Vec3;
  readonly to: Vec3;
}

export interface PlanOptions {
  readonly kind: DieKind;
  readonly value: number;
  /** Posizione finale sul tavolo (x, z). */
  readonly target: { readonly x: number; readonly z: number };
  readonly rng?: Rng;
  /** Con prefers-reduced-motion: nessun movimento, il dado compare gia' fermo. */
  readonly reducedMotion?: boolean;
}

function randomQuat(rng: Rng): Quat {
  for (;;) {
    const q: Quat = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1];
    if (Math.hypot(...q) > 0.1) return quatNormalize(q);
  }
}

export function planRoll(opts: PlanOptions): RollPlan {
  const rng = opts.rng ?? Math.random;
  const { x, z } = opts.target;
  const side = rng() < 0.5 ? -1 : 1;
  const qEnd = restQuaternion(opts.kind, opts.value, rng() * Math.PI * 2);
  const reduced = opts.reducedMotion === true;
  return {
    qStart: reduced ? qEnd : randomQuat(rng),
    qEnd,
    axis: [rng() - 0.5, rng() - 0.5, rng() - 0.5],
    spins: (2 + rng() * 3) * Math.PI * 2,
    durationMs: reduced ? 0 : 1400 + rng() * 500,
    from: reduced ? [x, 0, z] : [x + side * 7, 4.5, z - 6 + rng() * 2],
    to: [x, 0, z],
  };
}

export interface Sample {
  readonly quaternion: Quat;
  readonly position: Vec3;
  readonly done: boolean;
}

/** Posa del dado dopo `elapsedMs`. `restY` e' l'altezza del centro a dado fermo. */
export function samplePlan(plan: RollPlan, elapsedMs: number, restY: number): Sample {
  const t = plan.durationMs <= 0 ? 1 : Math.min(1, Math.max(0, elapsedMs / plan.durationMs));
  if (t >= 1) return { quaternion: plan.qEnd, position: [plan.to[0], restY, plan.to[2]], done: true };
  const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
  const base = quatSlerp(plan.qStart, plan.qEnd, e);
  const quaternion = quatMul(base, quatFromAxisAngle(plan.axis, plan.spins * (1 - e)));
  const bounce = Math.abs(Math.sin(t * Math.PI * 2.5)) * (1 - t) * 1.1;
  return {
    quaternion,
    position: [
      plan.from[0] + (plan.to[0] - plan.from[0]) * e,
      plan.from[1] + (restY - plan.from[1]) * e + bounce,
      plan.from[2] + (plan.to[2] - plan.from[2]) * e,
    ],
    done: false,
  };
}
