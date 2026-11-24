/** Punti ferita, danno, cura, morte e tiri salvezza contro la morte. Funzioni pure. */

export type HitDie = 4 | 6 | 8 | 10 | 12 | 20;

export interface DeathSaves {
  successes: number;
  failures: number;
}

export interface HpState {
  current: number;
  max: number;
  temp: number;
  deathSaves: DeathSaves;
  /** A 0 PF ma stabilizzato (non tira piu). */
  stable: boolean;
  dead: boolean;
  /**
   * Danno pari o superiore ai PF massimi: morte istantanea possibile. NON la applica il sistema:
   * la decide il GM (`decideInstantDeath`). Finché è vero, il personaggio è a 0 PF.
   */
  instantDeathPending?: boolean;
}

export function newHpState(max: number): HpState {
  return {
    current: max,
    max,
    temp: 0,
    deathSaves: { successes: 0, failures: 0 },
    stable: false,
    dead: false,
  };
}

/** Valore medio fisso di un dado vita: meta + 1. */
export function averageHitDie(die: number): number {
  return Math.floor(die / 2) + 1;
}

export interface MaxHpOptions {
  /** Tiri effettivi per livello (indice 0 = livello 1, ignorato: il primo livello e sempre il massimo). */
  rolls?: readonly (number | undefined)[];
  /** Bonus per livello (es. contenuti che aggiungono PF a ogni livello). */
  bonusPerLevel?: number;
}

/**
 * PF massimi. `hitDice` ha un dado per livello di personaggio, in ordine di acquisizione.
 * Primo livello: dado al massimo + Cos. Altri: tiro (se fornito) o media fissa + Cos.
 * Ogni livello fa guadagnare almeno 1 PF.
 */
export function maxHitPoints(
  hitDice: readonly number[],
  conMod: number,
  opts: MaxHpOptions = {},
): number {
  let total = 0;
  hitDice.forEach((die, i) => {
    const base = i === 0 ? die : (opts.rolls?.[i] ?? averageHitDie(die));
    total += Math.max(1, base + conMod + (opts.bonusPerLevel ?? 0));
  });
  return total;
}

export function isDown(hp: HpState): boolean {
  return hp.current === 0 && !hp.dead;
}

export interface DamageOptions {
  /** Colpo critico subito a 0 PF: due fallimenti invece di uno. */
  critical?: boolean;
}

/** Applica danno: prima i PF temporanei, poi i PF; morte istantanea se il resto >= PF massimi. */
export function applyDamage(hp: HpState, amount: number, opts: DamageOptions = {}): HpState {
  const dmg = Math.max(0, Math.trunc(amount));
  if (hp.dead || dmg === 0) return { ...hp };
  const next: HpState = { ...hp, deathSaves: { ...hp.deathSaves } };

  if (hp.current === 0) {
    // Gia a terra: il danno e un fallimento (due se critico); il danno >= max uccide.
    if (dmg >= hp.max) return { ...next, stable: false, instantDeathPending: true };
    next.stable = false;
    next.deathSaves.failures = Math.min(3, next.deathSaves.failures + (opts.critical ? 2 : 1));
    if (next.deathSaves.failures >= 3) next.dead = true;
    return next;
  }

  const absorbed = Math.min(next.temp, dmg);
  next.temp -= absorbed;
  const rest = dmg - absorbed;
  if (rest >= next.current) {
    const overflow = rest - next.current;
    next.current = 0;
    next.deathSaves = { successes: 0, failures: 0 };
    next.stable = false;
    if (overflow >= next.max) next.instantDeathPending = true;
  } else {
    next.current -= rest;
  }
  return next;
}

/** Cura: non oltre il massimo; chi era a 0 si rialza e azzera i tiri contro la morte. Non cura i morti. */
export function heal(hp: HpState, amount: number): HpState {
  const n = Math.max(0, Math.trunc(amount));
  if (hp.dead || n === 0) return { ...hp };
  return {
    ...hp,
    current: Math.min(hp.max, hp.current + n),
    deathSaves: { successes: 0, failures: 0 },
    stable: false,
    instantDeathPending: false,
  };
}

/** Il GM decide la morte istantanea: `dead` vero = morto, falso = resta a 0 PF (a terra). */
export function decideInstantDeath(hp: HpState, dead: boolean): HpState {
  if (!hp.instantDeathPending) return { ...hp };
  return dead
    ? { ...hp, dead: true, stable: false, instantDeathPending: false }
    : { ...hp, instantDeathPending: false };
}

/**
 * Azzera lo stato di morte (morto, stabile, tiri contro la morte, morte istantanea in sospeso).
 * Serve a sbloccare la barra della vita dopo un errore di conteggio: il morto non si cura.
 */
export function resetDeath(hp: HpState): HpState {
  return { ...hp, dead: false, stable: false, instantDeathPending: false, deathSaves: { successes: 0, failures: 0 } };
}

/** PF temporanei: non si sommano, si tiene il valore piu alto. */
export function grantTempHp(hp: HpState, amount: number): HpState {
  return { ...hp, temp: Math.max(hp.temp, Math.max(0, Math.trunc(amount))) };
}

/** Stabilizzazione: a 0 PF, non morto; azzera i tiri contro la morte. */
export function stabilize(hp: HpState): HpState {
  if (hp.dead || hp.current !== 0) return { ...hp };
  return { ...hp, stable: true, deathSaves: { successes: 0, failures: 0 } };
}

/**
 * Tiro salvezza contro la morte con il risultato naturale del d20.
 * 20: si torna a 1 PF. 10-19: successo. 2-9: fallimento. 1: due fallimenti.
 * Tre successi: stabile. Tre fallimenti: morto. Il bonus (es. Esaurimento) va applicato
 * dal chiamante sul totale; qui conta il risultato naturale per le regole speciali.
 */
export function deathSave(hp: HpState, naturalRoll: number, total: number = naturalRoll): HpState {
  if (hp.dead || hp.current !== 0 || hp.stable) return { ...hp };
  if (naturalRoll === 20) {
    return { ...hp, current: 1, deathSaves: { successes: 0, failures: 0 }, stable: false };
  }
  const next: HpState = { ...hp, deathSaves: { ...hp.deathSaves } };
  if (naturalRoll === 1) next.deathSaves.failures += 2;
  else if (total >= 10) next.deathSaves.successes += 1;
  else next.deathSaves.failures += 1;
  next.deathSaves.failures = Math.min(3, next.deathSaves.failures);
  if (next.deathSaves.failures >= 3) next.dead = true;
  else if (next.deathSaves.successes >= 3) {
    next.stable = true;
    next.deathSaves = { successes: 0, failures: 0 };
  }
  return next;
}
