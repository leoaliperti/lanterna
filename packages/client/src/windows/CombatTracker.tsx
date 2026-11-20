import { ChevronLeft, ChevronRight, EyeOff, Swords } from "lucide-react";
import type { CampaignView, CombatView } from "@lanterna/shared";
import { Button } from "../ui";
import { EmptyState } from "../screens/EmptyState";
import { useCommands } from "../realtime/RealtimeProvider";
import "./windows.css";

/** Combattimento da mostrare: quello della scena indicata, altrimenti quello della scena attiva, altrimenti il primo. */
export function combatToShow(view: CampaignView, sceneId: string | null = null): CombatView | null {
  const combats = view.combats ?? [];
  return (
    (sceneId ? combats.find((c) => c.sceneId === sceneId) : undefined) ??
    combats.find((c) => c.sceneId === view.activeSceneId) ??
    combats[0] ??
    null
  );
}

export interface CombatTrackerProps {
  view: CampaignView;
  /** Avanti/indietro (solo GM, e mai in sola lettura). Il server verifica comunque. */
  canControl: boolean;
}

/**
 * Tracker dell'iniziativa per una finestra a parte (M9). Mostra esattamente cio' che il server ha
 * inviato: il giocatore riceve gia' il tracker filtrato (voci nascoste assenti, iniziativa nascosta = null).
 */
export function CombatTracker({ view, canControl }: CombatTrackerProps) {
  const { run } = useCommands();
  const combat = combatToShow(view);
  if (!combat || combat.participants.length === 0) {
    return <EmptyState icon={<Swords size={36} />} title="Nessun combattimento" description="Quando il GM avvia un combattimento, l'ordine dei turni compare qui." />;
  }
  const scene = view.scenes.find((s) => s.id === combat.sceneId);
  const current = combat.participants.find((p) => p.id === combat.turnId);
  return (
    <section className="w-combat" aria-label="Ordine dei turni">
      <div className="w-combat__head">
        <div>
          <h2 className="w-combat__round t-title2">{combat.started ? `Round ${combat.round}` : "In preparazione"}</h2>
          <p className="a-muted t-footnote">
            {scene ? scene.name : "Scena"}
            {current ? ` · di turno: ${current.name}` : ""}
          </p>
        </div>
        {canControl && combat.started ? (
          <div className="w-combat__nav">
            <Button variant="gray" size="sm" icon={<ChevronLeft size={16} />} onClick={() => void run({ type: "combat.previous", sceneId: combat.sceneId })}>
              Indietro
            </Button>
            <Button size="sm" icon={<ChevronRight size={16} />} onClick={() => void run({ type: "combat.next", sceneId: combat.sceneId })}>
              Turno successivo
            </Button>
          </div>
        ) : null}
      </div>
      <ol className="w-combat__list">
        {combat.participants.map((p) => {
          const active = p.id === combat.turnId;
          return (
            <li key={p.id} className="w-combat__row" aria-current={active ? "true" : undefined}>
              <span className="w-combat__init t-headline" aria-label={p.initiative === null ? "Iniziativa non nota" : `Iniziativa ${p.initiative}`}>
                {p.initiative ?? "–"}
              </span>
              <span className="w-combat__name t-body">{p.name}</span>
              <span className="w-combat__tag t-caption1">
                {active ? "Di turno" : null}
                {p.hidden ? (
                  <span title="Nascosto ai giocatori">
                    <EyeOff size={14} aria-label="Nascosto ai giocatori" />
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
