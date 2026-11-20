import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@lanterna/shared";

export const PASSWORD_REQUIREMENT = `Da ${PASSWORD_MIN_LENGTH} a ${PASSWORD_MAX_LENGTH} caratteri.`;

/** Controllo UX dei requisiti; la validazione vera e' sul server. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `La password deve avere almeno ${PASSWORD_MIN_LENGTH} caratteri.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `La password puo' avere al massimo ${PASSWORD_MAX_LENGTH} caratteri.`;
  return null;
}
