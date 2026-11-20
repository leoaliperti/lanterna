import { useState } from "react";
import { CloudFog, Eye, EyeOff, Power } from "lucide-react";
import type { CampaignView, FogLighting, SceneView } from "@lanterna/shared";
import { Alert, Button, Picker, SegmentedControl, Toggle } from "../ui";
import { useCommands } from "../realtime/RealtimeProvider";
import { fogAllCommand, fogTarget, revealedCount, geometryOf, describeTarget } from "../fog/fogLogic";
import { fogOfScene } from "./adapter";
import { validTargets, type FogControls } from "./fogControls";
import { TargetChips } from "./TargetChips";

export interface FogPanelProps {
  view: CampaignView;
  scene: SceneView;
  controls: FogControls;
}

const ALL = "__all__";

const LIGHTING: Array<{ value: FogLighting; label: string }> = [
  { value: "bright", label: "Luce" },
  { value: "dim", label: "Penombra" },
  { value: "dark", label: "Buio" }
];

/** Scheda "Nebbia" del GM: attiva/disattiva, destinatari, rivela/copri tutto, vista come, luce, muri, vista dei token. */
export function FogPanel({ view, scene, controls }: FogPanelProps) {
  const { run } = useCommands();
  const fog = fogOfScene(view, scene.id);
  const players = view.members.filter((m) => m.role === "player");
  const playerIds = players.map((p) => p.userId);
  const target = validTargets(controls.target, playerIds);
  const names = new Map(players.map((p) => [p.userId, p.displayName]));
  const [initial, setInitial] = useState<"covered" | "revealed">("covered");
  const [confirm, setConfirm] = useState<"cover" | "disable" | null>(null);
  const [busy, setBusy] = useState(false);
  const wallCount = (view.walls ?? []).filter((w) => w.sceneId === scene.id).length;

  const go = async (cmd: Parameters<typeof run>[0]) => {
    setBusy(true);
    try {
      return await run(cmd);
    } finally {
      setBusy(false);
    }
  };

  const walls = (
    <section className="a-panel__section" aria-label="Muri e porte">
      <h3 className="t-headline">Muri e porte</h3>
      <Toggle label="Mostra i muri sulla mappa" checked={controls.walls} onCheckedChange={controls.setWalls} />
      <p className="t-footnote a-muted">
        {wallCount === 0 ? "Nessun muro in questa scena." : `${wallCount} ${wallCount === 1 ? "muro" : "muri"} in questa scena.`} Servono solo all&apos;aiuto visivo della vista: non scoprono mai la nebbia.
        Usa lo strumento Muri (W) sopra la mappa.
      </p>
      <Toggle label="Mostra la vista dei token" checked={controls.sight} onCheckedChange={controls.setSight} />
      <p className="t-footnote a-muted">Contorno tratteggiato di cio' che ogni token con vista vede, muri compresi. E' solo un aiuto: la nebbia la scopri tu.</p>
    </section>
  );

  if (!fog) {
    return (
      <div className="a-panel">
        <section className="a-panel__section" aria-label="Nebbia di guerra">
          <h3 className="t-headline">Nebbia di guerra</h3>
          <p className="t-footnote a-muted">
            Con la nebbia i giocatori vedono solo le zone che rivelerai tu, anche una per giocatore. La parte coperta della mappa non arriva mai al loro dispositivo.
          </p>
          <SegmentedControl
            aria-label="Stato iniziale"
            options={[
              { value: "covered", label: "Tutto coperto" },
              { value: "revealed", label: "Tutto scoperto" }
            ]}
            value={initial}
            onValueChange={setInitial}
          />
          <Button icon={<CloudFog size={16} />} loading={busy} onClick={() => void go({ type: "fog.enable", sceneId: scene.id, initial })}>
            Attiva la nebbia
          </Button>
        </section>
        {walls}
      </div>
    );
  }

  const cells = revealedCount(fog.mask, geometryOf(fog), scene.width, scene.height);
  const viewAsValue = controls.viewAs && playerIds.includes(controls.viewAs) ? controls.viewAs : ALL;

  return (
    <div className="a-panel">
      <section className="a-panel__section" aria-label="Nebbia di guerra">
        <h3 className="t-headline">Nebbia di guerra</h3>
        <TargetChips players={players} value={target} onChange={controls.setTarget} />
        <div className="a-panel__buttons">
          <Button size="sm" variant="gray" icon={<Eye size={16} />} loading={busy} onClick={() => void go(fogAllCommand("reveal", scene.id, fogTarget(target)))}>
            Rivela tutto
          </Button>
          <Button size="sm" variant="gray" icon={<EyeOff size={16} />} disabled={busy} onClick={() => setConfirm("cover")}>
            Copri tutto
          </Button>
        </div>
        <p className="t-footnote a-muted">
          Vale per: {describeTarget(target, names)}. Per rivelare a mano usa i pennelli sopra la mappa (N). Annulla (Cmd/Ctrl+Z) rimette tutto com&apos;era.
        </p>
      </section>

      <section className="a-panel__section" aria-label="Cosa vedono i giocatori">
        <h3 className="t-headline">Cosa vedono</h3>
        <Toggle label="Mostra il velo sulla mappa" checked={controls.veil} onCheckedChange={controls.setVeil} />
        <Picker
          label="Vista come"
          options={[{ value: ALL, label: "Tutti" }, ...players.map((p) => ({ value: p.userId, label: p.displayName }))]}
          value={viewAsValue}
          onValueChange={(v) => controls.setViewAs(v === ALL ? null : v)}
        />
        <p className="t-footnote a-muted">
          Tu vedi sempre tutta la mappa: il velo e' in trasparenza e mostra cosa vedrebbe il giocatore scelto. Per ora {cells} {cells === 1 ? "cella rivelata" : "celle rivelate"}.
        </p>
        <div className="a-field-group">
          <span className="t-footnote a-muted">Luce della scena (solo per l&apos;aiuto di vista)</span>
          <SegmentedControl
            aria-label="Luce della scena"
            options={LIGHTING}
            value={fog.lighting}
            onValueChange={(lighting) => void go({ type: "fog.setLighting", sceneId: scene.id, lighting })}
          />
        </div>
      </section>

      {walls}

      <section className="a-panel__section">
        <Button variant="destructive" size="sm" icon={<Power size={16} />} disabled={busy} onClick={() => setConfirm("disable")}>
          Disattiva la nebbia
        </Button>
      </section>

      <Alert
        open={confirm === "cover"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Coprire tutta la mappa?"
        message={`I giocatori (${describeTarget(target, names)}) non vedranno piu' nulla finche' non rivelerai di nuovo. Puoi annullare con Cmd/Ctrl+Z.`}
        actions={[
          { label: "Annulla", role: "cancel" },
          { label: "Copri tutto", role: "destructive", onPress: () => void go(fogAllCommand("cover", scene.id, fogTarget(target))) }
        ]}
      />
      <Alert
        open={confirm === "disable"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Disattivare la nebbia?"
        message="La mappa torna visibile a tutti, anche le zone ancora coperte. Puoi annullare con Cmd/Ctrl+Z."
        actions={[
          { label: "Annulla", role: "cancel" },
          { label: "Disattiva", role: "destructive", onPress: () => void go({ type: "fog.disable", sceneId: scene.id }) }
        ]}
      />
    </div>
  );
}
