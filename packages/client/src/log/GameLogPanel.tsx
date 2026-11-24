import { useCallback, useEffect, useState } from "react";
import { Banner, Button, Spinner } from "../ui";
import { request, userErrorMessage } from "../api/client";

/** Una voce del registro di gioco (solo GM): vedi `gamelog/store.ts` sul server. */
export interface GameLogEntry {
  id: string;
  version: number;
  at: string;
  actor: string;
  lines: string[];
}

const POLL_MS = 5000;

/**
 * Registro di gioco: tutto ciò che è cambiato nella campagna, con chi l'ha fatto. Lo legge solo il GM
 * (il server risponde 403 agli altri). Si aggiorna da solo ogni pochi secondi, e carica le voci più vecchie a richiesta.
 */
export function GameLogPanel({ campaignId }: { campaignId: string }) {
  const [entries, setEntries] = useState<GameLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [end, setEnd] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await request<{ entries: GameLogEntry[] }>("GET", `/campaigns/${encodeURIComponent(campaignId)}/game-log`);
      setEntries(res.entries);
      setEnd(res.entries.length < 50);
      setError(null);
    } catch (err) {
      setError(userErrorMessage(err));
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function older() {
    const last = entries?.[entries.length - 1];
    if (!last) return;
    setBusy(true);
    try {
      const res = await request<{ entries: GameLogEntry[] }>("GET", `/campaigns/${encodeURIComponent(campaignId)}/game-log?before=${last.version}`);
      setEntries((list) => [...(list ?? []), ...res.entries]);
      setEnd(res.entries.length < 50);
    } catch (err) {
      setError(userErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !entries) return <Banner tone="danger" title="Registro non disponibile">{error}</Banner>;
  if (!entries) return <Spinner label="Caricamento del registro" />;
  if (entries.length === 0) return <p className="t-subhead a-muted">Ancora nessuna azione registrata.</p>;

  return (
    <div className="c-log">
      {error ? <Banner tone="danger" title="Aggiornamento non riuscito">{error}</Banner> : null}
      <ol className="c-log__list" aria-label="Registro di gioco">
        {entries.map((e) => (
          <li key={e.id} className="c-log__entry">
            <span className="c-log__meta t-caption1 a-muted">
              {new Date(e.at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · {e.actor}
            </span>
            <ul className="c-log__lines">
              {e.lines.map((line, i) => (
                <li key={i} className="t-body">
                  {line}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {end ? null : (
        <Button variant="gray" size="sm" loading={busy} onClick={() => void older()}>
          Voci precedenti
        </Button>
      )}
    </div>
  );
}
