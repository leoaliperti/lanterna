import { useCallback, useEffect, useState } from "react";
import type { FormTemplate, FormTemplateResponse } from "@lanterna/shared";
import { getForm } from "./formApi";

/** Modulo della campagna: il template (se c'è) e se il PDF è caricato. Si ricarica con `reload`. */
export function useFormTemplate(campaignId: string) {
  const [data, setData] = useState<FormTemplateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getForm(campaignId));
      setError(null);
    } catch {
      setError("Non riesco a leggere il modulo della campagna.");
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Il template completo (con la versione del formato), o `null` se il modulo non c'è.
  const template: FormTemplate | null = data?.template ? { version: 1, ...data.template } : null;
  return { data, template, hasPdf: data?.hasPdf ?? false, loading, error, reload };
}
