import { useMemo, useState } from "react";
import { EyeOff, Plus, Users } from "lucide-react";
import type { CampaignView, TokenView } from "@lanterna/shared";
import { Avatar, Badge, Button, List, ListRow, SearchField, SegmentedControl } from "../ui";
import { assetUrl } from "../realtime/urls";
import { EmptyState } from "../screens/EmptyState";
import { ConditionIcon } from "./conditions";
import { permissionsFor } from "./permissions";

export type TokenFilter = "all" | "pc" | "monster" | "object";

const KIND_LABEL: Record<TokenView["kind"], string> = { pc: "Personaggio", monster: "Mostro", object: "Oggetto" };

export function filterTokens(tokens: readonly TokenView[], query: string, filter: TokenFilter): TokenView[] {
  const q = query.trim().toLocaleLowerCase("it");
  return tokens.filter((t) => (filter === "all" || t.kind === filter) && (q === "" || t.name.toLocaleLowerCase("it").includes(q)));
}

export interface TokenPanelProps {
  view: CampaignView;
  tokens: readonly TokenView[];
  canCreate: boolean;
  onCreate: () => void;
  /** Riga premuta: porta il token al centro dello schermo e, se l'utente puo', apre la scheda. */
  onOpen: (token: TokenView) => void;
}

/** Elenco dei token della scena con ricerca e filtri per categoria (PG, mostri, oggetti). */
export function TokenPanel({ view, tokens, canCreate, onCreate, onOpen }: TokenPanelProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TokenFilter>("all");
  const perms = permissionsFor(view);
  const shown = useMemo(() => filterTokens(tokens, query, filter), [tokens, query, filter]);
  const owner = (t: TokenView) => view.members.find((m) => m.userId === t.ownerUserId)?.displayName;

  return (
    <div className="a-panel">
      {canCreate ? (
        <div className="a-panel__bar">
          <Button size="sm" icon={<Plus size={16} />} onClick={onCreate}>
            Nuovo token
          </Button>
        </div>
      ) : null}
      <SearchField placeholder="Cerca un token" label="Cerca un token" value={query} onValueChange={setQuery} />
      <SegmentedControl
        aria-label="Categoria"
        value={filter}
        onValueChange={setFilter}
        options={[
          { value: "all", label: "Tutti" },
          { value: "pc", label: "PG" },
          { value: "monster", label: "Mostri" },
          { value: "object", label: "Oggetti" }
        ]}
      />
      {tokens.length === 0 ? (
        <EmptyState
          icon={<Users size={28} />}
          title="Nessun token"
          description={canCreate ? "Aggiungi il primo personaggio o mostro con \"Nuovo token\"." : "In questa scena non ci sono ancora token."}
        />
      ) : shown.length === 0 ? (
        <p className="t-subhead a-muted a-panel__none" role="status">
          Nessun token corrisponde alla ricerca.
        </p>
      ) : (
        <List aria-label="Token della scena">
          {shown.map((t) => (
            <ListRow
              key={t.id}
              title={t.name}
              subtitle={[KIND_LABEL[t.kind], owner(t)].filter(Boolean).join(" · ")}
              leading={<Avatar name={t.name} src={assetUrl(t.imageUrl)} size="sm" />}
              trailing={
                <span className="a-row-meta">
                  {t.conditions.slice(0, 3).map((c) => (
                    <span key={c.id} title={c.name} className="a-row-meta__icon">
                      <ConditionIcon id={c.id} size={14} />
                    </span>
                  ))}
                  {t.hidden ? (
                    <Badge tone="gray">
                      <EyeOff size={12} aria-hidden="true" /> Nascosto
                    </Badge>
                  ) : null}
                  {t.health ? <span className="t-footnote">{t.health.current}/{t.health.max}</span> : null}
                </span>
              }
              chevron={perms.canOpenEditor(t)}
              onPress={() => onOpen(t)}
            />
          ))}
        </List>
      )}
    </div>
  );
}
