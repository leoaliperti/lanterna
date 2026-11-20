import { isInsideScene } from "./grid.js";
import { CampaignStateSchema, type CampaignState } from "./schema.js";

/**
 * Invarianti dello stato. Restituisce l'elenco delle violazioni (vuoto = tutto ok).
 * Usato nei test (fuzz) e utile al server dopo il caricamento da SQLite.
 */
export function checkInvariants(state: CampaignState): string[] {
  const problems: string[] = [];
  const parsed = CampaignStateSchema.safeParse(state);
  if (!parsed.success) problems.push(`schema: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  const sceneIds = new Set<string>();
  for (const s of state.scenes) {
    if (sceneIds.has(s.id)) problems.push(`scena duplicata ${s.id}`);
    sceneIds.add(s.id);
  }
  const tokenIds = new Set<string>();
  const memberIds = new Set(state.members.map((m) => m.userId));
  for (const t of state.tokens) {
    if (tokenIds.has(t.id)) problems.push(`token duplicato ${t.id}`);
    tokenIds.add(t.id);
    const scene = state.scenes.find((s) => s.id === t.sceneId);
    if (!scene) problems.push(`token ${t.id} senza scena`);
    else if (!isInsideScene(t.x, t.y, scene)) problems.push(`token ${t.id} fuori mappa`);
    if (t.ownerUserId !== null && !memberIds.has(t.ownerUserId)) problems.push(`token ${t.id} con proprietario sconosciuto`);
  }
  if (state.activeSceneId !== null && !sceneIds.has(state.activeSceneId)) {
    problems.push("scena attiva inesistente");
  }
  return problems;
}
