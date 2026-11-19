/** Conversione dei colori CSS in numeri 0xRRGGBB (PixiJS) senza dipendere dal DOM. */

export interface ParsedColor {
  /** 0xRRGGBB */
  value: number;
  /** 0..1 */
  alpha: number;
}

const byte = (n: number) => Math.round(Math.min(255, Math.max(0, n)));

function channel(token: string, scale255: boolean): number {
  const t = token.trim();
  if (t.endsWith("%")) return (parseFloat(t) / 100) * (scale255 ? 255 : 1);
  return parseFloat(t) * (scale255 ? 1 : 1);
}

/**
 * Accetta `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` (virgole o spazi, alpha con `/`) e
 * `color(srgb r g b / a)`: e' cio' che `getComputedStyle` restituisce per i token CSS del design system.
 */
export function parseCssColor(input: string, fallback: ParsedColor = { value: 0x808080, alpha: 1 }): ParsedColor {
  const s = input.trim().toLowerCase();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (/^[0-9a-f]{3}$/.test(h)) return { value: parseInt([...h].map((c) => c + c).join(""), 16), alpha: 1 };
    if (/^[0-9a-f]{6}$/.test(h)) return { value: parseInt(h, 16), alpha: 1 };
    if (/^[0-9a-f]{8}$/.test(h)) return { value: parseInt(h.slice(0, 6), 16), alpha: parseInt(h.slice(6), 16) / 255 };
    return fallback;
  }
  const fn = /^(rgba?|color)\(\s*(.+?)\s*\)$/.exec(s);
  if (!fn) return fallback;
  let body = fn[2]!;
  const isColorFn = fn[1] === "color";
  if (isColorFn) {
    if (!body.startsWith("srgb")) return fallback;
    body = body.slice(4).trim();
  }
  const [rgbPart, alphaPart] = body.split("/");
  const parts = rgbPart!.split(/[\s,]+/).filter(Boolean);
  let alphaToken = alphaPart?.trim();
  if (parts.length === 4 && alphaToken === undefined) alphaToken = parts.pop();
  if (parts.length !== 3) return fallback;
  const nums = parts.map((p) => channel(p, !isColorFn));
  if (nums.some((n) => Number.isNaN(n))) return fallback;
  const [r, g, b] = isColorFn ? nums.map((n) => n * 255) : nums;
  let alpha = 1;
  if (alphaToken !== undefined) {
    alpha = alphaToken.endsWith("%") ? parseFloat(alphaToken) / 100 : parseFloat(alphaToken);
    if (Number.isNaN(alpha)) return fallback;
  }
  return { value: (byte(r!) << 16) | (byte(g!) << 8) | byte(b!), alpha: Math.min(1, Math.max(0, alpha)) };
}
