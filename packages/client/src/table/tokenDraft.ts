import { LIMITS, type Command, type Health, type Token, type TokenPatch, type TokenView, type TokenVision } from "@lanterna/shared";
import { parseNumber } from "./NumberField";

/** Bozza di modifica di un token: tutti i campi come li vede il modulo (testo per i numeri). */
export interface TokenDraft {
  name: string;
  kind: TokenView["kind"];
  size: number;
  ownerUserId: string | null;
  hidden: boolean;
  hasHealth: boolean;
  current: string;
  max: string;
  temp: string;
  conditions: Array<{ id: string; name: string }>;
  gmNotes: string;
  /** Fazione (solo GM): serve alla selezione per categoria. Vuoto = nessuna. */
  faction: string;
  /** Vista e luce (aiuto visivo, mai la nebbia), in unita' di gioco. `visionRange` vuoto = vista illimitata. */
  hasVision: boolean;
  visionRange: string;
  darkvision: string;
  lightBright: string;
  lightDim: string;
  /** URL attuale dell'immagine (percorso del server) o `null`. Un nuovo file lo sostituisce al salvataggio. */
  imageUrl: string | null;
}

export function emptyDraft(): TokenDraft {
  return {
    name: "",
    kind: "monster",
    size: 1,
    ownerUserId: null,
    hidden: false,
    hasHealth: false,
    current: "10",
    max: "10",
    temp: "0",
    conditions: [],
    gmNotes: "",
    faction: "",
    hasVision: false,
    visionRange: "",
    darkvision: "0",
    lightBright: "0",
    lightDim: "0",
    imageUrl: null
  };
}

export function draftOfToken(t: TokenView): TokenDraft {
  return {
    name: t.name,
    kind: t.kind,
    size: t.size,
    ownerUserId: t.ownerUserId,
    hidden: t.hidden,
    hasHealth: t.health !== null,
    current: String(t.health?.current ?? 10),
    max: String(t.health?.max ?? 10),
    temp: String(t.health?.temp ?? 0),
    conditions: t.conditions.map((c) => ({ id: c.id, name: c.name })),
    gmNotes: t.gmNotes ?? "",
    faction: t.faction ?? "",
    hasVision: !!t.vision,
    visionRange: t.vision?.range == null ? "" : String(t.vision.range),
    darkvision: String(t.vision?.darkvision ?? 0),
    lightBright: String(t.vision?.bright ?? 0),
    lightDim: String(t.vision?.dim ?? 0),
    imageUrl: t.imageUrl
  };
}

export interface DraftErrors {
  name: string | null;
  current: string | null;
  max: string | null;
  temp: string | null;
  health: string | null;
  vision: string | null;
  faction: string | null;
}

export function healthOf(d: TokenDraft): Health | null {
  if (!d.hasHealth) return null;
  const current = parseNumber(d.current, 0, LIMITS.hpMax, true);
  const max = parseNumber(d.max, 0, LIMITS.hpMax, true);
  const temp = parseNumber(d.temp, 0, LIMITS.hpMax, true);
  if (current === null || max === null || temp === null || current > max) return null;
  return { current, max, temp };
}

/** Vista del token dalla bozza (`null` se disattivata o non valida). */
export function visionOfDraft(d: TokenDraft): TokenVision | null {
  if (!d.hasVision) return null;
  const range = d.visionRange.trim() === "" ? null : parseNumber(d.visionRange, 0, LIMITS.visionMaxRange);
  const darkvision = parseNumber(d.darkvision, 0, LIMITS.visionMaxRange);
  const bright = parseNumber(d.lightBright, 0, LIMITS.visionMaxRange);
  const dim = parseNumber(d.lightDim, 0, LIMITS.visionMaxRange);
  if ((d.visionRange.trim() !== "" && range === null) || darkvision === null || bright === null || dim === null) return null;
  return { range, darkvision, bright, dim };
}

export function validateDraft(d: TokenDraft): DraftErrors {
  const range = `Un numero intero tra 0 e ${LIMITS.hpMax}.`;
  const current = parseNumber(d.current, 0, LIMITS.hpMax, true);
  const max = parseNumber(d.max, 0, LIMITS.hpMax, true);
  return {
    name: d.name.trim() === "" ? "Dai un nome al token." : d.name.trim().length > LIMITS.nameMaxLength ? "Nome troppo lungo." : null,
    current: d.hasHealth && current === null ? range : null,
    max: d.hasHealth && max === null ? range : null,
    temp: d.hasHealth && parseNumber(d.temp, 0, LIMITS.hpMax, true) === null ? range : null,
    health: d.hasHealth && current !== null && max !== null && current > max ? "La vita attuale non può superare il massimo." : null,
    faction: d.faction.trim().length > LIMITS.nameMaxLength ? "Fazione troppo lunga." : null,
    vision: d.hasVision && visionOfDraft(d) === null ? `Raggio e luci: numeri tra 0 e ${LIMITS.visionMaxRange} (il raggio può restare vuoto).` : null
  };
}

