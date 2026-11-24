import { isInsideScene } from "./grid.js";
import { CampaignStateSchema, type CampaignState, type Member } from "./schema.js";

/**
 * Applica un nuovo elenco di membri (gestito fuori dai comandi, dal server): i token di chi
 * non è più membro restano senza proprietario e le maschere di nebbia di chi non è più un
 * giocatore della campagna vengono tolte (se rientra riparte dalla maschera "di tutti").
 * Restituisce anche gli id dei token e delle scene con nebbia toccati, da salvare.
 */
export function withMembers(
  state: CampaignState,
  members: Member[],
): { state: CampaignState; touchedTokenIds: string[]; touchedFogSceneIds: string[] } {
  const memberIds = new Set(members.map((m) => m.userId));
  const playerIds = new Set(members.filter((m) => m.role === "player").map((m) => m.userId));
  const touchedTokenIds: string[] = [];
  const touchedFogSceneIds: string[] = [];
  const tokens = state.tokens.map((t) => {
    if (t.ownerUserId === null || memberIds.has(t.ownerUserId)) return t;
    touchedTokenIds.push(t.id);
    return { ...t, ownerUserId: null };
  });
  const fogs = state.fogs?.map((f) => {
    const players = f.players.filter((p) => playerIds.has(p.userId));
    if (players.length === f.players.length) return f;
    touchedFogSceneIds.push(f.sceneId);
    return { ...f, players };
  });
  return {
    state: { ...state, members, tokens, ...(fogs ? { fogs } : {}) },
    touchedTokenIds,
    touchedFogSceneIds,
  };
}

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
  const fogScenes = new Set<string>();
  const playerIds = new Set(state.members.filter((m) => m.role === "player").map((m) => m.userId));
  for (const f of state.fogs ?? []) {
    if (fogScenes.has(f.sceneId)) problems.push(`nebbia duplicata ${f.sceneId}`);
    fogScenes.add(f.sceneId);
    if (!sceneIds.has(f.sceneId)) problems.push(`nebbia ${f.sceneId} senza scena`);
    for (const p of f.players) if (!playerIds.has(p.userId)) problems.push(`nebbia ${f.sceneId} con giocatore sconosciuto`);
  }
  const wallIds = new Set<string>();
  for (const w of state.walls ?? []) {
    if (wallIds.has(w.id)) problems.push(`muro duplicato ${w.id}`);
    wallIds.add(w.id);
    if (!sceneIds.has(w.sceneId)) problems.push(`muro ${w.id} senza scena`);
  }
  const propIds = new Set<string>();
  for (const p of state.props ?? []) {
    if (propIds.has(p.id)) problems.push(`oggetto di scena duplicato ${p.id}`);
    propIds.add(p.id);
    if (!sceneIds.has(p.sceneId)) problems.push(`oggetto di scena ${p.id} senza scena`);
  }
  // Combattimento (M7).
  const tokenById = new Map(state.tokens.map((t) => [t.id, t]));
  const combatScenes = new Set<string>();
  for (const c of state.combats ?? []) {
    if (combatScenes.has(c.sceneId)) problems.push(`combattimento duplicato ${c.sceneId}`);
    combatScenes.add(c.sceneId);
    if (!sceneIds.has(c.sceneId)) problems.push(`combattimento ${c.sceneId} senza scena`);
    if (c.participants.length === 0) problems.push(`combattimento ${c.sceneId} vuoto`);
    for (const p of c.participants) {
      if (p.tokenId === null) continue;
      const t = tokenById.get(p.tokenId);
      if (!t) problems.push(`partecipante ${p.id} con token inesistente`);
      else if (t.sceneId !== c.sceneId) problems.push(`partecipante ${p.id} con token di un'altra scena`);
    }
  }
  for (const t of state.tokens) {
    for (const e of t.effects ?? []) {
      if (e.turnOf === null) continue;
      const a = tokenById.get(e.turnOf);
      if (!a || a.sceneId !== t.sceneId) problems.push(`effetto ${e.id} con ancora non valida`);
    }
  }
  const groupIds = new Set<string>();
  for (const g of state.groups ?? []) {
    if (groupIds.has(g.id)) problems.push(`gruppo duplicato ${g.id}`);
    groupIds.add(g.id);
    for (const id of g.tokenIds) if (!tokenById.has(id)) problems.push(`gruppo ${g.id} con token inesistente`);
  }
  if (state.activeSceneId !== null && !sceneIds.has(state.activeSceneId)) {
    problems.push("scena attiva inesistente");
  }
  return problems;
}
