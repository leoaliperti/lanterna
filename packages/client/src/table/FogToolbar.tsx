import type { RefObject } from "react";
import { BrickWall, DoorClosed, Eraser, Grid3x3, MousePointer2, Move, Pentagon, Circle, ScanEye, Square, Trash2 } from "lucide-react";
import type { Member, WallPatch } from "@lanterna/shared";
import type { MapCanvasHandle, MapWall, WallMode } from "../map";
import type { FogBrush } from "../fog/fogLogic";
import { describeTarget } from "../fog/fogLogic";
import { Button, IconButton, Material, SegmentedControl } from "../ui";
import type { FogControls } from "./fogControls";
import { TargetChips } from "./TargetChips";

export interface FogToolbarProps {
  canvas: RefObject<MapCanvasHandle | null>;
  controls: FogControls;
  isGm: boolean;
  /** La scena ha la nebbia attiva. */
  hasFog: boolean;
  players: readonly Member[];
  /** Muro selezionato (strumento "Modifica"). */
  selectedWall: MapWall | null;
  /** Il giocatore ha almeno un token con vista: senza, il controllo non serve. */
  hasVisionToken: boolean;
  onWallPatch: (id: string, patch: WallPatch) => void;
  onWallRemove: (id: string) => void;
}

const BRUSHES: Array<{ id: FogBrush; label: string; key: string; icon: React.ReactNode }> = [
  { id: "rect", label: "Rettangolo", key: "1", icon: <Square size={18} /> },
  { id: "circle", label: "Cerchio", key: "2", icon: <Circle size={18} /> },
  { id: "polygon", label: "Poligono", key: "3", icon: <Pentagon size={18} /> },
  { id: "cells", label: "Celle", key: "4", icon: <Grid3x3 size={18} /> }
];

const WALL_MODES: Array<{ id: WallMode; label: string; key: string; icon: React.ReactNode }> = [
  { id: "draw", label: "Disegna muro", key: "1", icon: <BrickWall size={18} /> },
  { id: "door", label: "Disegna porta", key: "2", icon: <DoorClosed size={18} /> },
  { id: "edit", label: "Modifica muro", key: "3", icon: <Move size={18} /> },
  { id: "erase", label: "Elimina muro", key: "4", icon: <Eraser size={18} /> }
];

const MODE_HELP: Record<WallMode, string> = {
  draw: "Trascina da un punto all'altro, oppure fai clic per iniziare e di nuovo per ogni segmento; Invio termina. Alt = senza aggancio.",
  door: "Come i muri; fai clic su una porta esistente per aprirla o chiuderla.",
  edit: "Fai clic su un muro per selezionarlo, trascina le estremita' per spostarle.",
  erase: "Fai clic su un muro per eliminarlo."
};

/**
 * Barra degli strumenti sopra la mappa. GM: selezione, pennelli della nebbia (rettangolo, cerchio, poligono, celle)
 * con modo rivela/copri e destinatari, muri e porte, vista dei token. Giocatore: solo la vista del proprio token.
 * Le scorciatoie (V, N, W, 1-4, X) funzionano con la mappa a fuoco; la barra e' un modo alternativo e per il touch.
 */
