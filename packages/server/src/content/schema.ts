import { z } from "zod";

/** Tipi di documento. `altro` è il ripiego per tutto ciò che non rientra negli altri. */
export const CONTENT_KINDS = ["monster", "item", "spell", "class", "species", "note", "altro"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/**
 * Tipi che un giocatore non può MAI leggere, qualunque cosa dica `CONTENT_PLAYER_KINDS`:
 * i mostri e le note sono del GM.
 */
export const GM_ONLY_KINDS: readonly ContentKind[] = ["monster", "note"];

export const LIMITS = {
  /** Documenti per file. */
  maxItems: 5000,
  /** Dimensione del JSON di un singolo documento (byte). */
  maxDataBytes: 64 * 1024,
  maxDepth: 12,
  maxNameLength: 200,
  maxSourceLength: 200,
  /** Lunghezza di ogni stringa contenuta nei dati. */
  maxStringLength: 20_000,
  /** File letti da una cartella nella CLI. */
  maxFiles: 1000,
} as const;

/** Un tag HTML (`<b>`, `</div>`, `<!--`, `<?xml`): il contenuto è testo semplice, mai HTML. */
const HTML_TAG = /<\s*[/!?]?\s*[A-Za-z]/;
/** Schemi di URL eseguibili dentro una stringa che inizia così. */
const SCRIPT_URL = /^\s*(javascript\s*:|vbscript\s*:|data\s*:\s*text\/html)/i;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Controlla profondità, dimensione delle stringhe, chiavi pericolose e HTML. Restituisce l'errore o `null`. */
export function checkData(value: unknown, path = "data", depth = 0): string | null {
  if (depth > LIMITS.maxDepth) return `${path}: troppo annidato (massimo ${LIMITS.maxDepth} livelli)`;
  if (typeof value === "string") {
    if (value.length > LIMITS.maxStringLength) return `${path}: stringa troppo lunga`;
    if (HTML_TAG.test(value)) return `${path}: contiene HTML (il contenuto deve essere testo semplice)`;
    if (SCRIPT_URL.test(value)) return `${path}: schema di URL non ammesso`;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = checkData(value[i], `${path}[${i}]`, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) return `${path}: chiave non ammessa "${k}"`;
      if (HTML_TAG.test(k)) return `${path}: chiave con HTML`;
      const err = checkData(v, `${path}.${k}`, depth + 1);
      if (err) return err;
    }
  }
  return null;
}

function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > LIMITS.maxDepth + 4 || !value || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(k)) return `chiave non ammessa "${k}"`;
    const err = findForbiddenKey(v, depth + 1);
    if (err) return err;
  }
  return null;
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !HTML_TAG.test(s), "non può contenere HTML");

const CampaignIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const ContentItemSchema = z.strictObject({
  kind: z.enum(CONTENT_KINDS),
  name: text(LIMITS.maxNameLength),
  data: z
    .record(z.string(), z.unknown())
    .superRefine((data, ctx) => {
      const err = checkData(data);
      if (err) ctx.addIssue({ code: "custom", message: err });
      else if (Buffer.byteLength(JSON.stringify(data)) > LIMITS.maxDataBytes) {
        ctx.addIssue({ code: "custom", message: `data: oltre ${LIMITS.maxDataBytes} byte` });
      }
    }),
  /** Sovrascrive la `source` del file, per il singolo documento. */
  source: text(LIMITS.maxSourceLength).optional(),
});
export type ContentItem = z.infer<typeof ContentItemSchema>;

/** File di importazione: oggetto con `items`, oppure direttamente un array di documenti. */
export const ContentFileSchema = z.strictObject({
  format: z.literal("lanterna-content").optional(),
  version: z.literal(1).optional(),
  /** Origine dei documenti (nome del manuale/raccolta, a scelta di chi importa). */
  source: text(LIMITS.maxSourceLength).optional(),
  /** Se presente, i documenti sono visibili solo ai membri di quella campagna. */
  campaignId: CampaignIdSchema.optional(),
  items: z.array(ContentItemSchema).min(1).max(LIMITS.maxItems),
});
export type ContentFile = z.infer<typeof ContentFileSchema>;

export interface ParsedContent {
  campaignId: string | null;
  items: { kind: ContentKind; name: string; data: Record<string, unknown>; source: string }[];
}

export class ContentValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

/** Valida un documento già decodificato da JSON. Solleva `ContentValidationError` con i dettagli. */
export function parseContent(input: unknown, defaultSource = ""): ParsedContent {
  const candidate = Array.isArray(input) ? { items: input } : input;
  // Zod scarta in silenzio `__proto__` nei record: lo si rifiuta prima, in modo esplicito.
  const forbidden = findForbiddenKey(candidate);
  if (forbidden) throw new ContentValidationError("File di contenuti non valido", [forbidden]);
  const result = ContentFileSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(radice)"}: ${i.message}`);
    throw new ContentValidationError("File di contenuti non valido", issues);
  }
  const file = result.data;
  const source = file.source ?? defaultSource;
  return {
    campaignId: file.campaignId ?? null,
    items: file.items.map((it) => ({ kind: it.kind, name: it.name, data: it.data, source: it.source ?? source })),
  };
}
