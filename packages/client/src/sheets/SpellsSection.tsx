import { useState } from "react";
import { BookOpen, Minus, Plus, Trash2, WandSparkles } from "lucide-react";
import { spendPactSlot, type SheetSpell } from "@lanterna/shared";
import { Badge, Button, IconButton, List, ListRow, Menu, Picker, TextField } from "../ui";
import { EmptyState } from "../screens/EmptyState";
import { bonusLabel, type SectionProps } from "./fields";
import { spellFromContent } from "./fromContent";
import { LibraryPicker } from "./LibraryPicker";
import { applySheetOp, matchesQuery, newId, signed } from "./sheetLogic";

/** Incantesimi e slot: slot per livello, CD e attacco, elenco con ricerca e aggiunta dalla libreria importata. */
export function SpellsSection({ doc, derived, roller, change, query }: SectionProps) {
  const [mode, setMode] = useState<"none" | "library" | "manual">("none");
  const [name, setName] = useState("");
  const [level, setLevel] = useState(1);

  const spells = doc.extras.spells.filter((s) => matchesQuery(query, s.name, `livello ${s.level}`, s.notes));
  const levels = [...new Set(spells.map((s) => s.level))].sort((a, b) => a - b);
  const slotLevels = derived.spellSlots.map((n, i) => ({ level: i + 1, total: n, left: derived.spellSlotsRemaining[i] ?? 0 })).filter((s) => s.total > 0);

  const setSpent = (lvl: number, delta: number) =>
    change((d) => {
      const slotsSpent = [...d.sheet.slotsSpent];
      const total = derived.spellSlots[lvl - 1] ?? 0;
      slotsSpent[lvl - 1] = Math.max(0, Math.min(total, (slotsSpent[lvl - 1] ?? 0) + delta));
      return { ...d, sheet: { ...d.sheet, slotsSpent } };
    });

  const add = (spell: SheetSpell) => change((d) => ({ ...d, extras: { ...d.extras, spells: [...d.extras.spells, spell] } }));
  const patchSpell = (id: string, patch: Partial<SheetSpell>) =>
    change((d) => ({ ...d, extras: { ...d.extras, spells: d.extras.spells.map((s) => (s.id === id ? { ...s, ...patch } : s)) } }));

  return (
    <div className="s-stack">
      {derived.spellcasting.length > 0 ? (
        <ul className="s-facts" aria-label="Magia">
          {derived.spellcasting.map((c) => (
            <li key={c.classId}>
              <span className="t-caption1 a-muted">CD ({c.classId})</span>
              <strong className="t-title3">{c.saveDc}</strong>
              <Button
                size="sm"
                variant="tinted"
                onClick={() => void roller.rollTarget({ kind: "spellAttack", classId: c.classId }, `Attacco con incantesimo (${c.classId})`)}
                aria-label={`Attacco con incantesimo ${bonusLabel(c.attack)}. Tira`}
              >
                Attacco {signed(c.attack.modifier)}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="t-footnote a-muted">Nessuna classe di questa scheda lancia incantesimi. Imposta il tipo di incantatore in Modifica.</p>
      )}

      {slotLevels.length > 0 || derived.pact ? (
        <section className="s-block" aria-labelledby="s-slots">
          <h3 id="s-slots" className="t-headline">
            Slot incantesimo
          </h3>
          <ul className="s-list">
            {slotLevels.map((s) => (
              <li key={s.level} className="s-row">
                <span className="s-row__grow">
                  Livello {s.level}: {s.left} su {s.total}
                </span>
                <IconButton label={`Spendi uno slot di livello ${s.level}`} icon={<Minus size={16} />} disabled={s.left <= 0} onClick={() => setSpent(s.level, 1)} />
                <IconButton label={`Recupera uno slot di livello ${s.level}`} icon={<Plus size={16} />} disabled={s.left >= s.total} onClick={() => setSpent(s.level, -1)} />
              </li>
            ))}
            {derived.pact ? (
              <li className="s-row">
                <span className="s-row__grow">
                  Slot del patto (livello {derived.pact.slotLevel}): {derived.pact.remaining} su {derived.pact.count}
                </span>
                <IconButton
                  label="Spendi uno slot del patto"
                  icon={<Minus size={16} />}
                  disabled={derived.pact.remaining <= 0}
                  onClick={() => change((d) => applySheetOp(d, (s, c) => spendPactSlot(s, c)))}
                />
                <IconButton
                  label="Recupera uno slot del patto"
                  icon={<Plus size={16} />}
                  disabled={derived.pact.remaining >= derived.pact.count}
                  onClick={() => change((d) => ({ ...d, sheet: { ...d.sheet, pactSlotsSpent: Math.max(0, d.sheet.pactSlotsSpent - 1) } }))}
                />
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <section className="s-block" aria-labelledby="s-spells">
        <h3 id="s-spells" className="t-headline">
          <BookOpen size={16} aria-hidden="true" /> Incantesimi
        </h3>
        {spells.length === 0 ? (
          <EmptyState
            icon={<WandSparkles size={28} />}
            title={doc.extras.spells.length === 0 ? "Nessun incantesimo" : "Nessun risultato"}
            description={doc.extras.spells.length === 0 ? "Aggiungili dalla libreria importata o a mano." : "Nessun incantesimo corrisponde alla ricerca."}
          />
        ) : (
          levels.map((lvl) => (
            <List key={lvl} header={lvl === 0 ? "Trucchetti" : `Livello ${lvl}`}>
              {spells
                .filter((s) => s.level === lvl)
                .map((s) => {
                  const castable = slotLevels.filter((sl) => sl.level >= s.level && sl.left > 0);
                  return (
                    <ListRow
                      key={s.id}
                      title={s.name}
                      subtitle={s.notes ? s.notes.slice(0, 120) : undefined}
                      trailing={
                        <span className="s-row">
                          {s.prepared ? <Badge tone="green">Preparato</Badge> : null}
                          {s.level > 0 ? (
                            <Menu
                              label={`Lancia ${s.name}`}
                              placement="bottom-end"
                              items={
                                castable.length > 0
                                  ? castable.map((sl) => ({ id: `l${sl.level}`, label: `Slot di livello ${sl.level} (${sl.left} rimasti)`, onSelect: () => setSpent(sl.level, 1) }))
                                  : [{ id: "none", label: "Nessuno slot disponibile", onSelect: () => undefined }]
                              }
                              trigger={
                                <Button size="sm" variant="tinted" disabled={castable.length === 0}>
                                  Lancia
                                </Button>
                              }
                            />
                          ) : null}
                          <IconButton label={s.prepared ? `Non preparare ${s.name}` : `Prepara ${s.name}`} icon={<BookOpen size={16} />} aria-pressed={s.prepared} onClick={() => patchSpell(s.id, { prepared: !s.prepared })} />
                          <IconButton
                            label={`Rimuovi ${s.name}`}
                            icon={<Trash2 size={16} />}
                            onClick={() => change((d) => ({ ...d, extras: { ...d.extras, spells: d.extras.spells.filter((x) => x.id !== s.id) } }))}
                          />
                        </span>
                      }
                    />
                  );
                })}
            </List>
          ))
        )}

        <div className="s-actions">
          <Button variant="gray" size="sm" icon={<BookOpen size={16} />} onClick={() => setMode(mode === "library" ? "none" : "library")} aria-expanded={mode === "library"}>
            Dalla libreria
          </Button>
          <Button variant="gray" size="sm" icon={<Plus size={16} />} onClick={() => setMode(mode === "manual" ? "none" : "manual")} aria-expanded={mode === "manual"}>
            A mano
          </Button>
        </div>
        {mode === "library" ? <LibraryPicker kind="spell" onPick={(d) => add(spellFromContent(d))} /> : null}
        {mode === "manual" ? (
          <form
            className="s-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              add({ id: newId(), name: name.trim(), level, prepared: false, notes: "" });
              setName("");
            }}
          >
            <TextField label="Nome dell'incantesimo" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
            <Picker
              label="Livello"
              value={String(level)}
              onValueChange={(v) => setLevel(Number(v))}
              options={Array.from({ length: 10 }, (_, i) => ({ value: String(i), label: i === 0 ? "Trucchetto" : `Livello ${i}` }))}
            />
            <Button type="submit" size="sm">
              Aggiungi
            </Button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
