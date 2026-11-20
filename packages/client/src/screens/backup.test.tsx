import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportPreview, ImportResult } from "@lanterna/shared";
import { ToastProvider } from "../ui";
import { BackupScreen } from "./BackupScreen";
import { NO_USER, buildOptions, suggestMapping, summaryRows, takenUsers } from "./backupLogic";
import { archiveErrorMessage, exportUrl } from "../api/archive";
import { ApiRequestError } from "../api/client";

/** XMLHttpRequest finto: tiene le richieste e permette di rispondere a mano. */
class FakeXHR {
  static all: FakeXHR[] = [];
  method = "";
  url = "";
  body: FormData | null = null;
  withCredentials = false;
  responseType = "";
  responseText = "";
  status = 0;
  upload: { onprogress: ((e: unknown) => void) | null; onload: (() => void) | null } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXHR.all.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, json: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(json);
    this.upload.onload?.();
    this.onload?.();
  }
}

const preview: ImportPreview = {
  campaignName: "Le miniere",
  exportedAt: "2026-03-04T10:00:00.000Z",
  appVersion: "0.0.0",
  formatVersion: 1,
  includesChat: true,
  counts: { members: 3, scenes: 2, tokens: 5, walls: 0, fogs: 1, combats: 0, groups: 0, sheets: 2, content: 0, library: 1, chat: 40, assets: 3 },
  members: [
    { ref: "m1", name: "Marta", role: "admin" },
    { ref: "m2", name: "Luca", role: "player" },
    { ref: "m3", name: "Sara", role: "player" }
  ],
  unpackedBytes: 3_500_000,
  warnings: ["Immagine mancante sul disco: non esportata."]
};

const users = [
  { id: "u-gm", name: "Marta", email: "m@example.org", role: "admin" },
  { id: "u-luca", name: "Luca", email: "l@example.org", role: "player" },
  { id: "u-sara", name: "Sara", email: "s@example.org", role: "player" },
  { id: "u-gigi", name: "Gigi", email: "g@example.org", role: "player" }
];

beforeEach(() => {
  FakeXHR.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/campaigns")) return new Response(JSON.stringify({ campaigns: [{ id: "c1", name: "Le miniere", createdAt: "2026-01-01T00:00:00Z" }, { id: "c2", name: "Altra", createdAt: "2026-02-01T00:00:00Z" }] }), { status: 200 });
      if (String(url).endsWith("/admin/users")) return new Response(JSON.stringify({ users }), { status: 200 });
      return new Response("{}", { status: 404 });
    })
  );
  window.location.hash = "#/admin/backup";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = () =>
  render(
    <ToastProvider>
      <BackupScreen />
    </ToastProvider>
  );
const zipFile = () => new File([new Uint8Array([80, 75, 3, 4])], "miniere.zip", { type: "application/zip" });

