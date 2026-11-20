import { SegmentedControl, Sheet, Toggle } from "../ui";
import { updateSettings, useSettings, type Theme } from "./settings";

export interface SettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Chiaro" },
  { value: "dark", label: "Scuro" }
];

/** Impostazioni locali (salvate in questo browser). */
export function SettingsSheet({ open, onOpenChange }: SettingsSheetProps) {
  const settings = useSettings();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Impostazioni">
      <div className="a-settings">
        <SegmentedControl aria-label="Tema" options={THEME_OPTIONS} value={settings.theme} onValueChange={(theme) => updateSettings({ theme })} />
        <p className="t-footnote a-muted">Auto segue il tema del dispositivo.</p>
        <Toggle label="Animazione 3D dei dadi" checked={settings.dice3d} onCheckedChange={(dice3d) => updateSettings({ dice3d })} />
        <p className="t-footnote a-muted">
          Mostra i dadi che rotolano sopra la mappa a ogni tiro. Il risultato resta sempre scritto in chat. Con il movimento ridotto del sistema o senza WebGL
          l'animazione non compare.
        </p>
      </div>
    </Sheet>
  );
}
