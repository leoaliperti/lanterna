import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloudFog, Eye, EyeOff, Layers, Map as MapIcon, MessageSquare, Pencil, Redo2, ScrollText, ShieldCheck, Undo2, Users, WifiOff } from "lucide-react";
import type { CampaignView, FogShape, TokenView, WallPatch } from "@lanterna/shared";
import type { SessionUser } from "../api/client";
import { MapCanvas, type MapCanvasHandle, type Point } from "../map";
import { fogShapeCommand, fogTarget, type FogMode } from "../fog/fogLogic";
import { wallAddCommand, wallRemoveCommand, wallUpdateCommand } from "../fog/wallLogic";
import { Button, IconButton, Material, Spinner } from "../ui";
import { EmptyState } from "../screens/EmptyState";
import { SheetWorkspace, SheetsPanel, SheetsProvider } from "../sheets";
import { useCommands, useRealtimeState } from "../realtime/RealtimeProvider";
import { ChatLive, ChatPanel, ChatProvider, DiceOverlay, useChat, useChatShortcuts, useChatStore } from "../chat";
import { fogOfScene, sceneToShow, tokensOfScene, toMapFog, toMapScene, toMapWalls } from "./adapter";
import { ConnectionBanner, ConnectionDot } from "./ConnectionStatus";
import { useFogControls, validTargets } from "./fogControls";
import { FogPanel } from "./FogPanel";
import { FogToolbar } from "./FogToolbar";
import { useSight } from "./useSight";
import { permissionsFor } from "./permissions";
import { SceneForm } from "./SceneForm";
import { ScenePanel } from "./ScenePanel";
import { useHistoryShortcuts } from "./shortcuts";
import { TableFrame } from "./TableFrame";
import { TokenEditor } from "./TokenEditor";
import { TokenPanel } from "./TokenPanel";
import "./table.css";

export interface TableProps {
  user: SessionUser;
  /** Nome della campagna finche' non arriva lo stato. */
  campaignName: string;
}

/** Il tavolo reale: stato dal server, mappa, pannello token e scene, annulla/ripeti. */
export function Table({ user, campaignName }: TableProps) {
  return (
    <ChatProvider selfId={user.id}>
      <TableContent user={user} campaignName={campaignName} />
    </ChatProvider>
  );
}

function TableContent({ user, campaignName }: TableProps) {
  const { view, status, failure } = useRealtimeState();
  const commands = useCommands();
  const connected = status === "connected";

  useHistoryShortcuts({ undo: () => void commands.undo(), redo: () => void commands.redo(), enabled: connected && view !== null });

  const actions = (
    <>
      <ConnectionDot />
      <IconButton label="Annulla (Cmd/Ctrl+Z)" icon={<Undo2 size={20} />} disabled={!connected} onClick={() => void commands.undo()} />
      <IconButton label="Ripeti (Maiusc+Cmd/Ctrl+Z)" icon={<Redo2 size={20} />} disabled={!connected} onClick={() => void commands.redo()} />
    </>
  );

  if (!view) {
    return (
      <TableFrame user={user} title={campaignName} actions={<ConnectionDot />} banner={<ConnectionBanner />}>
        {failure ? (
          <EmptyState icon={<WifiOff size={36} />} title="Impossibile aprire il tavolo" description="Controlla il messaggio qui sopra, poi ricarica la pagina." />
        ) : (
          <Spinner label="Connessione al tavolo" size="lg" />
        )}
      </TableFrame>
    );
  }
  return (
    <SheetsProvider campaignId={view.campaignId} user={user}>
      <LiveTable user={user} view={view} actions={actions} />
    </SheetsProvider>
  );
}

interface LiveProps {
  user: SessionUser;
  view: CampaignView;
  actions: React.ReactNode;
}

