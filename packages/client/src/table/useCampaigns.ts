import { useCallback, useEffect, useState } from "react";
import type { CampaignSummary } from "@lanterna/shared";
import { createCampaign, listMyCampaigns, userErrorMessage } from "../api/client";

export type CampaignsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; campaigns: CampaignSummary[] };

/** Le campagne dell'utente. La scelta della campagna aperta sta in `#/?campaign=<id>` (vedi `TableScreen`). */
export function useCampaigns() {
  const [state, setState] = useState<CampaignsState>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
    let alive = true;
    listMyCampaigns().then(
      (campaigns) => alive && setState({ status: "ready", campaigns }),
      (err: unknown) => alive && setState({ status: "error", message: userErrorMessage(err) })
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  /** Crea la campagna (solo admin: il server rifiuta gli altri) e la aggiunge all'elenco; restituisce quella creata. */
  const create = useCallback(async (name: string) => {
    const created = await createCampaign(name);
    setState((s) => ({ status: "ready", campaigns: s.status === "ready" ? [...s.campaigns, created] : [created] }));
    return created;
  }, []);

  return { state, reload: load, create };
}
