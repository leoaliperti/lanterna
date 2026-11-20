import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import {
  FOG_TILE_SIZE,
  cellCol,
  cellRow,
  isCellRevealed,
  tileCoverage,
  tileCoverageKey,
  tileGrid,
  tileRect,
  type Fog,
  type FogMask,
  type Scene,
} from "@lanterna/shared";

/**
 * Tessere della mappa per giocatore (M6, nebbia di guerra).
 *
 * Il giocatore non riceve mai l'URL dell'immagine intera di una scena con nebbia: chiede le
 * tessere (`FOG_TILE_SIZE` px della scena) e il server le produce SOLO se almeno una cella
 * della tessera è rivelata a lui, oscurando i pixel delle celle coperte. Senza dipendenze
 * native: decodifica in JavaScript puro (pngjs, jpeg-js) o WebAssembly (@jsquash/webp).
 *
 * 1. Prima richiesta per un asset: l'immagine si decodifica una volta sola e i pixel RGBA
 *    grezzi si salvano in `UPLOAD_DIR/.tiles/<uuid>.rgba` (4 byte per pixel).
 * 2. Ogni tessera legge dal file solo le righe che le servono, applica la maschera del
 *    giocatore (pixel coperti neri, e trasparenti nei PNG) e la codifica: JPEG (qualità 85)
 *    se la mappa è JPEG, altrimenti PNG.
 * 3. Le tessere codificate restano in una cache LRU in memoria indicizzata da asset,
 *    dimensioni della scena, tessera e **celle rivelate sotto la tessera**: quando la nebbia
 *    cambia la chiave cambia e la vecchia tessera non si serve più (invalidazione implicita).
 */

export interface RenderedTile {
  body: Buffer;
  mime: "image/png" | "image/jpeg";
  etag: string;
}

export interface TileAsset {
  id: string;
  ext: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

export interface TileServiceOptions {
  uploadDir: string;
  /** Byte massimi della cache in memoria delle tessere codificate. */
  cacheBytes?: number;
}

const require = createRequire(import.meta.url);
let webpReady: Promise<(buf: ArrayBuffer) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>> | null = null;

/** Decodificatore WebP (libwebp in WebAssembly, da @jsquash/webp), inizializzato una volta. */
function webpDecoder() {
  webpReady ??= (async () => {
    const mod = (await import("@jsquash/webp/decode.js")) as unknown as {
      default: (buf: ArrayBuffer) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>;
      init: (module: WebAssembly.Module) => Promise<unknown>;
    };
    const wasm = await WebAssembly.compile(await readFile(require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm")));
    await mod.init(wasm);
    return mod.default;
  })();
  return webpReady;
}

/** Decodifica un file PNG/JPEG/WebP in RGBA a 8 bit. */
export async function decodeImage(buf: Buffer, mime: TileAsset["mime"]): Promise<{ data: Uint8Array; width: number; height: number }> {
  if (mime === "image/png") {
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height };
  }
  if (mime === "image/jpeg") {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048, maxResolutionInMP: 120 });
    return { data: img.data, width: img.width, height: img.height };
  }
  const decode = await webpDecoder();
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const img = await decode(ab);
  return { data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height };
}

