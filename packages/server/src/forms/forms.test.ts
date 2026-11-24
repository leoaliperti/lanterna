import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createCampaignAs, createTable, type Table } from "../test/campaign.js";
import { ORIGIN, createTestApp, loginAs, type TestContext } from "../test/helpers.js";
import { multipart } from "../test/images.js";

let ctx: TestContext;
let t: Table;
beforeEach(async () => {
  ctx = await createTestApp();
  t = await createTable(ctx);
});
afterEach(async () => {
  await ctx.close();
});

async function pdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([594, 783]);
  return Buffer.from(await doc.save());
}

const field = (id: string, source: string, page = 0) => ({ id, page, x: 0.1, y: 0.1, w: 0.3, h: 0.04, source });

async function upload(cookie: string, file: Buffer, filename = "scheda del GM.pdf", contentType = "application/pdf", campaignId = t.campaignId) {
  const body = multipart(file, filename, contentType);
  return ctx.app.inject({
    method: "POST",
    url: `/campaigns/${campaignId}/form/pdf`,
    headers: { origin: ORIGIN, cookie, ...body.headers },
    payload: body.payload,
  });
}

function call(cookie: string | undefined, method: "GET" | "PUT" | "DELETE", url: string, payload?: unknown, campaignId = t.campaignId) {
  return ctx.app.inject({
    method,
    url: `/campaigns/${campaignId}/form${url}`,
    headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

describe("modulo sopra il PDF del GM: permessi", () => {
  it("anonimo: 401 su ogni rotta", async () => {
    expect((await call(undefined, "GET", "")).statusCode).toBe(401);
    expect((await call(undefined, "GET", "/pdf")).statusCode).toBe(401);
    expect((await call(undefined, "PUT", "", { name: "x", fields: [] })).statusCode).toBe(401);
    expect((await call(undefined, "DELETE", "")).statusCode).toBe(401);
  });

  it("solo il GM carica, modifica ed elimina il PDF", async () => {
    expect((await upload(t.p1.cookie, await pdf(1))).statusCode).toBe(403);
    expect((await call(t.p1.cookie, "PUT", "", { name: "x", fields: [] })).statusCode).toBe(403);
    expect((await call(t.p1.cookie, "DELETE", "")).statusCode).toBe(403);
    expect((await upload(t.gm.cookie, await pdf(1))).statusCode).toBe(201);
    expect((await call(t.p1.cookie, "DELETE", "")).statusCode).toBe(403);
  });

  it("un estraneo alla campagna non vede nemmeno che il modulo esiste", async () => {
    await upload(t.gm.cookie, await pdf(1));
    const outsider = await loginAs(ctx.app, "player");
    expect((await call(outsider.cookie, "GET", "")).statusCode).toBe(404);
    expect((await call(outsider.cookie, "GET", "/pdf")).statusCode).toBe(404);
  });
});

describe("caricamento del PDF", () => {
  it("rifiuta un file che non è un PDF, anche se dichiarato tale", async () => {
    const res = await upload(t.gm.cookie, Buffer.from("questo non e' un pdf"));
    expect(res.statusCode).toBe(415);
  });

  it("accetta un PDF di più pagine e ne ricava il numero", async () => {
    const res = await upload(t.gm.cookie, await pdf(3));
    expect(res.statusCode).toBe(201);
    expect(res.json().template.pages).toBe(3);
  });

  it("il PDF è scaricabile solo dai membri, con il tipo corretto", async () => {
    await upload(t.gm.cookie, await pdf(2));
    const res = await call(t.p1.cookie, "GET", "/pdf");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("ricaricando un PDF più corto i campi sulle pagine mancanti si tolgono", async () => {
    await upload(t.gm.cookie, await pdf(3));
    await call(t.gm.cookie, "PUT", "", { name: "Scheda", fields: [field("a", "name", 0), field("b", "str.score", 2)] });
    const again = await upload(t.gm.cookie, await pdf(2));
    expect(again.statusCode).toBe(201);
    expect(again.json().droppedFields).toBe(1);
    const read = await call(t.gm.cookie, "GET", "");
    expect(read.json().template.fields.map((f: { id: string }) => f.id)).toEqual(["a"]);
  });
});

describe("template dei campi", () => {
  it("senza PDF caricato il GM non può salvare campi (409)", async () => {
    const other = await createCampaignAs(ctx, t.gm.cookie, "Altra");
    expect((await call(t.gm.cookie, "PUT", "", { name: "x", fields: [] }, other)).statusCode).toBe(409);
  });

  it("salva campi validi; sorgenti sconosciute e campi fuori pagina sono rifiutati", async () => {
    await upload(t.gm.cookie, await pdf(2));
    expect((await call(t.gm.cookie, "PUT", "", { name: "Scheda", fields: [field("a", "name")] })).statusCode).toBe(200);
    expect((await call(t.gm.cookie, "PUT", "", { name: "Scheda", fields: [field("a", "inventato")] })).statusCode).toBe(400);
    expect((await call(t.gm.cookie, "PUT", "", { name: "Scheda", fields: [field("a", "name", 5)] })).statusCode).toBe(400);
  });

  it("il giocatore legge il modulo ma non lo modifica", async () => {
    await upload(t.gm.cookie, await pdf(1));
    const read = await call(t.p1.cookie, "GET", "");
    expect(read.statusCode).toBe(200);
    expect(read.json().hasPdf).toBe(true);
  });

  it("il GM elimina il modulo; poi non resta né PDF né campi", async () => {
    await upload(t.gm.cookie, await pdf(1));
    expect((await call(t.gm.cookie, "DELETE", "")).statusCode).toBe(204);
    expect((await call(t.gm.cookie, "GET", "")).json()).toEqual({ template: null, hasPdf: false });
    expect((await call(t.gm.cookie, "GET", "/pdf")).statusCode).toBe(404);
  });
});
