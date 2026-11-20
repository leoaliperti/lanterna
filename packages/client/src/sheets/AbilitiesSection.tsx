import { Dices } from "lucide-react";
import { ABILITIES, SKILLS, type Skill } from "@lanterna/shared";
import { Badge, List, ListRow, Toggle } from "../ui";
import { EmptyState } from "../screens/EmptyState";
import { bonusLabel, type SectionProps } from "./fields";
import { ABILITY_LABEL, ABILITY_SHORT, PROFICIENCY_LABEL, SKILL_LABEL, matchesQuery, modeNote, patchSheet, signed } from "./sheetLogic";

/** Caratteristiche, modificatori e tiri salvezza. Un clic sul modificatore tira la prova, sul salvataggio il tiro salvezza. */
export function AbilitiesSection({ doc, derived, roller, change, query }: SectionProps) {
  const shown = ABILITIES.filter((a) => matchesQuery(query, ABILITY_LABEL[a], ABILITY_SHORT[a], "tiro salvezza prova"));
  return (
    <div className="s-stack">
      <ul className="s-facts" aria-label="Valori principali">
        <li>
          <span className="t-caption1 a-muted">Livello</span>
          <strong className="t-title3">{derived.level}</strong>
        </li>
        <li>
          <span className="t-caption1 a-muted">Competenza</span>
          <strong className="t-title3">{signed(derived.proficiencyBonus)}</strong>
        </li>
        <li>
          <span className="t-caption1 a-muted">Velocità</span>
          <strong className="t-title3">{derived.speed} ft</strong>
        </li>
        <li>
          <span className="t-caption1 a-muted">Percezione passiva</span>
          <strong className="t-title3">{derived.passivePerception}</strong>
        </li>
      </ul>
      <Toggle
        label="Ispirazione eroica"
        checked={doc.sheet.heroicInspiration}
        onCheckedChange={(v) => change((d) => patchSheet(d, { heroicInspiration: v }))}
      />
      {shown.length === 0 ? (
        <EmptyState icon={<Dices size={28} />} title="Nessuna caratteristica" description="Nessuna caratteristica corrisponde alla ricerca." />
      ) : (
        <ul className="s-abilities" aria-label="Caratteristiche">
          {shown.map((a) => {
            const d = derived.abilities[a];
            const noteCheck = modeNote(d.check);
            const noteSave = modeNote(d.save);
            return (
              <li key={a} className="s-ability">
                <button
                  type="button"
                  className="s-ability__main"
                  onClick={() => void roller.rollTarget({ kind: "check", ability: a }, `Prova di ${ABILITY_LABEL[a]}`)}
                  aria-label={`Prova di ${ABILITY_LABEL[a]}, modificatore ${bonusLabel(d.check)}. Tira`}
                >
                  <span className="t-caption1 a-muted">{ABILITY_LABEL[a]}</span>
                  <strong className="s-ability__mod">{signed(d.modifier)}</strong>
                  <span className="t-footnote a-muted">{d.score}</span>
                  {noteCheck ? <Badge tone={d.check.advantage ? "green" : "orange"}>{noteCheck}</Badge> : null}
                </button>
                <button
                  type="button"
                  className="s-ability__save"
                  onClick={() => void roller.rollTarget({ kind: "save", ability: a }, `Tiro salvezza di ${ABILITY_LABEL[a]}`)}
                  aria-label={`Tiro salvezza di ${ABILITY_LABEL[a]}, ${bonusLabel(d.save)}${d.save.proficient ? ", competente" : ""}. Tira`}
                >
                  <span className="t-footnote">Salvezza{d.save.proficient ? " •" : ""}</span>
                  <strong>{d.save.autoFail ? "Fallisce" : signed(d.save.modifier)}</strong>
                  {noteSave ? <span className="t-caption2 a-muted">{noteSave}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Abilità con competenza e maestria. Un clic tira la prova con il vantaggio/svantaggio delle condizioni. */
export function SkillsSection({ derived, roller, query }: SectionProps) {
  const list = (SKILLS as readonly Skill[])
    .filter((s) => matchesQuery(query, SKILL_LABEL[s], ABILITY_LABEL[derived.skills[s].ability], ABILITY_SHORT[derived.skills[s].ability], PROFICIENCY_LABEL[derived.skills[s].proficiency]))
    .sort((a, b) => SKILL_LABEL[a].localeCompare(SKILL_LABEL[b], "it"));
  if (list.length === 0) {
    return <EmptyState icon={<Dices size={28} />} title="Nessuna abilità" description="Nessuna abilità corrisponde alla ricerca." />;
  }
  return (
    <List aria-label="Abilità" footer="Tocca un'abilità per tirare. Il vantaggio o lo svantaggio vengono dalle condizioni.">
      {list.map((s) => {
        const sk = derived.skills[s];
        const note = modeNote(sk.roll);
        return (
          <ListRow
            key={s}
            title={SKILL_LABEL[s]}
            subtitle={`${ABILITY_SHORT[sk.ability]} · ${PROFICIENCY_LABEL[sk.proficiency]}${note ? ` · ${note}` : ""}`}
            trailing={<strong>{signed(sk.roll.modifier)}</strong>}
            onPress={() => void roller.rollTarget({ kind: "skill", skill: s }, SKILL_LABEL[s])}
          />
        );
      })}
    </List>
  );
}
