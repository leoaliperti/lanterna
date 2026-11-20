import { Sheet } from "../ui";
import { SHORTCUTS, keyLabel } from "./shortcutRegistry";

/** Finestra di aiuto con tutte le scorciatoie del registro, per gruppo. I tasti a lettera valgono con il focus sulla mappa. */
export function ShortcutsHelp({ open, onOpenChange, isGm }: { open: boolean; onOpenChange: (open: boolean) => void; isGm: boolean }) {
  const visible = SHORTCUTS.filter((s) => isGm || (s.scope !== "gm" && s.scope !== "selection"));
  const groups = [...new Set(visible.map((s) => s.group))];
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Scorciatoie da tastiera">
      <div className="a-shortcuts">
        {groups.map((g) => (
          <section key={g} aria-label={g}>
            <h3 className="t-footnote a-muted a-shortcuts__group">{g}</h3>
            <dl className="a-shortcuts__list">
              {visible
                .filter((s) => s.group === g)
                .map((s) => (
                  <div key={s.id} className="a-shortcuts__row">
                    <dt>{s.label}</dt>
                    <dd>
                      {s.keys.map((k) => (
                        <kbd key={k} className="a-kbd">
                          {keyLabel(k)}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
        <p className="t-caption1 a-muted">Le lettere funzionano con il focus sulla mappa e fuori dai campi di testo.</p>
      </div>
    </Sheet>
  );
}
