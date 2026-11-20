import { z } from "zod";
import { CombatSchema, GroupSchema, type Combat, type TokenGroup } from "./combat.js";
import { FogSchema, type Fog } from "./fog.js";
import { IdSchema } from "./limits.js";
import { SceneSchema, TokenSchema, type Scene, type Token } from "./schema.js";
import { WallSchema, type Wall } from "./walls.js";

/**
 * Avvisi di combattimento (M7): non cambiano lo stato, vanno solo ai diretti interessati
 * (GM e proprietario del token). Il client decide come mostrarli (nessun popup obbligato).
 */
export const NoticeSchema = z.discriminatedUnion("kind", [
  /** Inizia il turno di un partecipante. */
  z.strictObject({
    kind: z.literal("turn"),
    sceneId: IdSchema,
    round: z.number().int(),
    participantId: IdSchema,
    tokenId: IdSchema.nullable(),
  }),
  /** Un effetto sta per terminare (scadrà al prossimo momento previsto). */
  z.strictObject({
    kind: z.literal("expiring"),
    sceneId: IdSchema,
    round: z.number().int(),
    tokenId: IdSchema,
    effectId: IdSchema,
    name: z.string(),
    remaining: z.number().int(),
    secret: z.boolean(),
  }),
  /** Un effetto è terminato (e con lui l'eventuale condizione). */
  z.strictObject({
    kind: z.literal("expired"),
    sceneId: IdSchema,
    round: z.number().int(),
    tokenId: IdSchema,
    effectId: IdSchema,
    name: z.string(),
    reason: z.enum(["elapsed", "combatEnded"]),
    secret: z.boolean(),
  }),
]);
export type Notice = z.infer<typeof NoticeSchema>;

/**
 * Cambiamenti interni prodotti dal riduttore. Contengono lo stato COMPLETO
 * (prima e dopo) e quindi **non vanno mai inviati ai client**: il server
 * li passa a `filterEventFor` per ottenere gli eventi di ciascun utente.
 *
 * Ogni cambiamento porta con sé il contesto che serve al filtro (scena attiva e,
 * dal M6, la nebbia della scena coinvolta), così il filtro non consulta lo stato
 * e un cambiamento rilanciato dal registro (riconnessione) dà gli stessi eventi.
 */
export type StateChange =
  | {
      type: "combat";
      sceneId: string;
      before: Combat | null;
      after: Combat | null;
      /** Per decidere cosa vede ciascun giocatore: scena attiva, nebbia e token partecipanti, prima e dopo. */
      activeBefore: string | null;
      activeAfter: string | null;
      fogBefore: Fog | null;
      fogAfter: Fog | null;
      tokensBefore: Token[];
      tokensAfter: Token[];
    }
  | { type: "group"; before: TokenGroup | null; after: TokenGroup | null }
  | {
      type: "notice";
      notice: Notice;
      /** Il token interessato (dopo il cambiamento) per decidere chi lo riceve; `null` per le voci libere. */
      token: Token | null;
      activeSceneId: string | null;
      fog: Fog | null;
    }
  | { type: "token"; before: Token | null; after: Token | null; activeSceneId: string | null; fog?: Fog | null }
  | { type: "scene"; before: Scene | null; after: Scene | null; activeSceneId: string | null; fog?: Fog | null }
  | {
      type: "activeScene";
      before: string | null;
      after: string | null;
      /** Scena diventata attiva e i suoi token (completi), per costruire la vista dei giocatori. */
      scene: Scene | null;
      tokens: Token[];
      /** Nebbia e muri della scena diventata attiva (M6). */
      fog?: Fog | null;
      walls?: Wall[];
    }
  | { type: "wall"; before: Wall | null; after: Wall | null; activeSceneId: string | null; fog: Fog | null }
  | {
      type: "fog";
      sceneId: string;
      before: Fog | null;
      after: Fog | null;
      activeSceneId: string | null;
      /** La scena, i suoi token e i suoi muri: la loro visibilità per i giocatori dipende dalla nebbia. */
      scene: Scene | null;
      tokens: Token[];
      walls: Wall[];
    };

/**
 * Schema dei cambiamenti, per rileggere in modo difensivo il registro salvato (server).
 * `fog` e `walls` sono facoltativi: i registri scritti prima del M6 restano validi.
 */
export const StateChangeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("combat"),
    sceneId: IdSchema,
    before: CombatSchema.nullable(),
    after: CombatSchema.nullable(),
    activeBefore: IdSchema.nullable(),
    activeAfter: IdSchema.nullable(),
    fogBefore: FogSchema.nullable(),
    fogAfter: FogSchema.nullable(),
    tokensBefore: z.array(TokenSchema),
    tokensAfter: z.array(TokenSchema),
  }),
  z.strictObject({ type: z.literal("group"), before: GroupSchema.nullable(), after: GroupSchema.nullable() }),
  z.strictObject({
    type: z.literal("notice"),
    notice: NoticeSchema,
    token: TokenSchema.nullable(),
    activeSceneId: IdSchema.nullable(),
    fog: FogSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal("token"),
    before: TokenSchema.nullable(),
    after: TokenSchema.nullable(),
    activeSceneId: IdSchema.nullable(),
    fog: FogSchema.nullable().optional(),
  }),
  z.strictObject({
    type: z.literal("scene"),
    before: SceneSchema.nullable(),
    after: SceneSchema.nullable(),
    activeSceneId: IdSchema.nullable(),
    fog: FogSchema.nullable().optional(),
  }),
  z.strictObject({
    type: z.literal("activeScene"),
    before: IdSchema.nullable(),
    after: IdSchema.nullable(),
    scene: SceneSchema.nullable(),
    tokens: z.array(TokenSchema),
    fog: FogSchema.nullable().optional(),
    walls: z.array(WallSchema).optional(),
  }),
  z.strictObject({
    type: z.literal("wall"),
    before: WallSchema.nullable(),
    after: WallSchema.nullable(),
    activeSceneId: IdSchema.nullable(),
    fog: FogSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal("fog"),
    sceneId: IdSchema,
    before: FogSchema.nullable(),
    after: FogSchema.nullable(),
    activeSceneId: IdSchema.nullable(),
    scene: SceneSchema.nullable(),
    tokens: z.array(TokenSchema),
    walls: z.array(WallSchema),
  }),
]);
