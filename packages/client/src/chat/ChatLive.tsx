import { useChat } from "./ChatProvider";

/**
 * Regione live per gli screen reader: annuncia solo l'ultima voce arrivata (cortese, mai asserita),
 * non tutta la cronologia. Le proprie voci non vengono annunciate.
 */
export function ChatLive() {
  const { live } = useChat();
  return (
    <div className="l-sr-only" role="status" aria-live="polite" aria-atomic="true">
      {live ? <span key={live.n}>{live.text}</span> : null}
    </div>
  );
}
