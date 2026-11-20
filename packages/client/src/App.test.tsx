import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@lanterna/shared";
import { App, resolveScreen } from "./App";
import { SessionProvider } from "./session/SessionProvider";
import { ToastProvider } from "./ui";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (call: Call) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

const calls: Call[] = [];
let handlers: Record<string, Handler> = {};

function mockFetch(h: Record<string, Handler>) {
  handlers = h;
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^\/api/, "");
      const method = init?.method ?? "GET";
      const call: Call = { method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const handler = handlers[`${method} ${path}`];
      if (!handler) return new Response(JSON.stringify({ error: `non gestito: ${method} ${path}` }), { status: 404 });
      const { status = 200, body } = await handler(call);
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    })
  );
}

const admin = { id: "u1", name: "Marta", email: "marta@example.org", role: "admin" as const };
const player = { id: "u2", name: "Luca", email: "luca@example.org", role: "player" as const };
const session = (user: typeof admin | typeof player) => () => ({ body: { user, session: { id: "s" } } });

function user(over: Partial<PublicUser> & { id: string }): PublicUser {
  return { name: "Nome", email: `${over.id}@example.org`, role: "player", createdAt: "2026-01-01T00:00:00.000Z", ...over };
}

function renderApp() {
  return render(
    <ToastProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ToastProvider>
  );
}

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("resolveScreen", () => {
  it("la route admin esiste solo per l'admin", () => {
    expect(resolveScreen("/admin/users", "authenticated", "admin")).toBe("admin-users");
    expect(resolveScreen("/admin/users", "authenticated", "player")).toBe("redirect-home");
    expect(resolveScreen("/admin/users", "anonymous", undefined)).toBe("login");
    expect(resolveScreen("/qualcosa", "authenticated", "player")).toBe("redirect-home");
    expect(resolveScreen("/", "loading", undefined)).toBe("loading");
  });
});

