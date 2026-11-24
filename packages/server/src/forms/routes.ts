import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { PDFDocument } from "pdf-lib";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  FormTemplateSchema,
  FormTemplateResponseSchema,
  type FormField,
  SaveFormTemplateSchema,
  type FormTemplateResponse,
} from "@lanterna/shared";
import { requireRole, requireSession } from "../auth/session.js";
import type { AppConfig } from "../config.js";
import { formTemplate } from "../db/schema.js";
import { campaignExists } from "../campaigns/store.js";
import { isMember } from "../sheets/store.js";

/** Un modulo non oltre 20 pagine (il tipo `pages` del template lo dice comunque). */
export const MAX_FORM_PAGES = 20;
const PDF_MAGIC = Buffer.from("%PDF-");

function fail(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

/**
 * Modulo sopra il PDF del GM, sotto `/campaigns/:id/form`.
 *
 * - Il PDF lo carica solo il GM (admin): il file resta in `UPLOAD_DIR/forms`, con nome UUID, mai nel
 *   repo e mai in una cartella pubblica. Il controllo è sui byte (`%PDF-`) e su `pdf-lib`: un PDF
 *   cifrato o non leggibile viene rifiutato.
 * - Il template (campi) lo salva solo il GM; le pagine le fissa il PDF caricato.
 * - Il PDF e il template li legge ogni membro della campagna (anche il giocatore, per la sua scheda).
 *   Chi non è membro riceve 404, come per le altre risorse della campagna.
 */
export async function formRoutes(app: FastifyInstance, config: AppConfig) {
  const formsDir = join(resolve(config.uploadDir), "forms");
  await mkdir(formsDir, { recursive: true });
  const onlyGm = requireRole("admin");

  const campaignParams = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" } },
  } as const;

  /** Admin (GM) o membro della campagna: chi può leggere il modulo. */
  async function canRead(campaignId: string, userId: string, role: "admin" | "player"): Promise<boolean> {
    if (role === "admin") return true;
    return isMember(app.database.db, campaignId, userId);
  }

  async function currentRow(campaignId: string) {
    return app.database.db.query.formTemplate.findFirst({ where: eq(formTemplate.campaignId, campaignId) });
  }

  app.get<{ Params: { id: string } }>(
    "/campaigns/:id/form",
    { onRequest: requireSession, schema: { params: campaignParams } },
    async (request, reply) => {
      const campaignId = request.params.id;
      const user = request.session!.user;
      if (!(await campaignExists(app.database.db, campaignId))) return fail(reply, 404, "Non trovato");
      if (!(await canRead(campaignId, user.id, user.role))) return fail(reply, 404, "Non trovato");
      const row = await currentRow(campaignId);
      if (!row) return reply.send(FormTemplateResponseSchema.parse({ template: null, hasPdf: false }));
      const parsed = FormTemplateSchema.safeParse({ version: 1, name: row.name, pages: row.pages, fields: JSON.parse(row.fields) });
      if (!parsed.success) return fail(reply, 500, "Modulo salvato non valido");
      const body: FormTemplateResponse = {
        template: { name: parsed.data.name, pages: parsed.data.pages, fields: parsed.data.fields },
        hasPdf: true,
      };
      return reply.send(FormTemplateResponseSchema.parse(body));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/campaigns/:id/form/pdf",
    { onRequest: requireSession, schema: { params: campaignParams } },
    async (request, reply) => {
      const campaignId = request.params.id;
      const user = request.session!.user;
      if (!(await canRead(campaignId, user.id, user.role))) return fail(reply, 404, "Non trovato");
      const row = await currentRow(campaignId);
      if (!row) return fail(reply, 404, "Non trovato");
      const path = resolve(formsDir, row.pdfFile);
      if (!path.startsWith(formsDir + sep)) return fail(reply, 404, "Non trovato");
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
        .header("Content-Type", "application/pdf")
        .header("Cache-Control", "private, no-cache")
        .header("X-Content-Type-Options", "nosniff")
        .send(stream);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/campaigns/:id/form/pdf",
    { onRequest: onlyGm, schema: { params: campaignParams }, config: { rateLimit: { max: 20, timeWindow: 60_000 } } },
    async (request, reply) => {
      const campaignId = request.params.id;
      if (!(await campaignExists(app.database.db, campaignId))) return fail(reply, 404, "Non trovato");
      let buffer: Buffer;
      let filename: string | undefined;
      try {
        const file = await request.file();
        if (!file) return fail(reply, 400, "Nessun file");
        filename = file.filename;
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
      if (buffer.length < PDF_MAGIC.length || !buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
        return fail(reply, 415, "Non è un PDF");
      }
      let pages: number;
      try {
        const doc = await PDFDocument.load(buffer, { updateMetadata: false });
        pages = doc.getPageCount();
      } catch {
        return fail(reply, 415, "PDF non leggibile (forse protetto da password)");
      }
      if (pages < 1 || pages > MAX_FORM_PAGES) return fail(reply, 413, `Il PDF deve avere da 1 a ${MAX_FORM_PAGES} pagine`);

      const pdfFile = `${randomUUID()}.pdf`;
      const tmp = join(formsDir, `.${pdfFile}.tmp`);
      await writeFile(tmp, buffer, { flag: "wx", mode: 0o600 });
      await rename(tmp, join(formsDir, pdfFile));

      const previous = await currentRow(campaignId);
      // I campi che stanno su pagine che il nuovo PDF non ha più vengono tolti.
      let kept: FormField[] = [];
      let dropped = 0;
      if (previous) {
        const old = JSON.parse(previous.fields) as FormField[];
        kept = old.filter((f) => f.page < pages);
        dropped = old.length - kept.length;
      }
      const name = (previous?.name ?? (filename ?? "").replace(/\.pdf$/i, "").trim()).slice(0, 120) || "Scheda del GM";
      const now = new Date();
      await app.database.db
        .insert(formTemplate)
        .values({ campaignId, name, pages, fields: JSON.stringify(kept), pdfFile, pdfBytes: buffer.length, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: formTemplate.campaignId,
          set: { name, pages, fields: JSON.stringify(kept), pdfFile, pdfBytes: buffer.length, updatedAt: now },
        });
      if (previous) await rm(join(formsDir, previous.pdfFile), { force: true });

      return reply.code(201).send({ template: { name, pages, fields: kept }, hasPdf: true, droppedFields: dropped });
    },
  );

  app.put<{ Params: { id: string } }>(
    "/campaigns/:id/form",
    { onRequest: onlyGm, schema: { params: campaignParams }, config: { rateLimit: { max: 120, timeWindow: 60_000 } } },
    async (request, reply) => {
      const campaignId = request.params.id;
      const row = await currentRow(campaignId);
      if (!row) return fail(reply, 409, "Carica prima il PDF del modulo");
      const parsed = SaveFormTemplateSchema.safeParse(request.body);
      if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message ?? "Dati non validi");
      const checked = FormTemplateSchema.safeParse({ version: 1, name: parsed.data.name, pages: row.pages, fields: parsed.data.fields });
      if (!checked.success) return fail(reply, 400, checked.error.issues[0]?.message ?? "Modulo non valido");
      await app.database.db
        .update(formTemplate)
        .set({ name: checked.data.name, fields: JSON.stringify(checked.data.fields), updatedAt: new Date() })
        .where(eq(formTemplate.campaignId, campaignId));
      return reply.send({ template: { name: checked.data.name, pages: row.pages, fields: checked.data.fields }, hasPdf: true });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/campaigns/:id/form",
    { onRequest: onlyGm, schema: { params: campaignParams } },
    async (request, reply) => {
      const campaignId = request.params.id;
      const row = await currentRow(campaignId);
      if (!row) return fail(reply, 404, "Non trovato");
      await app.database.db.delete(formTemplate).where(eq(formTemplate.campaignId, campaignId));
      await rm(join(formsDir, row.pdfFile), { force: true });
      return reply.code(204).send();
    },
  );
}

