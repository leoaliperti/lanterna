import { z } from "zod";
import { IdSchema, LIMITS } from "./limits.js";

/**
 * Combattimento (M7): iniziativa, effetti temporanei, gruppi di token e azioni di gruppo.
 * Questo modulo contiene solo gli schemi e le funzioni pure; i comandi si applicano in
 * `combat-reducer.ts` / `reducer.ts`.
 */

const Name = z.string().trim().min(1).max(LIMITS.nameMaxLength);

/** Condizione (stessa forma di `TokenCondition`, ripetuta qui per non creare cicli fra moduli). */
export const EffectConditionSchema = z.strictObject({ id: IdSchema, name: Name });
export type EffectCondition = z.infer<typeof EffectConditionSchema>;

/** Condizioni create automaticamente dalle regole dei PF (morte e 0 PF). Stesso id delle condizioni 5e. */
export const DEAD_CONDITION: EffectCondition = { id: "dead", name: "Morto" };
export const UNCONSCIOUS_CONDITION: EffectCondition = { id: "unconscious", name: "Privo di sensi" };

// ---------------------------------------------------------------------------
// Effetti temporanei
// ---------------------------------------------------------------------------

/** L'effetto cala all'inizio (`start`) o alla fine (`end`) del turno dell'ancora. */
export const EffectTimingSchema = z.enum(["start", "end"]);
export type EffectTiming = z.infer<typeof EffectTimingSchema>;

/**
 * Effetto come lo scrive il GM. `remaining` = quante volte deve ancora ripetersi il momento
 * `timing` del turno dell'ancora (`turnOf`, o il token stesso se `null`) prima che scada;
 * `null` = senza scadenza. Un "round" corrisponde a un turno dell'ancora.
 * `condition`: condizione 5e (o libera) applicata al token finché l'effetto dura.
 */
export const EffectInputSchema = z.strictObject({
  id: IdSchema,
  name: Name,
  condition: EffectConditionSchema.nullable(),
  remaining: z.number().int().min(1).max(LIMITS.maxEffectRounds).nullable(),
  timing: EffectTimingSchema,
  turnOf: IdSchema.nullable(),
  /** Segreto: lo vede solo il GM (come le note). */
  secret: z.boolean(),
});
export type EffectInput = z.infer<typeof EffectInputSchema>;

/** Effetto salvato nel token: in più ricorda se la condizione l'ha aggiunta lui (e quindi la toglie alla scadenza). */
export const EffectSchema = EffectInputSchema.extend({ addedCondition: z.boolean() });
export type Effect = z.infer<typeof EffectSchema>;

export const EffectsSchema = z
  .array(EffectSchema)
  .max(LIMITS.maxEffectsPerToken)
  .refine((es) => new Set(es.map((e) => e.id)).size === es.length, { message: "effetti duplicati" });

/** Effetto visto da un utente: il giocatore non riceve né i segreti né i dettagli interni. */
export const EffectViewSchema = z.strictObject({
  id: IdSchema,
  name: Name,
  condition: EffectConditionSchema.nullable(),
  remaining: z.number().int().nullable(),
  timing: EffectTimingSchema,
  /** Solo GM. */
  secret: z.boolean().optional(),
  /** Solo GM. */
  turnOf: IdSchema.nullable().optional(),
});
export type EffectView = z.infer<typeof EffectViewSchema>;

export const EffectPatchSchema = z
  .strictObject({
    name: Name,
    remaining: z.number().int().min(1).max(LIMITS.maxEffectRounds).nullable(),
    timing: EffectTimingSchema,
    secret: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "patch vuota" });
export type EffectPatch = z.infer<typeof EffectPatchSchema>;

// ---------------------------------------------------------------------------
// Iniziativa
// ---------------------------------------------------------------------------

export const InitiativeSchema = z.number().min(LIMITS.initiativeMin).max(LIMITS.initiativeMax);

/**
 * Partecipante: un token della scena (`tokenId`, il nome si legge dal token) oppure una voce libera
 * (`tokenId = null`, con `name`). `hidden`: i giocatori non sanno che esiste;
 * `hideInitiative`: la voce si vede ma senza il valore dell'iniziativa.
 */
