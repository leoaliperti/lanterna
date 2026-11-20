import { z } from "zod";

/** Limiti condivisi: usati sia dagli schemi sia dai test. */
export const LIMITS = {
  idMaxLength: 64,
  nameMaxLength: 64,
  urlMaxLength: 2048,
  notesMaxLength: 10_000,
  sceneMinSize: 1,
  sceneMaxSize: 20_000,
  cellMinSize: 4,
  cellMaxSize: 1024,
  tokenMinSize: 0.25,
  tokenMaxSize: 32,
  maxConditions: 32,
  hpMax: 100_000,
  unitsPerCellMax: 1000,
  unitMaxLength: 16,
  maxTokens: 2000,
  maxScenes: 200,
  /** Muri e porte, in tutta la campagna. */
  maxWalls: 5000,
  /** Terne per maschera di nebbia (vedi `fog.ts`). */
  fogMaxRuns: 20_000,
  /** Maschere personali per scena (giocatori con una maschera diversa da quella di tutti). */
  fogMaxPlayers: 64,
  fogMaxPolygonPoints: 512,
  fogMaxCells: 4096,
  /** Raggi di vista e luce, in unità di gioco. */
  visionMaxRange: 10_000,
} as const;

/** Identificatore opaco (UUID o simile). Mai contatori: non devono rivelare quanti oggetti esistono. */
export const IdSchema = z
  .string()
  .min(1)
  .max(LIMITS.idMaxLength)
  .regex(/^[A-Za-z0-9_-]+$/, "id non valido");
export type Id = z.infer<typeof IdSchema>;

