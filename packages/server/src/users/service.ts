import { randomUUID } from "node:crypto";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PublicUser,
  type UserRole,
} from "@lanterna/shared";
import type { Auth } from "../auth/auth.js";
import type { Db } from "../db/client.js";
import { account, session, user } from "../db/schema.js";

export class UserServiceError extends Error {
  constructor(
    readonly code: "invalid_password" | "email_taken" | "not_found" | "last_admin",
    message: string,
  ) {
    super(message);
  }
}

export interface NewUser {
  email: string;
  name: string;
  password: string;
  role: UserRole;
}

type UserRow = typeof user.$inferSelect;

function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function checkPasswordPolicy(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new UserServiceError(
      "invalid_password",
      `La password deve avere tra ${PASSWORD_MIN_LENGTH} e ${PASSWORD_MAX_LENGTH} caratteri.`,
    );
  }
}

/** Condizione SQL: esiste almeno un altro admin oltre a quello indicato. */
const anotherAdminExists = (id: string) =>
  sql`exists (select 1 from ${user} as other where other.role = 'admin' and other.id <> ${id})`;

/**
 * Operazioni sugli account. Le chiamano solo le rotte /admin (già protette da `requireRole('admin')`)
 * e lo script `create-admin`.
 */
export function createUserService(db: Db, auth: Auth) {
  async function hash(password: string): Promise<string> {
    checkPasswordPolicy(password);
    const ctx = await auth.$context;
    return ctx.password.hash(password);
  }

  async function findByEmail(email: string): Promise<PublicUser | null> {
    const row = await db.query.user.findFirst({ where: eq(user.email, normalizeEmail(email)) });
    return row ? toPublic(row) : null;
  }

  async function findById(id: string): Promise<PublicUser | null> {
    const row = await db.query.user.findFirst({ where: eq(user.id, id) });
    return row ? toPublic(row) : null;
  }

  async function create(input: NewUser): Promise<PublicUser> {
    const email = normalizeEmail(input.email);
    const passwordHash = await hash(input.password);
    if (await findByEmail(email)) {
      throw new UserServiceError("email_taken", "Email già in uso.");
    }
    const id = randomUUID();
    const now = new Date();
    try {
      const [rows] = await db.batch([
        db
          .insert(user)
          .values({ id, email, name: input.name.trim(), role: input.role, emailVerified: true, createdAt: now, updatedAt: now })
          .returning(),
        db.insert(account).values({
          id: randomUUID(),
          accountId: id,
          providerId: "credential",
          userId: id,
          password: passwordHash,
          createdAt: now,
          updatedAt: now,
        }),
      ]);
      return toPublic(rows[0] as UserRow);
    } catch (err) {
      if (await findByEmail(email)) throw new UserServiceError("email_taken", "Email già in uso.");
      throw err;
    }
  }

  async function list(): Promise<PublicUser[]> {
    const rows = await db.select().from(user).orderBy(asc(user.createdAt), asc(user.email));
    return rows.map(toPublic);
  }

  async function notFoundOrLastAdmin(id: string): Promise<never> {
    if (!(await findById(id))) throw new UserServiceError("not_found", "Utente inesistente.");
    throw new UserServiceError("last_admin", "Deve restare almeno un admin.");
  }

  /** Cambia ruolo. Il declassamento dell'ultimo admin è rifiutato in modo atomico. */
  async function setRole(id: string, role: UserRole): Promise<PublicUser> {
    const where =
      role === "admin"
        ? eq(user.id, id)
        : and(eq(user.id, id), or(ne(user.role, "admin"), anotherAdminExists(id)));
    const rows = await db.update(user).set({ role, updatedAt: new Date() }).where(where).returning();
    const row = rows[0];
    if (!row) return notFoundOrLastAdmin(id);
    return toPublic(row);
  }

  /** Elimina un utente (sessioni e account in cascata). L'ultimo admin non si elimina. */
  async function remove(id: string): Promise<void> {
    const rows = await db
      .delete(user)
      .where(and(eq(user.id, id), or(ne(user.role, "admin"), anotherAdminExists(id))))
      .returning({ id: user.id });
    if (rows.length === 0) await notFoundOrLastAdmin(id);
  }

  /** Reimposta la password e chiude tutte le sessioni dell'utente. */
  async function resetPassword(id: string, password: string): Promise<void> {
    const passwordHash = await hash(password);
    if (!(await findById(id))) throw new UserServiceError("not_found", "Utente inesistente.");
    const now = new Date();
    const updated = await db
      .update(account)
      .set({ password: passwordHash, updatedAt: now })
      .where(and(eq(account.userId, id), eq(account.providerId, "credential")))
      .returning({ id: account.id });
    if (updated.length === 0) {
      await db.insert(account).values({
        id: randomUUID(),
        accountId: id,
        providerId: "credential",
        userId: id,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });
    }
    await db.delete(session).where(eq(session.userId, id));
  }

  return { create, list, findByEmail, findById, setRole, remove, resetPassword };
}

export type UserService = ReturnType<typeof createUserService>;
