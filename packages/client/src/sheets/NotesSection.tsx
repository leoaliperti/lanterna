import { TextArea } from "../ui";
import type { SectionProps } from "./fields";

/** Note libere e, per i mostri, il testo dello statblock (azioni e tratti copiati dalla libreria o scritti a mano). */
export function NotesSection({ doc, kind, change }: SectionProps) {
  return (
    <div className="s-stack">
      {kind === "monster" ? (
        <TextArea
          label="Statblock (tratti, azioni)"
          value={doc.extras.statblockText}
          rows={10}
          maxLength={20000}
          onChange={(e) => change((d) => ({ ...d, extras: { ...d.extras, statblockText: e.target.value } }))}
        />
      ) : null}
      <TextArea
        label="Note"
        value={doc.extras.notes}
        rows={10}
        maxLength={20000}
        onChange={(e) => change((d) => ({ ...d, extras: { ...d.extras, notes: e.target.value } }))}
      />
    </div>
  );
}
