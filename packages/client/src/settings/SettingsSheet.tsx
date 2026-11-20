import { Sheet, Toggle } from "../ui";
import { updateSettings, useSettings } from "./settings";

export interface SettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Impostazioni locali (salvate in questo browser). */
export function SettingsSheet({ open, onOpenChange }: SettingsSheetProps) {
  const settings = useSettings();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Impostazioni">
      <div className="a-settings">
        <Toggle label="Animazione 3D dei dadi" checked={settings.dice3d} onCheckedChange={(dice3d) => updateSettings({ dice3d })} />
        <p className="t-footnote a-muted">
          Mostra i dadi che rotolano sopra la mappa a ogni tiro. Il risultato resta sempre scritto in chat. Con il movimento ridotto del sistema o senza WebGL
          l'animazione non compare.
        </p>
      </div>
    </Sheet>
  );
}
