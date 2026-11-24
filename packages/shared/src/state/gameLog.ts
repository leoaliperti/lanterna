import type { Combat } from "./combat.js";
import type { StateChange } from "./changes.js";
import type { Token } from "./schema.js";

/**
 * Registro di gioco (solo GM): frasi in italiano che descrivono ciò che un comando ha cambiato. Lavora sui
 * `StateChange` già calcolati dal reducer, quindi non può dire più di quanto il server ha davvero fatto.
 * Le frasi usano nomi e numeri dello stato: niente id interni.
 */

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

function describeToken(before: Token | null, after: Token | null): string[] {
  if (!before && after) return [`Token «${after.name}» aggiunto`];
  if (before && !after) return [`Token «${before.name}» rimosso`];
  if (!before || !after) return [];
  const parts: string[] = [];
  if (before.x !== after.x || before.y !== after.y) parts.push("spostato");
  if (before.health && after.health && before.health.current !== after.health.current) {
    parts.push(`PF ${before.health.current} → ${after.health.current}`);
  } else if (!before.health && after.health) {
    parts.push(`PF ${after.health.current}/${after.health.max}`);
  }
  if (before.hidden !== after.hidden) parts.push(after.hidden ? "nascosto" : "rivelato");
  if (before.name !== after.name) parts.push(`rinominato in «${after.name}»`);
  const condBefore = before.conditions.map((c) => c.name).join(", ");
  const condAfter = after.conditions.map((c) => c.name).join(", ");
  if (condBefore !== condAfter) parts.push(`condizioni: ${condAfter || "nessuna"}`);
  if (parts.length === 0) parts.push("modificato");
  return [`${after.name}: ${parts.join(", ")}`];
}

function describeCombat(c: Extract<StateChange, { type: "combat" }>): string {
  const after: Combat | null = c.after;
  if (!after) return "Combattimento concluso";
  const turnName = after.turnId ? c.tokensAfter.find((t) => t.id === after.turnId)?.name : undefined;
  if (!c.before?.started && after.started) return `Combattimento iniziato (round ${after.round})`;
  if (c.before && c.before.round !== after.round) return `Round ${after.round}${turnName ? `, turno di ${turnName}` : ""}`;
  if (turnName && c.before?.turnId !== after.turnId) return `Turno di ${turnName}`;
  return "Combattimento aggiornato";
}

/** Frasi del registro per un insieme di cambiamenti (le notifiche private non entrano nel registro). */
export function describeChanges(changes: readonly StateChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    switch (c.type) {
      case "token":
        out.push(...describeToken(c.before, c.after));
        break;
      case "scene":
        if (!c.before && c.after) out.push(`Scena «${c.after.name}» creata`);
        else if (c.before && !c.after) out.push(`Scena «${c.before.name}» eliminata`);
        else if (c.after) out.push(`Scena «${c.after.name}» modificata`);
        break;
      case "activeScene":
        out.push(`Scena attiva: ${c.scene?.name ?? "nessuna"}`);
        break;
      case "clock":
        out.push(`Orologio: giorno ${c.after.day}, ${hhmm(c.after.minute)}`);
        break;
      case "combat":
        out.push(describeCombat(c));
        break;
      case "fog":
        out.push("Nebbia di guerra aggiornata");
        break;
      case "wall":
        out.push("Muri aggiornati");
        break;
      case "prop":
        out.push("Oggetto di scena aggiornato");
        break;
      case "group":
        out.push(c.after ? "Gruppo di token aggiornato" : "Gruppo di token sciolto");
        break;
      case "notice":
        break;
    }
  }
  return out;
}
