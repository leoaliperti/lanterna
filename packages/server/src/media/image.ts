/**
 * Riconoscimento del formato dai byte del file (magic bytes) e lettura delle dimensioni
 * dall'intestazione, senza dipendenze e senza decodificare i pixel.
 * Estensione e Content-Type dichiarati dal client vengono ignorati.
 * Formati ammessi: PNG, JPEG, WebP. SVG (e qualunque altro formato) è rifiutato.
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface ImageInfo {
  mime: ImageMime;
  ext: "png" | "jpg" | "webp";
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(buf: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function ascii(buf: Buffer, offset: number, length: number): string {
  if (buf.length < offset + length) return "";
  return buf.toString("latin1", offset, offset + length);
}

function png(buf: Buffer): ImageInfo | null {
  // Firma (8) + lunghezza del primo chunk (4, deve essere 13) + "IHDR" + larghezza + altezza.
  if (buf.length < 33 || !startsWith(buf, PNG_SIGNATURE)) return null;
  if (buf.readUInt32BE(8) !== 13 || ascii(buf, 12, 4) !== "IHDR") return null;
  return { mime: "image/png", ext: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpeg(buf: Buffer): ImageInfo | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++; // byte di riempimento
      continue;
    }
    // Marcatori senza lunghezza.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // fine o dati prima di un SOF
    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return null;
    // SOF0..SOF15 tranne DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > buf.length) return null;
      return { mime: "image/jpeg", ext: "jpg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

function webp(buf: Buffer): ImageInfo | null {
  if (buf.length < 30 || ascii(buf, 0, 4) !== "RIFF" || ascii(buf, 8, 4) !== "WEBP") return null;
  const chunk = ascii(buf, 12, 4);
  const info = (width: number, height: number): ImageInfo => ({ mime: "image/webp", ext: "webp", width, height });
  if (chunk === "VP8 ") {
    // Fotogramma chiave: codice di avvio 9d 01 2a, poi larghezza/altezza a 14 bit.
    if (!startsWith(buf, [0x9d, 0x01, 0x2a], 23)) return null;
    return info(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return info((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") {
    return info(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
  }
  return null;
}

/** Formato e dimensioni, oppure `null` se il file non è un PNG/JPEG/WebP riconoscibile. */
export function sniffImage(buf: Buffer): ImageInfo | null {
  const info = png(buf) ?? jpeg(buf) ?? webp(buf);
  if (!info || info.width < 1 || info.height < 1) return null;
  return info;
}
