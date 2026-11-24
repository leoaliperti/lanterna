/** Nome pubblico di un file caricato: `<uuid>.<estensione>`. */
export const ASSET_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|webp)$/;

export const ASSETS_PATH = "/assets";

/** Da `/assets/<uuid>.<ext>` all'id del file (e all'estensione), oppure `null` se l'URL non è di un file caricato. */
export function parseAssetUrl(url: string): { id: string; ext: string } | null {
  if (!url.startsWith(`${ASSETS_PATH}/`)) return null;
  const m = ASSET_NAME.exec(url.slice(ASSETS_PATH.length + 1));
  return m ? { id: m[1]!, ext: m[2]! } : null;
}

export const assetUrlOf = (id: string, ext: string): string => `${ASSETS_PATH}/${id}.${ext}`;