describe("schermata Backup e importazione", () => {
  it("esporta: scelta della campagna, chat facoltativa, download dall'URL dell'API", async () => {
    const u = userEvent.setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute("href") ?? "");
    });
    const clicked: string[] = [];
    mount();
    await u.click(await screen.findByText("Altra"));
    await u.click(screen.getByRole("button", { name: "Scarica archivio (.zip)" }));
    await u.click(screen.getByRole("switch", { name: /Includi chat/ }));
    await u.click(screen.getByRole("button", { name: "Scarica archivio (.zip)" }));
    expect(clicked).toEqual(["/api/campaigns/c2/export", "/api/campaigns/c2/export?chat=true"]);
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("importa: anteprima, associazione dei giocatori, avanzamento, risultato e apertura della nuova campagna", async () => {
    const u = userEvent.setup();
    mount();
    await screen.findByText("Altra");
    await u.upload(screen.getByLabelText("Archivio da importare (.zip)"), zipFile());

    // 1) Anteprima: stesso endpoint, ?preview=true, nessun options.
    const first = FakeXHR.all[0]!;
    expect(first.method).toBe("POST");
    expect(first.url).toBe("/api/campaigns/import?preview=true");
    expect(first.withCredentials).toBe(true);
    expect(first.body!.get("options")).toBeNull();
    expect((first.body!.get("file") as File).name).toBe("miniere.zip");
    first.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    expect(await screen.findByRole("progressbar", { name: "Controllo dell'archivio" })).toBeTruthy();
    act(() => first.respond(200, preview));

    // 2) Contenuto mostrato prima di confermare.
    expect(await screen.findByText("Contenuto di miniere.zip")).toBeTruthy();
    const list = within(screen.getByRole("list", { name: "Contenuto di miniere.zip" }));
    expect(list.getByText("Scene").closest("li")?.textContent).toMatch(/Scene\s*2$/);
    expect(screen.getByText(/Voci di chat e tiri/)).toBeTruthy();
    expect(screen.getByText("Avvisi dell'esportazione")).toBeTruthy();
    expect(screen.getByText(/Immagine mancante sul disco/)).toBeTruthy();
    expect(screen.getByText(/3\.3 MB una volta aperto/)).toBeTruthy();

    // 3) Mappatura: Luca e Sara si associano da soli (stesso nome); Gigi non e' proposto due volte.
    expect(screen.getByRole("button", { name: /Utente per Luca/ }).textContent).toContain("Luca");
    expect(screen.getByRole("button", { name: /Utente per Sara/ }).textContent).toContain("Sara");
    await u.clear(screen.getByLabelText("Nome della nuova campagna"));
    await u.type(screen.getByLabelText("Nome della nuova campagna"), "Le miniere (copia)");
    await u.click(screen.getByRole("button", { name: /Utente per Sara/ }));
    await u.click(await screen.findByRole("menuitemradio", { name: "Non associare" }));

    // 4) Conferma: options con la mappatura scelta, poi avanzamento.
    await u.click(screen.getByRole("button", { name: "Importa campagna" }));
    const second = FakeXHR.all[1]!;
    expect(second.url).toBe("/api/campaigns/import");
    expect(JSON.parse(String(second.body!.get("options")))).toEqual({ name: "Le miniere (copia)", memberMap: { m2: "u-luca", m3: null }, includeChat: true });
    second.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
    expect((await screen.findByRole("progressbar", { name: "Importazione" })).getAttribute("aria-valuenow")).toBe("25");
    const result: ImportResult = {
      campaign: { id: "nuova-1", name: "Le miniere (copia)", createdAt: "2026-11-20T10:00:00Z" },
      counts: preview.counts,
      warnings: ["Il giocatore \"Sara\" non è associato a nessun utente: token, scheda e nebbia personale restano senza proprietario."]
    };
    act(() => second.respond(201, result));
    expect(await screen.findByText("Campagna importata")).toBeTruthy();
    expect(screen.getByText(/non è associato/)).toBeTruthy();
    await u.click(screen.getByRole("button", { name: "Apri la campagna" }));
    expect(window.location.hash).toBe("#/?campaign=nuova-1");
  });

  it("errori chiari: archivio rifiutato dal server (messaggio e dettagli), poi si puo' riprovare", async () => {
    const u = userEvent.setup();
    mount();
    await screen.findByText("Altra");
    await u.upload(screen.getByLabelText("Archivio da importare (.zip)"), zipFile());
    act(() => FakeXHR.all[0]!.respond(400, { error: "Il documento scenes.json non è valido.", details: ["scenes.json: 0.width: troppo grande"] }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Importazione non riuscita");
    expect(alert.textContent).toContain("Il documento scenes.json non è valido.");
    expect(alert.textContent).toContain("scenes.json: 0.width: troppo grande");
    // Di nuovo possibile scegliere un file.
    expect(screen.getByRole("button", { name: /Scegli un archivio/ })).toBeTruthy();
  });

  it("se l'importazione fallisce l'anteprima resta, cosi' si corregge la mappatura senza ricaricare il file", async () => {
    const u = userEvent.setup();
    mount();
    await screen.findByText("Altra");
    await u.upload(screen.getByLabelText("Archivio da importare (.zip)"), zipFile());
    act(() => FakeXHR.all[0]!.respond(200, preview));
    await u.click(await screen.findByRole("button", { name: "Importa campagna" }));
    act(() => FakeXHR.all[1]!.respond(500, { error: "Internal" }));
    expect((await screen.findByRole("alert")).textContent).toContain("non ha creato nulla");
    expect(screen.getByRole("button", { name: "Importa campagna" })).toBeTruthy();
    expect(FakeXHR.all).toHaveLength(2);
  });

  it("errore di rete durante l'importazione", async () => {
    const u = userEvent.setup();
    mount();
    await screen.findByText("Altra");
    await u.upload(screen.getByLabelText("Archivio da importare (.zip)"), zipFile());
    act(() => FakeXHR.all[0]!.onerror?.());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Impossibile raggiungere il server"));
  });
});

describe("logica del backup", () => {
  it("summaryRows nasconde le voci a zero e la chat se non inclusa", () => {
    const rows = summaryRows(preview.counts, false).map((r) => r.label);
    expect(rows).toContain("Scene");
    expect(rows).not.toContain("Muri e porte");
    expect(rows).not.toContain("Voci di chat e tiri");
    expect(summaryRows(preview.counts, true).map((r) => r.label)).toContain("Voci di chat e tiri");
  });

  it("suggestMapping: associa solo nomi unici e non usa due volte lo stesso utente", () => {
    const members = [
      { ref: "m2", name: "Luca", role: "player" as const },
      { ref: "m3", name: "luca", role: "player" as const },
      { ref: "m4", name: "Zeno", role: "player" as const },
      { ref: "m1", name: "Marta", role: "admin" as const }
    ];
    expect(suggestMapping(members, [{ id: "u1", name: "Luca" }, { id: "u2", name: "Zeno" }, { id: "u3", name: "Zeno" }])).toEqual({ m2: "u1" });
  });

  it("buildOptions: solo i giocatori, nome solo se cambiato, chat come scelta", () => {
    const members = preview.members;
    expect(buildOptions({ name: "Le miniere", archiveName: "Le miniere", includeChat: false, members, mapping: { m2: "u-luca", m3: NO_USER } })).toEqual({ memberMap: { m2: "u-luca", m3: null }, includeChat: false });
    expect(buildOptions({ name: " Nuovo ", archiveName: "Le miniere", includeChat: true, members, mapping: {} })).toEqual({ name: "Nuovo", memberMap: { m2: null, m3: null }, includeChat: true });
  });

  it("takenUsers esclude se stessi", () => {
    expect([...takenUsers({ m2: "a", m3: "b", m4: NO_USER }, "m2")]).toEqual(["b"]);
  });

  it("exportUrl e messaggi d'errore", () => {
    expect(exportUrl("a b", true)).toBe("/api/campaigns/a%20b/export?chat=true");
    expect(archiveErrorMessage(new ApiRequestError(403, "x"))).toMatch(/Solo il GM/);
    expect(archiveErrorMessage(new ApiRequestError(413, "L'archivio supera 512 MiB."))).toBe("L'archivio supera 512 MiB.");
    expect(archiveErrorMessage(new ApiRequestError(429, "Un'importazione è già in corso: attendi che finisca."))).toMatch(/in corso/);
    expect(archiveErrorMessage(new Error("boh"))).toMatch(/Riprova/);
  });
});
