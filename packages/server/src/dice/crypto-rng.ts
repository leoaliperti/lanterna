import { randomInt as nodeRandomInt } from "node:crypto";
import type { RandomInt } from "@lanterna/shared";

/**
 * Intero uniforme in [0, maxExclusive) basato su `crypto.randomInt` di Node.
 * Usa il campionamento a rifiuto, quindi non c'è bias di modulo.
 * Il server lo passa al roller: il client non sceglie mai l'esito.
 */
export const randomInt: RandomInt = (maxExclusive) => nodeRandomInt(maxExclusive);
