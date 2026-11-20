import { useEffect, useRef, useState } from "react";
import { Library } from "lucide-react";
import { Banner, List, ListRow, SearchField, Spinner } from "../ui";
import { getLibraryDoc, searchLibrary, sheetErrorMessage, type LibraryDoc, type LibraryHit, type LibraryKind } from "./sheetsApi";

const KIND_LABEL: Record<LibraryKind, string> = { monster: "mostri", item: "oggetti", spell: "incantesimi" };

export interface LibraryPickerProps {
  kind: LibraryKind;
  /** Chiamato con il documento completo quando l'utente sceglie una voce. */
  onPick: (doc: LibraryDoc) => void | Promise<void>;
  /** Etichetta del pulsante di una riga (default "Aggiungi"). */
  actionLabel?: string;
}

/**
 * Ricerca nei contenuti importati (`GET /content?kind=&q=`): niente è incluso nel repo, si trova solo ciò che
 * l'istanza ha importato. Il server decide cosa si può vedere: un giocatore non trova mai i mostri.
 */
export function LibraryPicker({ kind, onPick, actionLabel = "Aggiungi" }: LibraryPickerProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LibraryHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      searchLibrary(kind, query)
        .then((r) => {
          if (seq.current === mine) {
            setHits(r);
            setError(null);
          }
        })
        .catch((err) => {
          if (seq.current === mine) setError(sheetErrorMessage(err));
        });
    }, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [kind, query]);

  const pick = async (hit: LibraryHit) => {
    setBusy(hit.id);
    try {
      await onPick(await getLibraryDoc(hit.id));
      setError(null);
    } catch (err) {
      setError(sheetErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="s-library">
      <SearchField label={`Cerca tra ${KIND_LABEL[kind]} importati`} placeholder={`Cerca tra ${KIND_LABEL[kind]} importati`} value={query} onValueChange={setQuery} />
      {error ? (
        <Banner tone="danger" title="Ricerca non riuscita">
          {error}
        </Banner>
      ) : null}
      {hits === null && !error ? <Spinner label="Ricerca in corso" /> : null}
      {hits && hits.length === 0 ? (
        <p className="t-footnote a-muted">
          <Library size={14} aria-hidden="true" /> Nessun risultato. I contenuti si importano dalla propria istanza (docs/CONTENT.md).
        </p>
      ) : null}
      {hits && hits.length > 0 ? (
        <List aria-label={`Risultati: ${KIND_LABEL[kind]}`}>
          {hits.map((h) => (
            <ListRow key={h.id} title={h.name} subtitle={h.source || undefined} onPress={() => void pick(h)} disabled={busy !== null} trailing={busy === h.id ? "..." : actionLabel} />
          ))}
        </List>
      ) : null}
    </div>
  );
}