export const ParticipantSchema = z
  .strictObject({
    id: IdSchema,
    tokenId: IdSchema.nullable(),
    name: Name.nullable(),
    initiative: InitiativeSchema.nullable(),
    hidden: z.boolean(),
    hideInitiative: z.boolean(),
  })
  .refine((p) => p.tokenId !== null || p.name !== null, { message: "una voce libera ha bisogno del nome" });
export type Participant = z.infer<typeof ParticipantSchema>;

/**
 * Combattimento di una scena. L'ordine dell'array `participants` è l'ordine dei turni.
 * `turnId`: partecipante di turno. `step`/`maxStep`: passi avanti fatti e massimo raggiunto; gli effetti
 * scalano solo andando oltre il massimo, così "indietro" e di nuovo "avanti" non li fa scalare due volte.
 */
export const CombatSchema = z
  .strictObject({
    sceneId: IdSchema,
    started: z.boolean(),
    round: z.number().int().min(0).max(LIMITS.maxRound),
    turnId: IdSchema.nullable(),
    step: z.number().int().min(0),
    maxStep: z.number().int().min(0),
    participants: z.array(ParticipantSchema).max(LIMITS.maxParticipants),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const ids = new Set(c.participants.map((p) => p.id));
    if (ids.size !== c.participants.length) issue("partecipanti duplicati");
    const tokenIds = c.participants.flatMap((p) => (p.tokenId ? [p.tokenId] : []));
    if (new Set(tokenIds).size !== tokenIds.length) issue("token duplicato nel combattimento");
    if (c.step > c.maxStep) issue("passo oltre il massimo");
    if (c.started) {
      if (c.round < 1) issue("round non valido");
      if (c.turnId === null || !ids.has(c.turnId)) issue("turno non valido");
    } else if (c.round !== 0 || c.turnId !== null || c.step !== 0 || c.maxStep !== 0) {
      issue("combattimento non avviato con turno");
    }
  });
export type Combat = z.infer<typeof CombatSchema>;

/** Partecipante visto da un utente. */
export const ParticipantViewSchema = z.strictObject({
  id: IdSchema,
  tokenId: IdSchema.nullable(),
  name: Name,
  /** `null` se nascosta dal GM (per i giocatori) o non ancora tirata. */
  initiative: InitiativeSchema.nullable(),
  /** Solo GM. */
  hidden: z.boolean().optional(),
  /** Solo GM. */
  hideInitiative: z.boolean().optional(),
});
export type ParticipantView = z.infer<typeof ParticipantViewSchema>;

export const CombatViewSchema = z.strictObject({
  sceneId: IdSchema,
  started: z.boolean(),
  round: z.number().int().min(0),
  /** Per i giocatori `null` se il partecipante di turno è nascosto. */
  turnId: IdSchema.nullable(),
  participants: z.array(ParticipantViewSchema),
});
export type CombatView = z.infer<typeof CombatViewSchema>;

export const ParticipantPatchSchema = z
  .strictObject({
    name: Name,
    initiative: InitiativeSchema.nullable(),
    hidden: z.boolean(),
    hideInitiative: z.boolean(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "patch vuota" });
export type ParticipantPatch = z.infer<typeof ParticipantPatchSchema>;

export const InitiativeValueSchema = z.strictObject({ participantId: IdSchema, initiative: InitiativeSchema });
export type InitiativeValue = z.infer<typeof InitiativeValueSchema>;

/** Ordina per iniziativa decrescente, stabile; chi non ha iniziativa va in fondo. */
export function sortByInitiative(participants: readonly Participant[]): Participant[] {
  return participants
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const x = a.p.initiative;
      const y = b.p.initiative;
      if (x === y) return a.i - b.i;
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x || a.i - b.i;
    })
    .map((e) => e.p);
}

// ---------------------------------------------------------------------------
// Tiro dell'iniziativa (l'RNG lo mette il server)
// ---------------------------------------------------------------------------

