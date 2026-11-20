import { crc32, deflateSync } from "node:zlib";

/* Immagini minime costruite a mano per i test (nessun file binario nel repo). */

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** PNG valido e decodificabile (RGBA, pixel rossi). Con `fakeData` i pixel non ci sono: solo l'intestazione. */
export function makePng(width: number, height: number, fakeData = false): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profondità
  ihdr[9] = 6; // RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 4, 0xff)]);
  const raw = fakeData ? Buffer.alloc(16) : Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Intestazione JPEG (APP0 JFIF + SOF0) con le dimensioni indicate. */
export function makeJpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function riff(chunkType: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(12 + payload.length, 4);
  head.write("WEBP", 8, "latin1");
  head.write(chunkType, 12, "latin1");
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, payload]);
}

export function makeWebpVP8X(width: number, height: number): Buffer {
  const p = Buffer.alloc(10);
  p.writeUIntLE(width - 1, 4, 3);
  p.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", p);
}

export function makeWebpVP8L(width: number, height: number): Buffer {
  const p = Buffer.alloc(10);
  p[0] = 0x2f;
  p.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  return riff("VP8L", p);
}

export function makeWebpVP8(width: number, height: number): Buffer {
  const p = Buffer.alloc(12);
  p[3] = 0x9d;
  p[4] = 0x01;
  p[5] = 0x2a;
  p.writeUInt16LE(width, 6);
  p.writeUInt16LE(height, 8);
  return riff("VP8 ", p);
}

/** Corpo multipart/form-data con un file. */
export function multipart(
  file: Buffer,
  filename = "mappa.png",
  contentType = "image/png",
  field = "file",
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----lanterna-test-boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
