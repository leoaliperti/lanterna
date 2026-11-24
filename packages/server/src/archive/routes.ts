import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { requireRole } from "../auth/session.js";
import type { AppConfig } from "../config.js";
import type { Hub } from "../realtime/hub.js";
import { planExport } from "./export.js";
import { commitImport, previewOf, stageArchive } from "./import.js";
import { ArchiveError } from "./zip-read.js";

const id = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" } as const;

/** Cartelle di parcheggio dell'importazione dentro `UPLOAD_DIR`: nome riconoscibile, mai servite da `/assets`. */
const STAGING_PREFIX = ".import-";

function fail(reply: FastifyReply, e: ArchiveError) {
  return reply.code(e.status).send({ error: e.message, ...(e.details.length > 0 ? { details: e.details } : {}) });
}

/**
 * Esportazione e importazione di campagne (M10), SOLO admin (`requireRole`, prima di leggere il corpo).
 *
 * - `GET /campaigns/:id/export[?chat=1]`: zip in streaming (vedi `export.ts` per il contenuto e per cosa
 *   non c'è mai: niente email, password, sessioni, segreti).
 * - `POST /campaigns/import[?preview=1]`: multipart con `file` (lo zip) e `options` (JSON: nome, mappatura
 *   dei membri, chat). Con `preview=1` valida e mostra il contenuto senza scrivere nulla. Senza, crea una
 *   NUOVA campagna in modo transazionale. Un'importazione alla volta (le altre ricevono 429).
 */
export async function archiveRoutes(app: FastifyInstance, config: AppConfig, hub: Hub) {
  const db = app.database.db;
  const onlyAdmin = requireRole("admin");
  const root = resolve(config.uploadDir);
  await mkdir(root, { recursive: true });
  // Avanzi di un'importazione interrotta da un arresto: all'avvio non ce ne sono di attive.
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (name.startsWith(STAGING_PREFIX)) await rm(join(root, name), { recursive: true, force: true });
  }
  const limit = { rateLimit: { max: Math.min(config.rateLimit.upload.max, 20), timeWindow: config.rateLimit.upload.timeWindowMs } };

  app.get<{ Params: { id: string }; Querystring: { chat?: boolean } }>(
    "/campaigns/:id/export",
    {
      onRequest: onlyAdmin,
      config: limit,
      schema: {
        params: { type: "object", required: ["id"], properties: { id } },
        querystring: { type: "object", additionalProperties: false, properties: { chat: { type: "boolean", default: false } } },
      },
    },
    async (request, reply) => {
      let plan;
      try {
        plan = await planExport(db, config, request.params.id, { includeChat: request.query.chat === true });
      } catch (err) {
        if (err instanceof ArchiveError) return fail(reply, err);
        throw err;
      }
      if (!plan) return reply.code(404).send({ error: "Campagna inesistente" });
      return reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${plan.filename}"`)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(plan.stream());
    },
  );

  let importing = false;

  app.post<{ Querystring: { preview?: boolean } }>(
    "/campaigns/import",
    {
      onRequest: onlyAdmin,
      config: limit,
      schema: { querystring: { type: "object", additionalProperties: false, properties: { preview: { type: "boolean", default: false } } } },
    },
    async (request, reply) => {
      if (!request.isMultipart()) return reply.code(415).send({ error: "Serve multipart/form-data" });
      if (importing) return reply.code(429).send({ error: "Un'importazione è già in corso: attendi che finisca." });
      importing = true;
      const staging = join(root, `${STAGING_PREFIX}${randomUUID()}`);
      let outcome: { status: number; body: unknown };
      try {
        await mkdir(staging, { mode: 0o700 });
        const zipPath = join(staging, "archive.zip");
        let gotFile = false;
        let optionsRaw = "";
        try {
          const parts = request.parts({
            limits: { fileSize: config.archive.maxBytes, files: 1, fields: 4, parts: 6, fieldSize: 64 * 1024, fieldNameSize: 32, headerPairs: 20 },
          });
          for await (const part of parts) {
            if (part.type === "file") {
              if (part.fieldname !== "file" || gotFile) throw new ArchiveError(400, "Serve un solo campo \"file\" con l'archivio.");
              gotFile = true;
              await pipeline(part.file, createWriteStream(zipPath, { flags: "wx", mode: 0o600 }));
              if (part.file.truncated) {
                throw new ArchiveError(413, `L'archivio supera ${Math.round(config.archive.maxBytes / 1048576)} MiB.`);
              }
            } else if (part.fieldname === "options") {
              if (part.valueTruncated) throw new ArchiveError(400, "Opzioni troppo lunghe.");
              optionsRaw = String(part.value);
            } else {
              throw new ArchiveError(400, "Campo non ammesso.");
            }
          }
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (err instanceof ArchiveError) throw err;
          if (code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT" || code === "FST_FIELDS_LIMIT") {
            throw new ArchiveError(400, "Richiesta non valida: un solo file e il campo options.");
          }
          if (code === "FST_REQ_FILE_TOO_LARGE") throw new ArchiveError(413, "Archivio troppo grande.");
          throw err;
        }
        if (!gotFile) throw new ArchiveError(400, "Nessun archivio caricato.");

        let rawOptions: unknown = {};
        if (optionsRaw.trim() !== "") {
          try {
            rawOptions = JSON.parse(optionsRaw);
          } catch {
            throw new ArchiveError(400, "Il campo options non è un JSON valido.");
          }
        }

        const staged = await stageArchive(zipPath, join(staging, "files"), config);
        const user = request.session!.user;
        const preview = request.query.preview === true;
        // L'anteprima passa dalle stesse verifiche dell'importazione (riferimenti, invarianti), senza scrivere.
        const result = await commitImport(
          { db, config, loadRoom: (cid) => hub.loadRoom(cid) },
          { id: user.id, name: user.name },
          staged,
          preview ? {} : rawOptions,
          preview,
        );
        outcome = preview ? { status: 200, body: previewOf(staged) } : { status: 201, body: result };
      } catch (err) {
        if (!(err instanceof ArchiveError)) {
          importing = false;
          await rm(staging, { recursive: true, force: true });
          throw err;
        }
        outcome = { status: err.status, body: { error: err.message, ...(err.details.length > 0 ? { details: err.details } : {}) } };
      }
      // La cartella di parcheggio sparisce PRIMA della risposta: chi riceve l'esito la trova già pulita.
      importing = false;
      await rm(staging, { recursive: true, force: true });
      return reply.code(outcome.status).send(outcome.body);
    },
  );
}