export class TileService {
  private readonly dir: string;
  private readonly cache = new Map<string, RenderedTile>();
  private cacheSize = 0;
  private readonly cacheMax: number;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly options: TileServiceOptions) {
    this.dir = join(options.uploadDir, ".tiles");
    this.cacheMax = options.cacheBytes ?? 64 * 1024 * 1024;
  }

  /** File RGBA grezzo dell'asset, creato alla prima richiesta (una sola decodifica alla volta per asset). */
  private raw(asset: TileAsset): Promise<string> {
    const path = join(this.dir, `${asset.id}.rgba`);
    let p = this.inflight.get(asset.id);
    if (p) return p;
    p = (async () => {
      const expected = asset.width * asset.height * 4;
      const st = await stat(path).catch(() => null);
      if (st && st.size === expected) return path;
      await mkdir(this.dir, { recursive: true });
      const img = await decodeImage(await readFile(join(this.options.uploadDir, `${asset.id}.${asset.ext}`)), asset.mime);
      if (img.width !== asset.width || img.height !== asset.height || img.data.length < expected) {
        throw new Error("dimensioni decodificate diverse dall'intestazione");
      }
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, img.data.subarray(0, expected), { mode: 0o600 });
      await rename(tmp, path);
      return path;
    })().finally(() => this.inflight.delete(asset.id));
    this.inflight.set(asset.id, p);
    return p;
  }

  /** Prepara il file grezzo in anticipo (es. quando il GM attiva la nebbia). Gli errori si ignorano. */
  warm(asset: TileAsset): void {
    this.raw(asset).catch(() => undefined);
  }

  /**
   * Tessera (col, row) della scena per una maschera (`null` = GM, nessuna maschera).
   * `null` se la tessera non esiste o non ha nessuna cella rivelata: il chiamante risponde 404,
   * identico a quello di una tessera inesistente.
   */
  async render(asset: TileAsset, scene: Scene, fog: Fog | null, mask: FogMask | null, col: number, row: number): Promise<RenderedTile | null> {
    const grid = tileGrid(scene.width, scene.height);
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null;
    let coverage: "none" | "partial" | "full" = "full";
    let coverageKey = "tutto";
    if (mask) {
      if (!fog) return null;
      coverage = tileCoverage(mask, fog, col, row, scene.width, scene.height);
      if (coverage === "none") return null;
      coverageKey = coverage === "full" ? "tutto" : tileCoverageKey(mask, fog, col, row, scene.width, scene.height);
    }
    const key = `${asset.id}|${scene.width}x${scene.height}|${col},${row}|${coverageKey}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }

    const t = tileRect(col, row, scene.width, scene.height, FOG_TILE_SIZE);
    const sx = asset.width / scene.width;
    const sy = asset.height / scene.height;
    const ix0 = Math.min(asset.width, Math.round(t.x0 * sx));
    const ix1 = Math.min(asset.width, Math.round(t.x1 * sx));
    const iy0 = Math.min(asset.height, Math.round(t.y0 * sy));
    const iy1 = Math.min(asset.height, Math.round(t.y1 * sy));
    const w = ix1 - ix0;
    const h = iy1 - iy0;
    if (w <= 0 || h <= 0) return null;

    const data = Buffer.alloc(w * h * 4);
    const fh = await open(await this.raw(asset), "r");
    try {
      for (let y = 0; y < h; y++) {
        await fh.read(data, y * w * 4, w * 4, ((iy0 + y) * asset.width + ix0) * 4);
      }
    } finally {
      await fh.close();
    }

    const transparent = asset.mime !== "image/jpeg";
    if (mask && fog && coverage === "partial") {
      // Cella della nebbia di ogni colonna e riga di pixel (centro del pixel in coordinate scena).
      const cols = new Int32Array(w);
      const rows = new Int32Array(h);
      for (let x = 0; x < w; x++) cols[x] = cellCol(fog, (ix0 + x + 0.5) / sx);
      for (let y = 0; y < h; y++) rows[y] = cellRow(fog, (iy0 + y + 0.5) / sy);
      const revealed = new Map<string, boolean>();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const k = `${cols[x]},${rows[y]}`;
          let v = revealed.get(k);
          if (v === undefined) revealed.set(k, (v = isCellRevealed(mask, cols[x]!, rows[y]!)));
          if (v) continue;
          const i = (y * w + x) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          if (transparent) data[i + 3] = 0;
        }
      }
    }

    let body: Buffer;
    let mime: RenderedTile["mime"];
    if (transparent) {
      const png = new PNG({ width: w, height: h });
      data.copy(png.data);
      body = PNG.sync.write(png, { deflateLevel: 6 });
      mime = "image/png";
    } else {
      body = Buffer.from(jpeg.encode({ data, width: w, height: h }, 85).data);
      mime = "image/jpeg";
    }
    const etag = `"${createHash("sha256").update(key).digest("base64url").slice(0, 27)}"`;
    const tile: RenderedTile = { body, mime, etag };
    this.cache.set(key, tile);
    this.cacheSize += body.length;
    while (this.cacheSize > this.cacheMax && this.cache.size > 0) {
      const [k, v] = this.cache.entries().next().value as [string, RenderedTile];
      this.cache.delete(k);
      this.cacheSize -= v.body.length;
    }
    return tile;
  }

  /** Toglie i file grezzi (per i test). */
  async clear(): Promise<void> {
    this.cache.clear();
    this.cacheSize = 0;
    await rm(this.dir, { recursive: true, force: true });
  }
}
