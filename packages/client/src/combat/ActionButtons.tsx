import type { ReactNode } from "react";
import { Heart, Hourglass, Move, ShieldPlus, Sparkles, Sword } from "lucide-react";
import { Button } from "../ui";
import { ACTION_KEYS, ACTION_LABELS, type ActionKind } from "./selectionLogic";

const ICONS: Record<ActionKind, ReactNode> = {
  damage: <Sword size={16} />,
  heal: <Heart size={16} />,
  tempHp: <ShieldPlus size={16} />,
  condition: <Sparkles size={16} />,
  effect: <Hourglass size={16} />,
  move: <Move size={16} />
};

const ORDER: ActionKind[] = ["damage", "heal", "tempHp", "condition", "effect", "move"];

function keyOf(kind: ActionKind): string | null {
  const found = Object.entries(ACTION_KEYS).find(([, k]) => k === kind);
  return found ? found[0].toUpperCase() : null;
}

/** Le azioni rapide sulla selezione. La lettera in nome accessibile e' la scorciatoia da tastiera (con il focus sulla mappa). */
export function ActionButtons({ onAction, disabled }: { onAction: (kind: ActionKind) => void; disabled?: boolean }) {
  return (
    <div className="c-actions" role="group" aria-label="Azioni sui token selezionati">
      {ORDER.map((kind) => {
        const key = keyOf(kind);
        return (
          <Button key={kind} size="sm" variant="gray" icon={ICONS[kind]} disabled={disabled} aria-keyshortcuts={key ?? undefined} onClick={() => onAction(kind)}>
            {ACTION_LABELS[kind]}
          </Button>
        );
      })}
    </div>
  );
}
