import { createReadStream } from "node:fs";
import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from "fflate";

/** Errore di un archivio non accettabile. `status` è il codice HTTP da restituire. */
export class ArchiveError extends Error {
  constructor(
    readonly status: 400 | 413 | 415 | 422,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface ZipReadOptions {
  /** Voci massime (file e cartelle). */
  maxEntries: number;
  /** Byte decompressi massimi in totale, contati mentre si decomprime. */
  maxTotalBytes: number;
  /**
   * Decide se una voce è ammessa e quanti byte decompressi può occupare al massimo. Lancia
   * `ArchiveError` per rifiutare l'archivio (nome non ammesso, ecc.).
   */
  admit(name: string): number;
  /** Chiamata una volta per file, con tutti i suoi byte. Può restituire una promessa (attesa a ogni chunk). */
  onEntry(name: string, data: Buffer): void | Promise<void>;
}

const MIB = 1024 * 1024;

/**
 * Legge uno zip da disco in streaming, SENZA mai fidarsi di ciò che l'archivio dichiara:
 * - i nomi passano da `admit` (elenco chiuso): nessun nome è mai usato come percorso;
 * - i byte decompressi sono contati davvero, per voce e in totale: una "bomba" (poche centinaia di KiB
 *   che si espandono in GiB) viene fermata appena supera il limite, senza allocare la memoria;
 * - il file è letto a pezzi da 64 KiB (memoria costante, salvo la voce corrente);
 * - voce duplicata, archivio troncato o con byte in coda alla fine, compressione non supportata: rifiutati.
 */
export async function readZipFile(path: string, opts: ZipReadOptions): Promise<void> {
  const seen = new Set<string>();
  let entries = 0;
  let total = 0;
  let open: string | null = null;
  const pending: Promise<void>[] = [];
  let failure: ArchiveError | null = null;

  const fail = (e: ArchiveError): never => {
    failure = e;
    throw e;
  };

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file: UnzipFile) => {
    entries++;
    if (entries > opts.maxEntries) fail(new ArchiveError(413, `Troppe voci nell'archivio (massimo ${opts.maxEntries}).`));
    const name = file.name;
    if (seen.has(name)) fail(new ArchiveError(400, "Archivio non valido: voce duplicata."));
    seen.add(name);
    // Cartelle: ammessa solo `assets/`, senza contenuto.
    if (name.endsWith("/")) {
      if (name !== "assets/") fail(new ArchiveError(400, `Archivio non valido: voce non ammessa "${safeName(name)}".`));
      return;
    }
    let max: number;
    try {
      max = opts.admit(name);
    } catch (e) {
      if (e instanceof ArchiveError) failure = e;
      throw e;
    }
    // Dimensione dichiarata: rifiuto subito se già oltre il limite (verifica a basso costo; quella vera è sotto).
    if (typeof file.originalSize === "number" && file.originalSize > max) {
      fail(new ArchiveError(413, `Il file "${safeName(name)}" è troppo grande.`));
    }
    open = name;
    const chunks: Buffer[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      // fflate ci restituisce come `err` anche le eccezioni lanciate da noi più sotto: il primo errore vince.
      if (err) throw failure ?? fail(new ArchiveError(400, "Archivio danneggiato o non valido."));
      size += chunk.length;
      total += chunk.length;
      if (size > max) fail(new ArchiveError(413, `Il file "${safeName(name)}" supera il limite una volta decompresso.`));
      if (total > opts.maxTotalBytes) {
        fail(new ArchiveError(413, `L'archivio supera ${Math.round(opts.maxTotalBytes / MIB)} MiB una volta decompresso.`));
      }
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (final) {
        open = null;
        try {
          const r = opts.onEntry(name, Buffer.concat(chunks));
          if (r) pending.push(r);
        } catch (e) {
          if (e instanceof ArchiveError) failure = e;
          throw e;
        }
      }
    };
    try {
      file.start();
    } catch (e) {
      if (e instanceof ArchiveError) throw e;
      fail(new ArchiveError(400, "Compressione non supportata o archivio danneggiato."));
    }
  };

  const push = (chunk: Uint8Array, final: boolean) => {
    try {
      unzip.push(chunk, final);
    } catch (e) {
      if (e instanceof ArchiveError) throw e;
      if (failure) throw failure;
      throw new ArchiveError(400, "Il file non è un archivio zip valido.");
    }
  };

  let any = false;
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      any = true;
      push(chunk as Buffer, false);
      if (pending.length > 0) await Promise.all(pending.splice(0));
    }
    if (!any) throw new ArchiveError(400, "Il file non è un archivio zip valido.");
    push(new Uint8Array(0), true);
    if (pending.length > 0) await Promise.all(pending.splice(0));
  } finally {
    stream.destroy();
  }
  if (open !== null) throw new ArchiveError(400, "Archivio troncato: una voce è incompleta.");
  if (entries === 0) throw new ArchiveError(400, "L'archivio è vuoto o non è uno zip valido.");
}

/** Nome da mostrare in un messaggio: senza caratteri di controllo e al massimo 80 caratteri. */
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 80);
}