export function FogToolbar({ canvas, controls, isGm, hasFog, players, selectedWall, hasVisionToken, onWallPatch, onWallRemove }: FogToolbarProps) {
  const { tool } = controls;
  const sightButton = (
    <IconButton
      label={controls.sight ? "Nascondi la vista dei token" : "Mostra la vista dei token (solo aiuto visivo)"}
      icon={<ScanEye size={20} />}
      variant={controls.sight ? "tinted" : "plain"}
      aria-pressed={controls.sight}
      onClick={() => controls.setSight(!controls.sight)}
    />
  );

  if (!isGm) {
    if (!hasVisionToken) return null;
    return (
      <Material thickness="regular" className="a-fogbar a-enter" role="toolbar" aria-label="Vista del tuo token">
        {sightButton}
      </Material>
    );
  }

  const names = new Map(players.map((p) => [p.userId, p.displayName]));
  const status =
    tool.tool === "fog"
      ? `${tool.fogMode === "reveal" ? "Rivela" : "Copri"} con ${BRUSHES.find((b) => b.id === tool.fogBrush)!.label.toLowerCase()}, per ${describeTarget(controls.target, names)}.`
      : tool.tool === "wall"
        ? `${WALL_MODES.find((m) => m.id === tool.wallMode)!.label}.`
        : "Selezione.";

  return (
    <Material thickness="regular" className="a-fogbar a-enter" role="toolbar" aria-label="Strumenti della nebbia e dei muri">
      <div className="a-fogbar__row">
        <IconButton
          label="Seleziona (V)"
          icon={<MousePointer2 size={20} />}
          variant={tool.tool === "select" ? "tinted" : "plain"}
          aria-pressed={tool.tool === "select"}
          onClick={() => canvas.current?.setTool("select")}
        />
        {hasFog ? (
          <>
            <span className="a-fogbar__sep" aria-hidden="true" />
            {BRUSHES.map((b) => {
              const on = tool.tool === "fog" && tool.fogBrush === b.id;
              return (
                <IconButton
                  key={b.id}
                  label={`${b.label} (${b.key}, con la nebbia attiva)`}
                  icon={b.icon}
                  variant={on ? "tinted" : "plain"}
                  aria-pressed={on}
                  onClick={() => {
                    canvas.current?.setTool("fog");
                    canvas.current?.setFogBrush(b.id);
                  }}
                />
              );
            })}
            <SegmentedControl
              aria-label="Cosa fa il pennello"
              className="a-fogbar__mode"
              options={[
                { value: "reveal", label: "Rivela" },
                { value: "cover", label: "Copri" }
              ]}
              value={tool.fogMode}
              onValueChange={(m) => canvas.current?.setFogMode(m)}
            />
          </>
        ) : null}
        <span className="a-fogbar__sep" aria-hidden="true" />
        <IconButton
          label="Muri e porte (W)"
          icon={<BrickWall size={20} />}
          variant={tool.tool === "wall" ? "tinted" : "plain"}
          aria-pressed={tool.tool === "wall"}
          onClick={() => canvas.current?.setTool(tool.tool === "wall" ? "select" : "wall")}
        />
        {sightButton}
      </div>

      {tool.tool === "fog" ? (
        <div className="a-fogbar__sub">
          <TargetChips players={players} value={controls.target} onChange={controls.setTarget} />
          {tool.fogBrush === "polygon" ? (
            <p className="t-caption1 a-muted a-fogbar__help">
              Fai clic per ogni vertice; chiudi con un clic sul primo punto, doppio clic o Invio. Backspace toglie l&apos;ultimo; Esc annulla.
            </p>
          ) : (
            <p className="t-caption1 a-muted a-fogbar__help">
              {tool.fogBrush === "cells" ? "Trascina sulle celle." : "Trascina sulla mappa."} Un clic vale una cella. Alt = senza aggancio alla griglia.
            </p>
          )}
        </div>
      ) : null}

      {tool.tool === "wall" ? (
        <div className="a-fogbar__sub">
          <div className="a-fogbar__row">
            {WALL_MODES.map((m) => {
              const on = tool.wallMode === m.id;
              return (
                <IconButton
                  key={m.id}
                  label={`${m.label} (${m.key}, con i muri attivi)`}
                  icon={m.icon}
                  variant={on ? "tinted" : "plain"}
                  aria-pressed={on}
                  onClick={() => canvas.current?.setWallMode(m.id)}
                />
              );
            })}
          </div>
          {selectedWall ? (
            <div className="a-fogbar__row a-fogbar__wall" role="group" aria-label="Muro selezionato">
              <Button
                size="sm"
                variant={selectedWall.door ? "tinted" : "gray"}
                aria-pressed={selectedWall.door}
                icon={<DoorClosed size={16} />}
                onClick={() => onWallPatch(selectedWall.id, selectedWall.door ? { door: false, open: false } : { door: true, open: false })}
              >
                Porta
              </Button>
              {selectedWall.door ? (
                <Button size="sm" variant="gray" onClick={() => onWallPatch(selectedWall.id, { open: !selectedWall.open })}>
                  {selectedWall.open ? "Chiudi" : "Apri"}
                </Button>
              ) : null}
              <Button size="sm" variant="destructive" icon={<Trash2 size={16} />} onClick={() => onWallRemove(selectedWall.id)}>
                Elimina
              </Button>
            </div>
          ) : null}
          <p className="t-caption1 a-muted a-fogbar__help">{MODE_HELP[tool.wallMode]}</p>
        </div>
      ) : null}
      <p className="l-sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </Material>
  );
}
