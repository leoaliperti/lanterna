import { ChevronLeft, ChevronRight, Play } from "lucide-react";
import type { CampaignView } from "@lanterna/shared";
import { useCommands } from "../realtime/RealtimeProvider";
import { Badge, Button, IconButton } from "../ui";
import { combatOf, statusLine, turnTokenId } from "./combatLogic";

export interface CombatModeBarProps {
  view: CampaignView;
  sceneId: string;
  isGm: boolean;
}

/**
 * Barra della modalità combattimento, sempre visibile in alto mentre è attiva: round, turno corrente e, per il GM,
 * avanti/indietro. Usa gli stessi comandi del pannello Iniziativa (`combat.start/next/previous`).
 */
export function CombatModeBar({ view, sceneId, isGm }: CombatModeBarProps) {
  const { run } = useCommands();
  const combat = combatOf(view, sceneId);
  const count = combat?.participants.length ?? 0;

  if (!combat?.started) {
    return (
      <div className="c-mode-bar" role="status">
        <span className="t-subhead">{count === 0 ? "Nessun partecipante: aggiungili dal pannello Iniziativa." : "Combattimento non avviato."}</span>
        {isGm && count > 0 ? (
          <Button size="sm" icon={<Play size={16} />} onClick={() => void run({ type: "combat.start", sceneId, sort: true })}>
            Avvia
          </Button>
        ) : null}
      </div>
    );
  }

  const turnId = turnTokenId(combat);
  const turnName = view.tokens.find((t) => t.id === turnId)?.name;
  return (
    <div className="c-mode-bar" role="status" aria-live="polite">
      <Badge tone="tint">Round {combat.round}</Badge>
      <strong>{turnName ? `Turno di ${turnName}` : statusLine(combat)}</strong>
      {isGm ? (
        <>
          <IconButton label="Turno precedente" icon={<ChevronLeft size={16} />} onClick={() => void run({ type: "combat.previous", sceneId })} />
          <IconButton label="Turno successivo" icon={<ChevronRight size={16} />} onClick={() => void run({ type: "combat.next", sceneId })} />
        </>
      ) : null}
    </div>
  );
}