export const hasErrors = (e: DraftErrors) => Object.values(e).some((v) => v !== null);

const sameConditions = (a: TokenDraft["conditions"], b: TokenView["conditions"]) =>
  a.length === b.length && a.every((c, i) => c.id === b[i]?.id);

/**
 * Differenza fra la bozza e il token: solo i campi cambiati. `onlyConditions` per il giocatore
 * proprietario, che puo' cambiare solo le condizioni (il server rifiuta una patch con altro).
 */
export function diffDraft(token: TokenView, d: TokenDraft, imageUrl: string | null, onlyConditions: boolean): TokenPatch {
  const patch: TokenPatch = {};
  if (!sameConditions(d.conditions, token.conditions)) patch.conditions = d.conditions;
  if (onlyConditions) return patch;
  if (d.name.trim() !== token.name) patch.name = d.name.trim();
  if (d.kind !== token.kind) patch.kind = d.kind;
  if (d.size !== token.size) patch.size = d.size;
  if (d.ownerUserId !== token.ownerUserId) patch.ownerUserId = d.ownerUserId;
  if (d.hidden !== token.hidden) patch.hidden = d.hidden;
  if (imageUrl !== token.imageUrl) patch.imageUrl = imageUrl;
  if ((d.gmNotes ?? "") !== (token.gmNotes ?? "")) patch.gmNotes = d.gmNotes;
  const faction = d.faction.trim() === "" ? null : d.faction.trim();
  if (faction !== (token.faction ?? null)) patch.faction = faction;
  const vision = visionOfDraft(d);
  const oldVision = token.vision ?? null;
  const sameVision =
    vision === null
      ? oldVision === null
      : oldVision !== null && oldVision.range === vision.range && oldVision.darkvision === vision.darkvision && oldVision.bright === vision.bright && oldVision.dim === vision.dim;
  if (!sameVision) patch.vision = vision;
  const h = healthOf(d);
  const old = token.health;
  const sameHealth = h === null ? old === null : old !== null && old.current === h.current && old.max === h.max && old.temp === h.temp;
  if (!sameHealth) patch.health = h;
  return patch;
}

/**
 * Dove far comparire un token nuovo: il centro della scena, sul centro cella (lato dispari) o sull'incrocio (lato pari).
 * Se lì c'è già un token si prova nelle celle vicine (a spirale quadrata), così i token nuovi non si impilano.
 */
export function spawnPoint(
  scene: { width: number; height: number; grid: { cellSize: number; offsetX: number; offsetY: number } },
  size: number,
  taken: ReadonlyArray<{ x: number; y: number }> = []
): { x: number; y: number } {
  const { cellSize: c, offsetX, offsetY } = scene.grid;
  const oddSide = size < 1 || Math.round(size) % 2 === 1;
  const snap = (v: number, off: number) => (oddSide ? off + (Math.floor((v - off) / c) + 0.5) * c : off + Math.round((v - off) / c) * c);
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const base = { x: clamp(snap(scene.width / 2, offsetX), scene.width), y: clamp(snap(scene.height / 2, offsetY), scene.height) };
  const free = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x <= scene.width && p.y <= scene.height && !taken.some((t) => Math.abs(t.x - p.x) < c / 2 && Math.abs(t.y - p.y) < c / 2);
  for (let ring = 0; ring <= 8; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const candidate = { x: base.x + dx * c, y: base.y + dy * c };
        if (free(candidate)) return candidate;
      }
    }
  }
  return base;
}

/** Comando `token.create` da una bozza, al centro (px mappa) indicato. */
export function createCommand(id: string, sceneId: string, d: TokenDraft, imageUrl: string | null, x: number, y: number): Command {
  const token: Token = {
    id,
    sceneId,
    name: d.name.trim(),
    imageUrl,
    x,
    y,
    size: d.size,
    rotation: 0,
    ownerUserId: d.ownerUserId,
    kind: d.kind,
    hidden: d.hidden,
    conditions: d.conditions,
    health: healthOf(d),
    gmNotes: d.gmNotes,
    vision: visionOfDraft(d),
    ...(d.faction.trim() ? { faction: d.faction.trim() } : {})
  };
  return { type: "token.create", token };
}
