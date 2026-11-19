import type { PublicUser } from "@lanterna/shared";
import { checkPasswordPolicy, type UserService } from "../users/service.js";

export interface AdminInput {
  email: string;
  name: string;
  password: string;
}

export type EnsureAdminResult = { status: "created" | "exists"; user: PublicUser };

/**
 * Crea l'admin se non esiste. Idempotente: se l'admin con quella email c'è già non cambia nulla.
 * Un giocatore con la stessa email non viene promosso di nascosto.
 */
export async function ensureAdmin(users: UserService, input: AdminInput): Promise<EnsureAdminResult> {
  const existing = await users.findByEmail(input.email);
  if (existing) {
    if (existing.role === "admin") return { status: "exists", user: existing };
    throw new Error(
      "Esiste già un giocatore con questa email: promuovilo da un account admin invece di usare questo script.",
    );
  }
  checkPasswordPolicy(input.password);
  const user = await users.create({ ...input, role: "admin" });
  return { status: "created", user };
}
