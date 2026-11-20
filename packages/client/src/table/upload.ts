/** Controlli sul file scelto, prima di spedirlo. Il server ripete tutto (magic bytes, limiti in pixel e in byte). */

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const ACCEPT_ATTR = ACCEPTED_IMAGE_TYPES.join(",");
/** Stesso valore di default del server (`UPLOAD_MAX_BYTES`, 25 MiB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type FileCheck = { ok: true } | { ok: false; message: string };

export function validateImageFile(file: Pick<File, "type" | "size" | "name">): FileCheck {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, message: "Formato non supportato: usa un'immagine PNG, JPEG o WebP." };
  }
  if (file.size === 0) return { ok: false, message: "Il file è vuoto." };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: `Il file pesa troppo (${formatBytes(file.size)}): il limite è ${formatBytes(MAX_UPLOAD_BYTES)}.` };
  }
  return { ok: true };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