function LiveTable({ user, view, actions }: LiveProps) {
  const commands = useCommands();
  const { run } = commands;
  const perms = permissionsFor(view);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [editor, setEditor] = useState<{ open: boolean; tokenId: string | null }>({ open: false, tokenId: null });
  const [sceneForm, setSceneForm] = useState<"create" | "edit" | null>(null);
  const mapRef = useRef<MapCanvasHandle>(null);
  const chatStore = useChatStore();
  const chat = useChat();
  const focusChat = useCallback(() => chatStore.requestFocus(), [chatStore]);
  useChatShortcuts(focusChat);
  const onVisibleTab = useCallback((tab: string | null) => chatStore.setPanelVisible(tab === "chat"), [chatStore]);
  const focusRequest = useMemo(() => ({ tab: "chat", nonce: chat.focusNonce }), [chat.focusNonce]);

  // Il GM guarda la scena che sceglie; senza scelta (e senza scena in gioco) la prima.
  const wanted = viewedId ?? (view.activeSceneId ? null : (view.scenes[0]?.id ?? null));
  const scene = sceneToShow(view, wanted);
  const controls = useFogControls();
  const players = useMemo(() => view.members.filter((m) => m.role === "player"), [view.members]);
  const fogView = scene ? fogOfScene(view, scene.id) : null;
  const wallTool = controls.tool.tool === "wall";
  const mapFog = useMemo(
    () => (scene ? toMapFog(view, scene, { viewAs: controls.viewAs, showVeil: controls.veil }) : null),
    // La nebbia cambia solo con `fogs`, la scena o le scelte del GM: non a ogni movimento di token.
    [view.fogs, view.campaignId, view.viewer.role, scene, controls.viewAs, controls.veil]
  );
  const mapWalls = useMemo(() => (scene ? toMapWalls(view.walls, scene.id) : []), [view.walls, scene]);
  // Il GM che seleziona un token con vista ne vede la vista anche con l'interruttore spento.
  const sightFocusId = perms.isGm && selected.length === 1 && view.tokens.some((t) => t.id === selected[0] && t.vision) ? selected[0]! : null;
  const sight = useSight(view, scene, controls.sight || sightFocusId !== null, controls.sight ? null : sightFocusId);
  const mapScene = useMemo(
    () => (scene ? toMapScene(view, scene, { fog: mapFog, walls: mapWalls, wallsVisible: perms.isGm ? controls.walls || wallTool : true, sight }) : null),
    [view, scene, mapFog, mapWalls, controls.walls, wallTool, perms.isGm, sight]
  );
  const hasVisionToken = useMemo(() => (scene ? view.tokens.some((t) => t.sceneId === scene.id && t.vision) : false), [view.tokens, scene]);
  const selectedWall = useMemo(() => mapWalls.find((w) => w.id === controls.selectedWall) ?? null, [mapWalls, controls.selectedWall]);
  const sceneTokens = useMemo(() => (scene ? tokensOfScene(view, scene.id) : []), [view, scene]);

  // Cambio scena o dimensioni: la mappa si adatta di nuovo allo schermo.
  const fitKey = scene ? `${scene.id}|${scene.width}|${scene.height}|${scene.map?.url ?? ""}` : "";
  useEffect(() => {
    if (fitKey) mapRef.current?.fit();
  }, [fitKey]);

  const onMoveToken = useCallback((id: string, x: number, y: number) => void run({ type: "token.move", tokenId: id, x, y }), [run]);
  const onResizeToken = useCallback((id: string, size: number) => void run({ type: "token.update", tokenId: id, patch: { size } }), [run]);
  const onRotateToken = useCallback(
    (id: string, deg: number) => void run({ type: "token.update", tokenId: id, patch: { rotation: ((deg % 360) + 360) % 360 } }),
    [run]
  );

  // Strumenti della nebbia e dei muri: solo comandi, la nebbia vera la decide il server.
  const sceneId = scene?.id ?? null;
  const targetIds = validTargets(controls.target, players.map((p) => p.userId));
  const targetKey = targetIds.join(",");
  const onFogShape = useCallback(
    (shape: FogShape, mode: FogMode) => {
      if (sceneId) void run(fogShapeCommand(mode, sceneId, shape, fogTarget(targetKey ? targetKey.split(",") : [])));
    },
    [run, sceneId, targetKey]
  );
  const onWallAdd = useCallback(
    (a: Point, b: Point, door: boolean) => {
      const cmd = sceneId ? wallAddCommand(crypto.randomUUID(), sceneId, a, b, door) : null;
      if (cmd) void run(cmd);
    },
    [run, sceneId]
  );
  const onWallUpdate = useCallback((id: string, patch: WallPatch) => void run(wallUpdateCommand(id, patch)), [run]);
  const onWallRemove = useCallback((id: string) => void run(wallRemoveCommand(id)), [run]);

  const selectedToken = selected.length === 1 ? (view.tokens.find((t) => t.id === selected[0]) ?? null) : null;

  const openToken = (t: TokenView) => {
    mapRef.current?.centerOn({ x: t.x, y: t.y });
    if (perms.canOpenEditor(t)) setEditor({ open: true, tokenId: t.id });
  };

  const tabs = ({ closeSheet }: { closeSheet: () => void }) => [
    {
      id: "chat",
      label: "Chat",
      icon: <MessageSquare size={16} />,
      badge: chat.unread,
      content: <ChatPanel user={user} />
    },
    {
      id: "token",
      label: "Token",
      icon: <Users size={16} />,
      content: (
        <TokenPanel
          view={view}
          tokens={sceneTokens}
          canCreate={perms.canCreateTokens && scene !== null}
          onCreate={() => {
            closeSheet();
            setEditor({ open: true, tokenId: null });
          }}
          onOpen={(t) => {
            closeSheet();
            openToken(t);
          }}
        />
      )
    },
    {
      id: "sheets",
      label: "Schede",
      icon: <ScrollText size={16} />,
      content: <SheetsPanel onOpened={closeSheet} />
    },
    ...(perms.isGm && scene
      ? [
          {
            id: "fog",
            label: "Nebbia",
            icon: <CloudFog size={16} />,
            content: <FogPanel view={view} scene={scene} controls={controls} />
          }
        ]
      : []),
    ...(perms.canManageScenes
      ? [
          {
            id: "scene",
            label: "Scena",
            icon: <Layers size={16} />,
            content: <ScenePanel view={view} shown={scene} onShow={setViewedId} />
          }
        ]
      : [])
  ];

  return (
    <TableFrame
      user={user}
      title={view.name}
      actions={actions}
      badge={perms.isGm ? <span className="a-role-pill t-caption1"><ShieldCheck size={14} aria-hidden="true" /> GM</span> : null}
      banner={<ConnectionBanner />}
      tabs={tabs}
      defaultTab="token"
      focusRequest={focusRequest}
      onVisibleTabChange={onVisibleTab}
      panelBadge={chat.unread}
    >
      <ChatLive />
      <DiceOverlay />
      <SheetWorkspace />
      {mapScene && scene ? (
        <div className="a-map__live">
          <MapCanvas
            ref={mapRef}
            {...mapScene}
            label={`Mappa: ${scene.name}`}
            onMoveToken={onMoveToken}
            onResizeToken={perms.isGm ? onResizeToken : undefined}
            onRotateToken={perms.isGm ? onRotateToken : undefined}
            onSelectionChange={setSelected}
            onFogShape={perms.isGm ? onFogShape : undefined}
            onWallAdd={perms.isGm ? onWallAdd : undefined}
            onWallUpdate={perms.isGm ? onWallUpdate : undefined}
            onWallRemove={perms.isGm ? onWallRemove : undefined}
            onWallSelect={controls.setSelectedWall}
            onToolStateChange={controls.setTool}
          />
          <FogToolbar
            canvas={mapRef}
            controls={controls}
            isGm={perms.isGm}
            hasFog={fogView !== null}
            players={players}
            selectedWall={selectedWall}
            hasVisionToken={hasVisionToken}
            onWallPatch={onWallUpdate}
            onWallRemove={onWallRemove}
          />
          {perms.isGm && !scene.map ? (
            <Material thickness="regular" className="a-map__hint">
              <p className="t-subhead">Questa scena non ha ancora una mappa.</p>
              <Button size="sm" icon={<MapIcon size={16} />} onClick={() => setSceneForm("edit")}>
                Carica mappa
              </Button>
            </Material>
          ) : null}
          {selectedToken && perms.canOpenEditor(selectedToken) ? (
            <Material thickness="regular" className="a-selbar a-enter" role="toolbar" aria-label={`Azioni su ${selectedToken.name}`}>
              <span className="a-selbar__name t-subhead">{selectedToken.name}</span>
              <Button variant="gray" size="sm" icon={<Pencil size={16} />} onClick={() => setEditor({ open: true, tokenId: selectedToken.id })}>
                {perms.isGm ? "Modifica" : "Condizioni"}
              </Button>
              {perms.isGm ? (
                <Button
                  variant="gray"
                  size="sm"
                  icon={selectedToken.hidden ? <Eye size={16} /> : <EyeOff size={16} />}
                  onClick={() => void run({ type: "token.update", tokenId: selectedToken.id, patch: { hidden: !selectedToken.hidden } })}
                >
                  {selectedToken.hidden ? "Rivela" : "Nascondi"}
                </Button>
              ) : null}
            </Material>
          ) : null}
        </div>
      ) : perms.isGm ? (
        <EmptyState
          icon={<MapIcon size={36} />}
          title={view.scenes.length === 0 ? "Crea la prima scena" : "Nessuna scena da mostrare"}
          description={
            view.scenes.length === 0
              ? "Una scena è una mappa con la sua griglia e i suoi token. Creala, poi carica l'immagine della mappa."
              : "Scegli una scena dal pannello \"Scena\"."
          }
          action={
            view.scenes.length === 0 ? (
              <Button icon={<Layers size={16} />} onClick={() => setSceneForm("create")}>
                Nuova scena
              </Button>
            ) : undefined
          }
        />
      ) : (
        <EmptyState icon={<MapIcon size={36} />} title="In attesa della mappa" description="Il GM non ha ancora aperto una scena. Comparirà qui appena sarà pronta." />
      )}

      <TokenEditor
        view={view}
        scene={scene}
        tokenId={editor.tokenId}
        open={editor.open}
        onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
      />
      <SceneForm
        open={sceneForm !== null}
        onOpenChange={(open) => !open && setSceneForm(null)}
        scene={sceneForm === "edit" ? scene : null}
        onCreated={setViewedId}
      />
    </TableFrame>
  );
}
