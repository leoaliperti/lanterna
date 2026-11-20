import type { Scene, Token } from "./schema.js";

/**
 * Cambiamenti interni prodotti dal riduttore. Contengono lo stato COMPLETO
 * (prima e dopo) e quindi **non vanno mai inviati ai client**: il server
 * li passa a `filterEventFor` per ottenere gli eventi di ciascun utente.
 *
 * Ogni cambiamento porta con sé `activeSceneId` al momento in cui avviene,
 * così il filtro non ha bisogno di consultare lo stato.
 */
export type StateChange =
  | { type: "token"; before: Token | null; after: Token | null; activeSceneId: string | null }
  | { type: "scene"; before: Scene | null; after: Scene | null; activeSceneId: string | null }
  | {
      type: "activeScene";
      before: string | null;
      after: string | null;
      /** Scena diventata attiva e i suoi token (completi), per costruire la vista dei giocatori. */
      scene: Scene | null;
      tokens: Token[];
    };
