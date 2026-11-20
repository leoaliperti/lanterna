/* Misura (a mano) i costi delle tessere: `npx tsx src/bench/tiles.bench.ts` da packages/server. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { COVERED_MASK, DEFAULT_GRID, DEFAULT_SCALE, maskReveal, rasterizeShape, type Fog, type Scene } from "@lanterna/shared";
import { TileService, type TileAsset } from "../media/tiles.js";

const W = 4000;
const H = 3000;
const dir = await mkdtemp(join(tmpdir(), "lanterna-bench-"));
const rgba = new Uint8Array(W * H * 4);
for (let i = 0; i < rgba.length; i += 4) {
  rgba[i] = (i >> 4) & 255;
  rgba[i + 1] = (i >> 9) & 255;
  rgba[i + 2] = 120;
  rgba[i + 3] = 255;
}
const scene: Scene = {
  id: "s",
  name: "S",
  map: { assetId: "a", url: "/assets/a.png" },
  width: W,
  height: H,
  grid: { ...DEFAULT_GRID },
  scale: { ...DEFAULT_SCALE },
};
const fog: Fog = { sceneId: "s", cellSize: 70, offsetX: 0, offsetY: 0, lighting: "bright", everyone: COVERED_MASK, players: [] };
const mask = maskReveal(COVERED_MASK, rasterizeShape({ kind: "circle", x: 1000, y: 1000, radius: 700 }, fog, W, H));

for (const mime of ["image/jpeg", "image/png"] as const) {
  const id = mime === "image/jpeg" ? "bench-jpg" : "bench-png";
  const ext = mime === "image/jpeg" ? "jpg" : "png";
  const file =
    mime === "image/jpeg"
      ? Buffer.from(jpeg.encode({ data: rgba, width: W, height: H }, 85).data)
      : PNG.sync.write(Object.assign(new PNG({ width: W, height: H }), { data: Buffer.from(rgba) }));
  await writeFile(join(dir, `${id}.${ext}`), file);
  const asset: TileAsset = { id, ext, mime, width: W, height: H };
  const svc = new TileService({ uploadDir: dir, cacheBytes: 0 });
  let t = performance.now();
  await svc.render(asset, scene, fog, null, 0, 0);
  console.log(`${mime} ${W}x${H}: prima tessera (decodifica + file grezzo) ${(performance.now() - t).toFixed(0)} ms`);
  for (const [label, m] of [["intera", null], ["parziale", mask]] as const) {
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      t = performance.now();
      await svc.render(asset, scene, fog, m, 1 + (i % 2), 1);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(`${mime}: tessera ${label} 512x512 mediana ${times[5]!.toFixed(1)} ms`);
  }
}
await rm(dir, { recursive: true, force: true });
