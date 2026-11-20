import { Wifi, WifiOff } from "lucide-react";
import { Banner, Button } from "../ui";
import { useRealtimeClient, useRealtimeState } from "../realtime/RealtimeProvider";
import type { ConnectionStatus as Status, FailureReason } from "../realtime/RealtimeClient";

const LABEL: Record<Status, string> = {
  connecting: "Connessione in corso",
  connected: "Connesso",
  reconnecting: "Riconnessione",
  offline: "Offline",
  failed: "Disconnesso"
};

/** Pallino e testo nella barra: sempre presente, discreto. */
export function ConnectionDot() {
  const { status } = useRealtimeState();
  const ok = status === "connected";
  return (
    <span className={`a-conn a-conn--${status}`} role="status" aria-live="polite" title={LABEL[status]}>
      {ok ? <Wifi size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}
      <span className="a-conn__text t-caption1">{LABEL[status]}</span>
    </span>
  );
}

const FAILURE_TEXT: Record<FailureReason, string> = {
  session: "La sessione è scaduta. Accedi di nuovo.",
  "not-member": "Non fai più parte di questa campagna. Chiedi al GM di aggiungerti.",
  protocol: "Questa versione dell'app non è più compatibile con il server. Ricarica la pagina."
};

/** Avviso non invasivo sotto la barra quando la connessione non e' attiva. Nessun avviso mentre e' tutto a posto. */
export function ConnectionBanner() {
  const client = useRealtimeClient();
  const { status, failure, view } = useRealtimeState();
  if (status === "connected" || (status === "connecting" && !view)) return null;
  if (failure) {
    return (
      <Banner tone="danger" title="Connessione interrotta" className="a-conn-banner">
        {FAILURE_TEXT[failure]}
      </Banner>
    );
  }
  return (
    <div className="a-conn-banner">
      <Banner tone="warning" title={status === "offline" ? "Sei offline" : "Riconnessione in corso"}>
        {status === "offline"
          ? "Appena torna la rete il tavolo si riallinea da solo. Nel frattempo non puoi fare modifiche."
          : "Il tavolo si riallinea da solo. Nel frattempo non puoi fare modifiche."}
      </Banner>
      <Button variant="plain" size="sm" onClick={() => client.retryNow()}>
        Riprova ora
      </Button>
    </div>
  );
}
