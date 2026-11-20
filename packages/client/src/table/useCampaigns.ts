import { useCallback, useEffect, useState } from "react";
import type { CampaignSummary } from "@lanterna/shared";
import { createCampaign, listMyCampaigns, userErrorMessage } from "../api/client";

export type CampaignsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; campaigns: CampaignSummary[] };

/** Le campagne dell'utente. Si usa la prima (oggi un'istanza ne ha una sola). */
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

  /** Crea la campagna (solo admin: il server rifiuta gli altri) e la seleziona. */
  const create = useCallback(async (name: string) => {
    const created = await createCampaign(name);
    setState({ status: "ready", campaigns: [created] });
  }, []);

  return { state, reload: load, create };
}
