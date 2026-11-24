import { ABILITY_LABEL, SKILL_LABEL } from "../sheets/sheetLogic";

/** Etichette italiane delle sorgenti del modulo (quelle che il GM vede quando sceglie un campo). */
const FIXED: Record<string, string> = {
  name: "Nome personaggio",
  class: "Classe e livello",
  level: "Livello",
  prof: "Bonus di competenza",
  playerName: "Nome giocatore",
  race: "Razza",
  background: "Background",
  alignment: "Allineamento",
  experience: "Punti esperienza",
  inspiration: "Ispirazione",
  ac: "Classe armatura",
  initiative: "Iniziativa",
  speed: "Velocità",
  passive: "Percezione passiva",
  "hp.max": "Punti ferita massimi",
  "hp.current": "Punti ferita attuali",
  "hp.temp": "Punti ferita temporanei",
  hitDice: "Dadi vita",
  traits: "Tratti caratteriali",
  ideals: "Ideali",
  bonds: "Legami",
  flaws: "Difetti",
  story: "Storia del personaggio",
  languages: "Altre competenze e linguaggi",
  features: "Privilegi e tratti",
};

const ABILITY_PART: Record<string, string> = {
  score: "punteggio",
  mod: "modificatore",
  save: "tiro salvezza",
  saveProf: "competenza nel tiro salvezza",
};

const ATTACK_PART: Record<string, string> = {
  name: "nome",
  bonus: "bonus di attacco",
  damage: "danno",
  type: "tipo di danno",
};

/** Etichetta leggibile di una sorgente; per un id sconosciuto torna l'id stesso. */
export function sourceLabel(source: string): string {
  const fixed = FIXED[source];
  if (fixed) return fixed;

  const ability = /^(str|dex|con|int|wis|cha)\.(score|mod|save|saveProf)$/.exec(source);
  if (ability) {
    const who = ABILITY_LABEL[ability[1] as keyof typeof ABILITY_LABEL];
    return `${who} · ${ABILITY_PART[ability[2] ?? ""] ?? ability[2]}`;
  }

  const skill = /^([a-z]+)\.(prof|bonus)$/.exec(source);
  if (skill && skill[1] && skill[1] in SKILL_LABEL) {
    const name = SKILL_LABEL[skill[1] as keyof typeof SKILL_LABEL];
    return skill[2] === "prof" ? `${name} · competenza` : `${name} · bonus`;
  }

  const death = /^death\.(successes|failures)#(\d)$/.exec(source);
  if (death) {
    return `Tiro contro la morte, ${death[1] === "successes" ? "successo" : "fallimento"} ${death[2]}`;
  }

  const attack = /^attack\.(\d+)\.(name|bonus|damage|type)$/.exec(source);
  if (attack) return `Attacco ${Number(attack[1]) + 1} · ${ATTACK_PART[attack[2] ?? ""] ?? attack[2]}`;

  return source;
}
