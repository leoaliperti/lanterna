import type {
  AddMemberRequest,
  ApiError,
  CampaignSummary,
  CreateCampaignRequest,
  CreateUserRequest,
  ListCampaignsResponse,
  ListMembersResponse,
  ListUsersResponse,
  PublicUser,
  ResetPasswordRequest,
  UpdateUserRoleRequest,
  UploadKind,
  UploadResponse,
  UserRole
} from "@lanterna/shared";

/** Utente come lo restituisce `get-session` (i campi che il client usa). */
export type SessionUser = Pick<PublicUser, "id" | "name" | "email"> & { role: UserRole };

/** Errore di una chiamata API. `status` 0 = server non raggiungibile. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

const BASE = "/api";

let unauthorizedHandler: (() => void) | null = null;
/** Chiamato quando una richiesta di una sessione attiva riceve 401 (sessione scaduta o revocata). */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

interface RequestOptions {
  body?: unknown;
  /** Se true un 401 non segnala la sessione scaduta (es. login con credenziali errate). */
  anonymous?: boolean;
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: "include",
      headers: opts.body !== undefined ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
  } catch {
    throw new ApiRequestError(0, "Impossibile raggiungere il server. Controlla la connessione e riprova.");
  }

  const text = await response.text().catch(() => "");
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !opts.anonymous) unauthorizedHandler?.();
    const body = (data ?? {}) as Partial<ApiError> & { message?: string; code?: string };
    const message = body.error ?? body.message ?? "Qualcosa è andato storto. Riprova.";
    throw new ApiRequestError(response.status, message, body.code);
  }
  return data as T;
}

/* ---------------- /api/auth/* ---------------- */

export async function getSession(): Promise<SessionUser | null> {
  const data = await request<{ user?: SessionUser } | null>("GET", "/auth/get-session", { anonymous: true });
  return data?.user ?? null;
}

export function signIn(email: string, password: string): Promise<unknown> {
  return request("POST", "/auth/sign-in/email", { body: { email, password }, anonymous: true });
}

export async function signOut(): Promise<void> {
  await request("POST", "/auth/sign-out", { body: {}, anonymous: true });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request("POST", "/auth/change-password", { body: { currentPassword, newPassword } });
}

/* ---------------- /api/admin/users ---------------- */

export async function listUsers(): Promise<PublicUser[]> {
  return (await request<ListUsersResponse>("GET", "/admin/users")).users;
}

export function createUser(input: CreateUserRequest): Promise<PublicUser> {
  return request("POST", "/admin/users", { body: input });
}

export function updateUserRole(id: string, role: UserRole): Promise<PublicUser> {
  const body: UpdateUserRoleRequest = { role };
  return request("PATCH", `/admin/users/${encodeURIComponent(id)}`, { body });
}

export async function deleteUser(id: string): Promise<void> {
  await request("DELETE", `/admin/users/${encodeURIComponent(id)}`);
}

export async function resetUserPassword(id: string, password: string): Promise<void> {
  const body: ResetPasswordRequest = { password };
  await request("POST", `/admin/users/${encodeURIComponent(id)}/password`, { body });
}

/* ---------------- /api/campaigns ---------------- */

export async function listMyCampaigns(): Promise<CampaignSummary[]> {
  return (await request<ListCampaignsResponse>("GET", "/campaigns/mine")).campaigns;
}

export function createCampaign(name: string): Promise<CampaignSummary> {
  const body: CreateCampaignRequest = { name };
  return request("POST", "/campaigns", { body });
}

/** Id degli utenti che fanno parte della campagna (solo admin). */
export async function listMemberIds(campaignId: string): Promise<string[]> {
  return (await request<ListMembersResponse>("GET", `/campaigns/${encodeURIComponent(campaignId)}/members`)).members.map((m) => m.userId);
}

export async function addCampaignMember(campaignId: string, userId: string): Promise<void> {
  const body: AddMemberRequest = { userId };
  await request("POST", `/campaigns/${encodeURIComponent(campaignId)}/members`, { body });
}

export async function removeCampaignMember(campaignId: string, userId: string): Promise<void> {
  await request("DELETE", `/campaigns/${encodeURIComponent(campaignId)}/members/${encodeURIComponent(userId)}`);
}

/* ---------------- /api/uploads ---------------- */

/** Carica un'immagine (solo admin, verificato dal server). L'URL restituito e' relativo all'API (`/assets/...`). */
export async function uploadImage(kind: UploadKind, file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  let response: Response;
  try {
    response = await fetch(`${BASE}/uploads/${kind}`, { method: "POST", credentials: "include", body: form });
  } catch {
    throw new ApiRequestError(0, "Impossibile raggiungere il server. Controlla la connessione e riprova.");
  }
  const data = (await response.json().catch(() => null)) as (Partial<UploadResponse> & { error?: string }) | null;
  if (!response.ok || !data || typeof data.url !== "string") {
    if (response.status === 401) unauthorizedHandler?.();
    throw new ApiRequestError(response.status, data?.error ?? "Caricamento non riuscito.");
  }
  return data as UploadResponse;
}

/* ---------------- Messaggi per l'utente ---------------- */

/** Messaggio leggibile per un caricamento fallito (stati del server: 413, 415, 429...). */
export function uploadErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 0) return err.message;
    if (err.status === 413) return "L'immagine è troppo grande (peso o dimensioni in pixel). Riduci l'immagine e riprova.";
    if (err.status === 415) return "Formato non supportato: usa un'immagine PNG, JPEG o WebP.";
    if (err.status === 403) return "Solo il GM può caricare immagini.";
    if (err.status === 429) return "Troppi caricamenti. Attendi un minuto e riprova.";
    if (err.status >= 500) return "Il server ha avuto un problema. Riprova fra poco.";
    return err.message;
  }
  return "Caricamento non riuscito. Riprova.";
}

/** Messaggio di login: identico per utente inesistente e password errata. */
export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 0) return err.message;
    if (err.status === 429) return "Troppi tentativi. Attendi qualche minuto e riprova.";
    if (err.status >= 500) return "Il server ha avuto un problema. Riprova fra poco.";
  }
  return "Email o password non corretti.";
}

export function userErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 409 && /admin/i.test(err.message)) {
      return "Deve restare almeno un admin: promuovi prima un altro utente.";
    }
    if (err.status === 403) return "Non hai il permesso di farlo.";
    if (err.status === 429) return "Troppe richieste. Attendi qualche minuto e riprova.";
    if (err.status >= 500) return "Il server ha avuto un problema. Riprova fra poco.";
    return err.message;
  }
  return "Qualcosa è andato storto. Riprova.";
}

export function passwordErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 0 || err.status === 429 || err.status >= 500) return userErrorMessage(err);
    if (err.status === 400 || err.status === 401) return "La password attuale non è corretta, oppure la nuova non rispetta i requisiti.";
  }
  return userErrorMessage(err);
}
