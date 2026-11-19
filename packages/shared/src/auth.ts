/** Ruoli degli account. `admin` coincide con il GM. */
export const USER_ROLES = ["admin", "player"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Policy minima delle password, uguale per login, creazione utenti e reset. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Utente come lo vede l'API (mai hash o dati di sessione). */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

/** POST /admin/users */
export interface CreateUserRequest {
  email: string;
  name: string;
  password: string;
  role: UserRole;
}

/** PATCH /admin/users/:id */
export interface UpdateUserRoleRequest {
  role: UserRole;
}

/** POST /admin/users/:id/password */
export interface ResetPasswordRequest {
  password: string;
}

/** GET /admin/users */
export interface ListUsersResponse {
  users: PublicUser[];
}

/** Corpo di ogni risposta di errore delle API di Lanterna. */
export interface ApiError {
  error: string;
}