describe("login", () => {
  it("senza sessione mostra il login, senza registrazione", async () => {
    mockFetch({ "GET /auth/get-session": () => ({ body: null }) });
    renderApp();
    expect(await screen.findByRole("heading", { name: "Lanterna" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accedi" })).toBeTruthy();
    expect(screen.queryByText(/registr/i)).toBeNull();
  });

  it("accede con Invio e mostra il tavolo", async () => {
    const u = userEvent.setup();
    let logged = false;
    mockFetch({
      "GET /auth/get-session": () => (logged ? session(player)() : { body: null }),
      "POST /auth/sign-in/email": () => {
        logged = true;
        return { body: { user: player } };
      }
    });
    renderApp();
    await u.type(await screen.findByLabelText("Email"), "luca@example.org");
    await u.type(screen.getByLabelText("Password"), "password-lunga-123{Enter}");
    expect(await screen.findByRole("main", { name: "Mappa" })).toBeTruthy();
    const signIn = calls.find((c) => c.path === "/auth/sign-in/email");
    expect(signIn?.body).toEqual({ email: "luca@example.org", password: "password-lunga-123" });
  });

  it("credenziali errate: messaggio generico e nessun accesso", async () => {
    const u = userEvent.setup();
    mockFetch({
      "GET /auth/get-session": () => ({ body: null }),
      "POST /auth/sign-in/email": () => ({ status: 401, body: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" } })
    });
    renderApp();
    await u.type(await screen.findByLabelText("Email"), "chi@example.org");
    await u.type(screen.getByLabelText("Password"), "sbagliata{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Email o password non corretti.");
    expect(screen.queryByRole("main", { name: "Mappa" })).toBeNull();
    // il pulsante torna utilizzabile
    expect((screen.getByRole("button", { name: "Accedi" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("campi vuoti: errori inline e nessuna richiesta di login", async () => {
    const u = userEvent.setup();
    mockFetch({ "GET /auth/get-session": () => ({ body: null }) });
    renderApp();
    await u.click(await screen.findByRole("button", { name: "Accedi" }));
    expect(await screen.findByText("Inserisci la tua email.")).toBeTruthy();
    expect(calls.some((c) => c.path === "/auth/sign-in/email")).toBe(false);
  });

  it("server non raggiungibile: errore chiaro", async () => {
    const u = userEvent.setup();
    mockFetch({ "GET /auth/get-session": () => ({ body: null }) });
    renderApp();
    await u.type(await screen.findByLabelText("Email"), "a@b.it");
    await u.type(screen.getByLabelText("Password"), "x");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await u.click(screen.getByRole("button", { name: "Accedi" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Impossibile raggiungere il server");
  });
});

describe("sessione e logout", () => {
  it("con sessione attiva apre il tavolo e il logout torna al login", async () => {
    const u = userEvent.setup();
    mockFetch({
      "GET /auth/get-session": session(player),
      "POST /auth/sign-out": () => ({ body: { success: true } })
    });
    renderApp();
    expect(await screen.findByRole("main", { name: "Mappa" })).toBeTruthy();
    expect(screen.getByText("Campagna senza titolo")).toBeTruthy();
    await u.click(screen.getByRole("button", { name: /Menu utente, Luca/ }));
    await u.click(await screen.findByRole("menuitem", { name: "Esci" }));
    expect(await screen.findByRole("button", { name: "Accedi" })).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/auth/sign-out")).toBe(true);
  });

  it("cambio password: valida i requisiti e invia la richiesta", async () => {
    const u = userEvent.setup();
    mockFetch({
      "GET /auth/get-session": session(player),
      "POST /auth/change-password": () => ({ body: { status: true } })
    });
    renderApp();
    await u.click(await screen.findByRole("button", { name: /Menu utente/ }));
    await u.click(await screen.findByRole("menuitem", { name: "Cambia password" }));
    const dialog = await screen.findByRole("dialog", { name: "Cambia password" });
    await u.type(within(dialog).getByLabelText("Password attuale"), "vecchia-password-1");
    await u.type(within(dialog).getByLabelText("Nuova password"), "corta");
    await u.type(within(dialog).getByLabelText("Ripeti la nuova password"), "corta");
    await u.click(within(dialog).getByRole("button", { name: "Aggiorna password" }));
    expect(await within(dialog).findByText(/almeno 12 caratteri/)).toBeTruthy();
    expect(calls.some((c) => c.path === "/auth/change-password")).toBe(false);

    await u.clear(within(dialog).getByLabelText("Nuova password"));
    await u.clear(within(dialog).getByLabelText("Ripeti la nuova password"));
    await u.type(within(dialog).getByLabelText("Nuova password"), "nuova-password-123");
    await u.type(within(dialog).getByLabelText("Ripeti la nuova password"), "nuova-password-123");
    await u.click(within(dialog).getByRole("button", { name: "Aggiorna password" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/auth/change-password")?.body).toEqual({
        currentPassword: "vecchia-password-1",
        newPassword: "nuova-password-123"
      })
    );
  });
});

describe("route admin (solo UX, la sicurezza vera e' sul server)", () => {
  it("il giocatore non vede la voce di menu e la route admin lo riporta al tavolo senza chiamare l'API", async () => {
    const u = userEvent.setup();
    mockFetch({ "GET /auth/get-session": session(player) });
    window.location.hash = "#/admin/users";
    renderApp();
    expect(await screen.findByRole("main", { name: "Mappa" })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(screen.queryByRole("heading", { name: "Utenti" })).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/admin"))).toBe(false);
    await u.click(screen.getByRole("button", { name: /Menu utente/ }));
    await screen.findByRole("menuitem", { name: "Esci" });
    expect(screen.queryByRole("menuitem", { name: "Gestione utenti" })).toBeNull();
  });

  it("l'admin raggiunge la gestione utenti dal menu", async () => {
    const u = userEvent.setup();
    mockFetch({
      "GET /auth/get-session": session(admin),
      "GET /admin/users": () => ({ body: { users: [user({ id: "u1", name: "Marta", role: "admin" }), user({ id: "u2", name: "Luca" })] } })
    });
    renderApp();
    await u.click(await screen.findByRole("button", { name: /Menu utente/ }));
    await u.click(await screen.findByRole("menuitem", { name: "Gestione utenti" }));
    expect(await screen.findByText("Marta (tu)")).toBeTruthy();
    expect(screen.getByText("Luca")).toBeTruthy();
  });

  it("senza sessione la route admin mostra solo il login", async () => {
    mockFetch({ "GET /auth/get-session": () => ({ body: null }) });
    window.location.hash = "#/admin/users";
    renderApp();
    expect(await screen.findByRole("button", { name: "Accedi" })).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith("/admin"))).toBe(false);
  });
});

describe("gestione utenti", () => {
  function setup(extra: Record<string, Handler> = {}) {
    const users = [user({ id: "u1", name: "Marta", role: "admin" }), user({ id: "u2", name: "Luca" })];
    mockFetch({
      "GET /auth/get-session": session(admin),
      "GET /admin/users": () => ({ body: { users } }),
      ...extra
    });
    window.location.hash = "#/admin/users";
    renderApp();
  }

  it("crea un utente: valida la password e invia il corpo corretto", async () => {
    const u = userEvent.setup();
    setup({
      "POST /admin/users": (c) => ({ status: 201, body: user({ id: "u3", ...(c.body as object) }) })
    });
    await u.click(await screen.findByRole("button", { name: "Nuovo utente" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuovo utente" });
    await u.type(within(dialog).getByLabelText("Nome"), "Giulia");
    await u.type(within(dialog).getByLabelText("Email"), "giulia@example.org");
    await u.type(within(dialog).getByLabelText("Password"), "corta");
    await u.click(within(dialog).getByRole("button", { name: "Crea utente" }));
    expect(await within(dialog).findByText(/almeno 12 caratteri/)).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.path === "/admin/users")).toBe(false);

    await u.clear(within(dialog).getByLabelText("Password"));
    await u.type(within(dialog).getByLabelText("Password"), "una-password-lunga");
    await u.click(within(dialog).getByRole("radio", { name: "Admin" }));
    await u.click(within(dialog).getByRole("button", { name: "Crea utente" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.path === "/admin/users")?.body).toEqual({
        name: "Giulia",
        email: "giulia@example.org",
        password: "una-password-lunga",
        role: "admin"
      })
    );
    expect(await screen.findByText("Giulia")).toBeTruthy();
  });

  it("email gia' in uso: mostra l'errore del server nel form", async () => {
    const u = userEvent.setup();
    setup({ "POST /admin/users": () => ({ status: 409, body: { error: "Email già in uso." } }) });
    await u.click(await screen.findByRole("button", { name: "Nuovo utente" }));
    const dialog = await screen.findByRole("dialog", { name: "Nuovo utente" });
    await u.type(within(dialog).getByLabelText("Nome"), "Luca");
    await u.type(within(dialog).getByLabelText("Email"), "luca@example.org");
    await u.type(within(dialog).getByLabelText("Password"), "una-password-lunga{Enter}");
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Email già in uso.");
  });

  it("elimina solo dopo la conferma; Annulla non fa nulla", async () => {
    const u = userEvent.setup();
    setup({ "DELETE /admin/users/u2": () => ({ status: 204 }) });
    await u.click(await screen.findByRole("button", { name: "Azioni per Luca" }));
    await u.click(await screen.findByRole("menuitem", { name: "Elimina" }));
    let alert = await screen.findByRole("alertdialog", { name: "Eliminare Luca?" });
    await u.click(within(alert).getByRole("button", { name: "Annulla" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await u.click(screen.getByRole("button", { name: "Azioni per Luca" }));
    await u.click(await screen.findByRole("menuitem", { name: "Elimina" }));
    alert = await screen.findByRole("alertdialog", { name: "Eliminare Luca?" });
    await u.click(within(alert).getByRole("button", { name: "Elimina" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/admin/users/u2")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Luca")).toBeNull());
  });

  it("ultimo admin: errore chiaro e l'utente resta nell'elenco", async () => {
    const u = userEvent.setup();
    setup({ "PATCH /admin/users/u1": () => ({ status: 409, body: { error: "Deve restare almeno un admin." } }) });
    await u.click(await screen.findByRole("button", { name: "Azioni per Marta" }));
    await u.click(await screen.findByRole("menuitem", { name: "Rendi giocatore" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Deve restare almeno un admin");
    expect(screen.getByText("Marta (tu)")).toBeTruthy();
  });

  it("non permette di eliminare se stessi", async () => {
    const u = userEvent.setup();
    setup();
    await u.click(await screen.findByRole("button", { name: "Azioni per Marta" }));
    const item = await screen.findByRole("menuitem", { name: "Elimina" });
    expect(item.hasAttribute("disabled") || item.getAttribute("aria-disabled") === "true").toBe(true);
  });

  it("errore di caricamento: messaggio e Riprova", async () => {
    const u = userEvent.setup();
    let fail = true;
    mockFetch({
      "GET /auth/get-session": session(admin),
      "GET /admin/users": () => (fail ? { status: 500, body: { error: "boom" } } : { body: { users: [user({ id: "u1", name: "Marta", role: "admin" })] } })
    });
    window.location.hash = "#/admin/users";
    renderApp();
    expect(await screen.findByText("Non riesco a caricare gli utenti")).toBeTruthy();
    fail = false;
    await u.click(screen.getByRole("button", { name: "Riprova" }));
    expect(await screen.findByText("Marta (tu)")).toBeTruthy();
  });
});