export const InitiativeModeSchema = z.enum(["normal", "advantage", "disadvantage"]);
export type InitiativeMode = z.infer<typeof InitiativeModeSchema>;

export interface InitiativeRoll {
  /** I d20 tirati (due con vantaggio/svantaggio). */
  dice: number[];
  natural: number;
  total: number;
}

/**
 * d20 + bonus. `randomInt(max)` deve dare un intero uniforme in [0, max) (in produzione `crypto.randomInt`).
 * Il totale è sempre dentro i limiti dell'iniziativa.
 */
export function rollInitiative(
  randomInt: (maxExclusive: number) => number,
  bonus: number,
  mode: InitiativeMode = "normal",
): InitiativeRoll {
  const d = () => randomInt(20) + 1;
  const dice = mode === "normal" ? [d()] : [d(), d()];
  const natural = mode === "advantage" ? Math.max(...dice) : mode === "disadvantage" ? Math.min(...dice) : dice[0]!;
  const total = Math.max(LIMITS.initiativeMin, Math.min(LIMITS.initiativeMax, natural + bonus));
  return { dice, natural, total };
}

// ---------------------------------------------------------------------------
// Gruppi, selezione e azioni di gruppo
// ---------------------------------------------------------------------------

export const GroupSchema = z.strictObject({
  id: IdSchema,
  name: Name,
  tokenIds: z
    .array(IdSchema)
    .max(LIMITS.maxGroupTokens)
    .refine((ids) => new Set(ids).size === ids.length, { message: "token duplicati" }),
});
export type TokenGroup = z.infer<typeof GroupSchema>;

export const GroupPatchSchema = z
  .strictObject({ name: Name, tokenIds: GroupSchema.shape.tokenIds })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "patch vuota" });
export type GroupPatch = z.infer<typeof GroupPatchSchema>;

const TokenKindEnum = z.enum(["pc", "monster", "object"]);

/** Chi colpisce un'azione di gruppo, oppure cosa si seleziona. */
export const TokenTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("tokens"), tokenIds: z.array(IdSchema).max(LIMITS.maxGroupTokens) }),
  z.strictObject({ kind: z.literal("group"), groupId: IdSchema }),
  z.strictObject({
    kind: z.literal("category"),
    sceneId: IdSchema,
    /** Solo PG, solo mostri, solo oggetti (assente = tutti). */
    tokenKind: TokenKindEnum.optional(),
    /** Fazione esatta (assente = qualunque). */
    faction: Name.optional(),
    /** Per default vale `true` (solo il GM può usare le categorie). */
    includeHidden: z.boolean().optional(),
  }),
]);
export type TokenTarget = z.infer<typeof TokenTargetSchema>;

const hpAmount = z.number().int().min(0).max(LIMITS.hpMax);
const offset = z.number().min(-LIMITS.sceneMaxSize).max(LIMITS.sceneMaxSize);

export const GroupActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("damage"), amount: hpAmount, critical: z.boolean().optional() }),
  z.strictObject({ kind: z.literal("heal"), amount: hpAmount }),
  z.strictObject({ kind: z.literal("tempHp"), amount: hpAmount }),
  z.strictObject({ kind: z.literal("addCondition"), condition: EffectConditionSchema }),
  z.strictObject({ kind: z.literal("removeCondition"), conditionId: IdSchema }),
  /** `effect.id` è un prefisso: l'id di ogni effetto è derivato dal token (vedi `derivedEffectId`). */
  z.strictObject({ kind: z.literal("addEffect"), effect: EffectInputSchema }),
  z.strictObject({ kind: z.literal("move"), dx: offset, dy: offset }),
]);
export type GroupAction = z.infer<typeof GroupActionSchema>;

/** FNV-1a a 32 bit in esadecimale (non crittografico: serve solo a derivare id). */
function hash32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Id dell'effetto che un'azione di gruppo crea su un token: deterministico, così annulla/ripeti restano esatti. */
export function derivedEffectId(baseId: string, tokenId: string): string {
  return `${baseId.slice(0, LIMITS.idMaxLength - 9)}-${hash32(tokenId)}`;
}
