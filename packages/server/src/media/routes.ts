import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { IdSchema, type UploadKind, type UploadResponse } from "@lanterna/shared";
import { requireRole, requireSession } from "../auth/session.js";
import type { AppConfig } from "../config.js";
import { asset } from "../db/schema.js";
import { sniffImage } from "./image.js";
import type { Hub } from "../realtime/hub.js";
import type { TileService } from "./tiles.js";

/** Nome pubblico di un file: `<uuid>.<estensione>`. Qualsiasi altra forma => 404. */
const ASSET_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|webp)$/;

export const ASSETS_PATH = "/assets";

function fail(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

/**
 * Caricamento di mappe e immagini dei token (solo admin) e servizio dei file (utenti autenticati).
 * - tipo reale dai magic bytes (PNG/JPEG/WebP), mai da estensione o Content-Type; niente SVG;
 * - dimensioni in pixel lette dall'intestazione, con limiti per lato e per area;
 * - nomi generati (UUID), file salvati in `UPLOAD_DIR` fuori dalla webroot;
 * - nessuna miniatura: servirebbe una libreria di decodifica (sharp ha binari nativi e script
 *   di installazione, bloccati da npm 11); vedi docs/PROTOCOL.md.
 */
export async function uploadRoutes(app: FastifyInstance, config: AppConfig, hub: Hub, tiles: TileService) {
  const { uploadDir, upload } = config;
  await mkdir(uploadDir, { recursive: true });
  const root = resolve(uploadDir);

  await app.register(multipart, {
    limits: { fileSize: upload.maxBytes, files: 1, fields: 0, parts: 1, fieldNameSize: 32, headerPairs: 20 },
  });

  const onlyAdmin = requireRole("admin");

  for (const kind of ["map", "token"] as const satisfies readonly UploadKind[]) {
    app.post(
      `/uploads/${kind}`,
      {
        onRequest: onlyAdmin,
        config: { rateLimit: { max: config.rateLimit.upload.max, timeWindow: config.rateLimit.upload.timeWindowMs } },
      },
      async (request, reply) => {
        let buffer: Buffer;
        try {
          const file = await request.file();
          if (!file) return fail(reply, 400, "Nessun file");
          buffer = await file.toBuffer();
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "FST_REQ_FILE_TOO_LARGE") return fail(reply, 413, "File troppo grande");
          if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE") return fail(reply, 415, "Serve multipart/form-data");
          if (code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT" || code === "FST_FIELDS_LIMIT") {
            return fail(reply, 400, "Un solo file per richiesta");
          }
          throw err;
        }
        const info = sniffImage(buffer);
        if (!info) return fail(reply, 415, "Formato non supportato: solo PNG, JPEG o WebP");
        if (info.width > upload.maxSide || info.height > upload.maxSide || info.width * info.height > upload.maxPixels) {
          return fail(reply, 413, "Immagine troppo grande in pixel");
        }

        const id = randomUUID();
        const name = `${id}.${info.ext}`;
        const tmp = join(root, `.${id}.tmp`);
        await writeFile(tmp, buffer, { flag: "wx", mode: 0o600 });
        try {
          await rename(tmp, join(root, name));
          await app.database.db.insert(asset).values({
            id,
            kind,
            mime: info.mime,
            ext: info.ext,
            width: info.width,
            height: info.height,
            bytes: buffer.length,
            uploadedBy: request.session?.user.id ?? null,
          });
        } catch (err) {
          await rm(tmp, { force: true });
          await rm(join(root, name), { force: true });
          throw err;
        }
        const body: UploadResponse = {
          assetId: id,
          url: `${ASSETS_PATH}/${name}`,
          kind,
          mime: info.mime,
          width: info.width,
          height: info.height,
          bytes: buffer.length,
        };
        return reply.code(201).send(body);
      },
    );
  }

  app.get<{ Params: { name: string } }>(
    `${ASSETS_PATH}/:name`,
    { onRequest: requireSession },
    async (request, reply) => {
      const match = ASSET_NAME.exec(request.params.name);
      if (!match) return fail(reply, 404, "Non trovato");
      const [, id, ext] = match;
      const row = await app.database.db.query.asset.findFirst({ where: eq(asset.id, id!) });
      if (!row || row.ext !== ext) return fail(reply, 404, "Non trovato");
      // Nebbia (M6): la mappa di una scena con nebbia non si serve intera ai giocatori.
      const user = request.session!.user;
      if (user.role !== "admin" && !hub.assetAllowed(user.id, row.id, `${ASSETS_PATH}/${row.id}.${row.ext}`)) {
        return fail(reply, 404, "Non trovato");
      }
      const path = resolve(root, `${row.id}.${row.ext}`);
      // Difesa in profondità contro il path traversal (il nome è già un UUID validato).
      if (!path.startsWith(root + sep)) return fail(reply, 404, "Non trovato");
      const stream = createReadStream(path);
      try {
        await new Promise<void>((ok, ko) => {
          stream.once("open", () => ok());
          stream.once("error", ko);
        });
      } catch {
        return fail(reply, 404, "Non trovato");
      }
      return reply
        .header("Content-Type", row.mime)
        .header("Content-Length", row.bytes)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", `inline; filename="${row.id}.${row.ext}"`)
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .send(stream);
    },
  );

  /**
   * Tessere della mappa di una scena (M6). Giocatore: solo scena attiva con nebbia e solo tessere
   * con almeno una cella rivelata a lui, con le celle coperte oscurate. GM: tutte, intere.
   * Ogni rifiuto (campagna o scena inesistente, non membro, tessera coperta o fuori mappa) dà lo
   * stesso 404: non si distingue una tessera coperta da una inesistente.
   */
  app.get<{ Params: { campaignId: string; sceneId: string; col: string; row: string } }>(
    "/campaigns/:campaignId/scenes/:sceneId/tiles/:col/:row",
    { onRequest: requireSession },
    async (request, reply) => {
      const { campaignId, sceneId, col, row } = request.params;
      const notFound = () => fail(reply, 404, "Non trovato");
      if (!IdSchema.safeParse(campaignId).success || !IdSchema.safeParse(sceneId).success) return notFound();
      if (!/^[0-9]{1,5}$/.test(col) || !/^[0-9]{1,5}$/.test(row)) return notFound();
      const ctx = hub.tileContext(request.session!.user.id, campaignId, sceneId);
      if (!ctx || !ctx.scene.map) return notFound();
      const assetRow = await app.database.db.query.asset.findFirst({ where: eq(asset.id, ctx.scene.map.assetId) });
      if (!assetRow) return notFound();
      let tile;
      try {
        tile = await tiles.render(assetRow, ctx.scene, ctx.fog, ctx.mask, Number(col), Number(row));
      } catch (err) {
        request.log.warn({ err }, "tessera della mappa non generata");
        return notFound();
      }
      if (!tile) return notFound();
      reply
        .header("ETag", tile.etag)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        // Sempre rivalidata: se la nebbia cambia, cambia l'ETag (o la tessera sparisce: 404).
        .header("Cache-Control", "private, no-cache");
      if (request.headers["if-none-match"] === tile.etag) return reply.code(304).send();
      return reply.header("Content-Type", tile.mime).header("Content-Length", tile.body.length).send(tile.body);
    },
  );
}
