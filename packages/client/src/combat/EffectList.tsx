import { Hourglass, Plus, Trash2 } from "lucide-react";
import type { CampaignView, EffectView, TokenView } from "@lanterna/shared";
import { Badge, Button, IconButton } from "../ui";
import { useCommands } from "../realtime/RealtimeProvider";
import { ConditionIcon } from "../table/conditions";
import { conditionName, describeDuration, visibleEffects } from "./effectsLogic";
import "./combat.css";

export interface EffectListProps {
  token: TokenView;
  view: CampaignView;
  /** Solo GM: aggiungere e togliere effetti. */
  canEdit: boolean;
  onAdd?: () => void;
}

/** Elenco degli effetti temporanei di un token con la durata residua. I segreti li riceve (e vede) solo il GM. */
export function EffectList({ token, view, canEdit, onAdd }: EffectListProps) {
  const { run } = useCommands();
  const effects = visibleEffects(token);
  const nameOf = (id: string | null | undefined) => (id ? (view.tokens.find((t) => t.id === id)?.name ?? "token rimosso") : null);
  if (effects.length === 0 && !canEdit) return null;
  return (
    <section className="c-effects" aria-label={`Effetti su ${token.name}`}>
      <div className="c-effects__head">
        <h3 className="t-footnote a-muted c-effects__title">Effetti temporanei</h3>
        {canEdit ? (
          <Button size="sm" variant="gray" icon={<Plus size={16} />} onClick={onAdd}>
            Aggiungi effetto
          </Button>
        ) : null}
      </div>
      {effects.length === 0 ? <p className="t-footnote a-muted">Nessun effetto attivo.</p> : null}
      <ul className="c-effects__list">
        {effects.map((e) => (
          <EffectRow key={e.id} effect={e} anchor={nameOf(e.turnOf)} canEdit={canEdit} onRemove={() => void run({ type: "effect.remove", tokenId: token.id, effectId: e.id })} />
        ))}
      </ul>
    </section>
  );
}

function EffectRow({ effect, anchor, canEdit, onRemove }: { effect: EffectView; anchor: string | null; canEdit: boolean; onRemove: () => void }) {
  return (
    <li className="c-effect">
      <span className="c-effect__icon" aria-hidden="true">
        {effect.condition ? <ConditionIcon id={effect.condition.id} size={18} /> : <Hourglass size={18} aria-hidden="true" />}
      </span>
      <span className="c-effect__text">
        <span className="t-subhead c-effect__name">
          {effect.name}
          {effect.secret ? (
            <>
              {" "}
              <Badge tone="orange">Segreto</Badge>
            </>
          ) : null}
        </span>
        <span className="t-caption1 a-muted">
          {describeDuration(effect)}
          {effect.condition ? `, condizione: ${conditionName(effect.condition.id)}` : ""}
          {anchor ? `, turno di ${anchor}` : ""}
        </span>
      </span>
      {canEdit ? <IconButton label={`Togli l'effetto ${effect.name}`} variant="plain" icon={<Trash2 size={18} />} onClick={onRemove} /> : null}
    </li>
  );
}
