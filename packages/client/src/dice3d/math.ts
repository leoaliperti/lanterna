// Matematica minima per vettori e quaternioni, senza dipendenze (nemmeno Three.js):
// così la logica dei dadi si testa in Node e non entra nel bundle iniziale.

export type Vec3 = readonly [number, number, number];
/** Quaternione [x, y, z, w], come in Three.js. */
export type Quat = readonly [number, number, number, number];

export const UP: Vec3 = [0, 1, 0];
export const IDENTITY: Quat = [0, 0, 0, 1];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l === 0 ? [0, 0, 0] : scale(a, 1 / l);
};
export const negate = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

export function centroid(points: readonly Vec3[]): Vec3 {
  let sum: Vec3 = [0, 0, 0];
  for (const p of points) sum = add(sum, p);
  return scale(sum, 1 / points.length);
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const a = normalize(axis);
  const s = Math.sin(angle / 2);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
}

/** Prodotto a * b: applica prima b, poi a. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Rotazione di minimo angolo che porta il versore `from` su `to`. */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const r = dot(from, to) + 1;
  if (r < 1e-9) {
    // Vettori opposti: mezzo giro attorno a un asse qualsiasi perpendicolare a `from`.
    const perp: Vec3 = Math.abs(from[0]) > Math.abs(from[2]) ? [-from[1], from[0], 0] : [0, -from[2], from[1]];
    return quatFromAxisAngle(perp, Math.PI);
  }
  const c = cross(from, to);
  return quatNormalize([c[0], c[1], c[2], r]);
}

/** Ruota il vettore `v` con il quaternione `q`. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const w = q[3];
  const uv = cross(u, v);
  const uuv = cross(u, uv);
  return add(v, scale(add(scale(uv, w), uuv), 2));
}

export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    return quatNormalize([
      a[0] + (bx - a[0]) * t,
      a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t,
      a[3] + (bw - a[3]) * t,
    ]);
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}
