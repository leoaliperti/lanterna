import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloudFog, Crosshair, Eye, EyeOff, Layers, Library, Map as MapIcon, MessageSquare, Pencil, Redo2, ScrollText, ShieldCheck, Swords, Undo2, Users, WifiOff } from "lucide-react";
import type { CampaignView, FogShape, TokenView, WallPatch } from "@lanterna/shared";
import type { SessionUser } from "../api/client";
import { MapCanvas, type MapCanvasHandle, type Point } from "../map";
import { fogShapeCommand, fogTarget, type FogMode } from "../fog/fogLogic";
import { wallAddCommand, wallRemoveCommand, wallUpdateCommand } from "../fog/wallLogic";
import { Button, IconButton, Material, PointMenu, Spinner, type MenuItemSpec } from "../ui";
import { ActionButtons } from "../combat/ActionButtons";
import { ActionSheet, type ActionRequest } from "../combat/ActionSheet";
import { addTokenCommand, combatOf, tokensToAdd, turnTokenId } from "../combat/combatLogic";
import { InitiativePanel } from "../combat/InitiativePanel";
import { ACTION_LABELS, actionForKey, isTypingTarget, type ActionKind } from "../combat/selectionLogic";
import { TargetsPanel } from "../combat/TargetsPanel";
import { useCombatFeed } from "../combat/useCombatFeed";
import { EmptyState } from "../screens/EmptyState";
import { SheetWorkspace, SheetsPanel, SheetsProvider } from "../sheets";
import { LibraryPanel } from "../library/LibraryPanel";
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
import { ViewFrame } from "../windows/ViewFrame";
import { WindowsMenu } from "../windows/WindowsMenu";
import type { SecondaryRoute } from "../windows/routes";
import "./table.css";

/**
 * Finestre multiple (M9): il tavolo completo o solo la mappa in una finestra a parte.
 * `mapOnly` riusa la stessa mappa (e gli stessi strumenti del GM) senza barra ne' pannello.
 */
export interface MapOnlyLayout {
  /** Titolo della finestra. */
  title: string;
  /** Scena fissa (`#/view/scene/<id>`): il GM la guarda senza cambiare quella dei giocatori. */
  sceneId?: string | null;
  /** Vista giocatore: nessuna interazione, la connessione e' gia' in sola lettura sul server. */
  readOnly?: boolean;
  /** Vista giocatore: identita' con cui chiedere le tessere della mappa (`?viewAs=`). */
  tilesAs?: string | null;
}

export interface TableProps {
  user: SessionUser;
  /** Nome della campagna finche' non arriva lo stato. */
  campaignName: string;
  /** Solo mappa, in una finestra secondaria. Senza: tavolo completo. */
  mapOnly?: MapOnlyLayout;
}

/** Il tavolo reale: stato dal server, mappa, pannello token e scene, annulla/ripeti. */
export function Table({ user, campaignName, mapOnly }: TableProps) {
  return (
    <ChatProvider selfId={user.id}>
      <TableContent user={user} campaignName={campaignName} mapOnly={mapOnly} />
    </ChatProvider>
  );
}

function TableContent({ user, campaignName, mapOnly }: TableProps) {
  const { view, status, failure } = useRealtimeState();
  const commands = useCommands();
  const connected = status === "connected";
  const readOnly = mapOnly?.readOnly ?? false;

  useHistoryShortcuts({ undo: () => void commands.undo(), redo: () => void commands.redo(), enabled: connected && view !== null && !readOnly });

  const actions = (
    <>
      <ConnectionDot />
      <WindowsMenu user={user} view={view} />
      <IconButton label="Annulla (Cmd/Ctrl+Z)" icon={<Undo2 size={20} />} disabled={!connected} onClick={() => void commands.undo()} />
      <IconButton label="Ripeti (Maiusc+Cmd/Ctrl+Z)" icon={<Redo2 size={20} />} disabled={!connected} onClick={() => void commands.redo()} />
    </>
  );

  if (mapOnly) {
    const viewing = readOnly && view ? (view.members.find((m) => m.userId === view.viewer.userId)?.displayName ?? null) : null;
    return (
      <ViewFrame title={mapOnly.title} layout="map" viewingAs={viewing}>
        {view ? (
          <SheetsProvider campaignId={view.campaignId} user={user} syncTokens={false}>
            <LiveTable user={user} view={view} actions={null} mapOnly={mapOnly} />
          </SheetsProvider>
        ) : failure ? (
          <EmptyState icon={<WifiOff size={36} />} title="Impossibile aprire la vista" description="Controlla il messaggio qui sotto, poi chiudi la finestra o ricaricala." />
        ) : (
          <Spinner label="Connessione al tavolo" size="lg" />
        )}
      </ViewFrame>
    );
  }

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
  mapOnly?: MapOnlyLayout;
}

function LiveTable({ user, view, actions, mapOnly }: LiveProps) {
  const commands = useCommands();
  const { run } = commands;
  const readOnly = mapOnly?.readOnly ?? false;
  const basePerms = permissionsFor(view);
  // Sola lettura (vista giocatore): nessuno strumento, nessun trascinamento. Il server rifiuterebbe comunque.
  const perms = readOnly ? { ...basePerms, isGm: false, canMoveToken: () => false, canOpenEditor: () => false } : basePerms;
  const [viewedId, setViewedId] = useState<string | null>(mapOnly?.sceneId ?? null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [editor, setEditor] = useState<{ open: boolean; tokenId: string | null }>({ open: false, tokenId: null });
  const [sceneForm, setSceneForm] = useState<"create" | "edit" | null>(null);
  const [action, setAction] = useState<ActionRequest | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; tokenId: string } | null>(null);
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
  const combat = combatOf(view, scene?.id ?? null);
  const turnToken = turnTokenId(combat);
  const feed = useCombatFeed({ view, sceneId: scene?.id ?? null, mapRef });
  const wallTool = controls.tool.tool === "wall";
  const mapFog = useMemo(
    () => (scene ? toMapFog(view, scene, { viewAs: controls.viewAs, showVeil: controls.veil, tilesAs: mapOnly?.tilesAs ?? null }) : null),
    // La nebbia cambia solo con `fogs`, la scena o le scelte del GM: non a ogni movimento di token.
    [view.fogs, view.campaignId, view.viewer.role, scene, controls.viewAs, controls.veil, mapOnly?.tilesAs]
  );
  const mapWalls = useMemo(() => (scene ? toMapWalls(view.walls, scene.id) : []), [view.walls, scene]);
  const sight = useSight(view, scene, controls.sight);
  const mapScene = useMemo(() => {
    if (!scene) return null;
    const s = toMapScene(view, scene, {
      fog: mapFog,
      walls: mapWalls,
      wallsVisible: perms.isGm ? controls.walls || wallTool : true,
      sight,
      ephemerals: feed.shapes,
      pulses: feed.pulses,
      turnTokenId: turnToken
    });
    // Vista giocatore (sola lettura): nessun token trascinabile.
    return readOnly ? { ...s, movableTokenIds: [] } : s;
  }, [view, scene, mapFog, mapWalls, controls.walls, wallTool, perms.isGm, sight, feed.shapes, feed.pulses, turnToken, readOnly]);
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

  const openAction = useCallback((kind: ActionKind, tokenIds: readonly string[]) => {
    if (tokenIds.length > 0) setAction({ kind, tokenIds });
  }, []);
  // Scorciatoie delle azioni (solo GM, con il focus sulla mappa e almeno un token selezionato).
  const onMapKey = (key: string): boolean => {
    if (!perms.isGm || selected.length === 0 || isTypingTarget(document.activeElement)) return false;
    const kind = actionForKey(key);
    if (!kind) return false;
    openAction(kind, selected);
    return true;
  };
  const onContextMenu = (x: number, y: number, tokenId: string | null) => {
    if (!tokenId) {
      setMenu(null);
      return;
    }
    setMenu({ x, y, tokenId });
  };
  const menuItems = (): MenuItemSpec[] => {
    const token = menu ? view.tokens.find((t) => t.id === menu.tokenId) : null;
    if (!menu || !token) return [];
    const ids = selected.includes(token.id) ? selected : [token.id];
    if (!perms.isGm) {
      return perms.canOpenEditor(token) ? [{ id: "edit", label: "Condizioni", icon: <Pencil size={16} />, onSelect: () => setEditor({ open: true, tokenId: token.id }) }] : [];
    }
    const act = (kind: ActionKind, key: string): MenuItemSpec => ({ id: kind, label: `${ACTION_LABELS[kind]} (${key})`, onSelect: () => openAction(kind, ids) });
    const inCombat = combat?.participants.some((p) => p.tokenId === token.id) ?? false;
    return [
      act("damage", "D"),
      act("heal", "H"),
      act("condition", "K"),
      act("effect", "E"),
      act("move", "M"),
      ...(scene && !inCombat && tokensToAdd([token], scene.id, combat).length > 0
        ? [{ id: "combat", label: "Aggiungi al combattimento", icon: <Swords size={16} />, onSelect: () => void run(addTokenCommand(crypto.randomUUID(), scene.id, token.id)) } satisfies MenuItemSpec]
        : []),
      { id: "edit", label: "Modifica", icon: <Pencil size={16} />, onSelect: () => setEditor({ open: true, tokenId: token.id }) },
      {
        id: "hide",
        label: token.hidden ? "Rivela" : "Nascondi",
        icon: token.hidden ? <Eye size={16} /> : <EyeOff size={16} />,
        onSelect: () => void run({ type: "token.update", tokenId: token.id, patch: { hidden: !token.hidden } })
      }
    ];
  };
  const audienceOptions = perms.isGm
    ? [
        { value: "private", label: "Solo io" },
        { value: "all", label: "Tutti" }
      ]
    : [
        { value: "private", label: "Solo io" },
        { value: "gm", label: "Solo GM" },
        { value: "all", label: "Tutti" }
      ];

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
      id: "combat",
      label: "Iniziativa",
      icon: <Swords size={16} />,
      content: <InitiativePanel view={view} scene={scene} selected={selected} />
    },
    ...(perms.isGm && scene
      ? [
          {
            id: "targets",
            label: "Bersagli",
            icon: <Crosshair size={16} />,
            content: <TargetsPanel view={view} scene={scene} selected={selected} onSelect={(ids) => mapRef.current?.setSelection(ids)} onAction={(kind) => openAction(kind, selected)} />
          }
        ]
      : []),
    {
      id: "sheets",
      label: "Schede",
      icon: <ScrollText size={16} />,
      content: <SheetsPanel onOpened={closeSheet} />
    },
    {
      id: "library",
      label: "Libreria",
      icon: <Library size={16} />,
      content: <LibraryPanel view={view} scene={scene} tokens={sceneTokens} onAdded={closeSheet} />
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

  // "Apri in nuova finestra" per le schede del pannello che hanno una vista propria (M9).
  const tabWindows: Record<string, SecondaryRoute> = {
    chat: { kind: "chat" },
    sheets: { kind: "notes" },
    combat: { kind: "combat" },
    ...(scene && perms.isGm ? { scene: { kind: "scene", sceneId: scene.id } as SecondaryRoute } : {})
  };

  const body = (
    <>
      {mapScene && scene ? (
        <div className="a-map__live">
          <MapCanvas
            ref={mapRef}
            {...mapScene}
            label={`Mappa: ${scene.name}`}
            onMoveToken={readOnly ? undefined : onMoveToken}
            onResizeToken={perms.isGm ? onResizeToken : undefined}
            onRotateToken={perms.isGm ? onRotateToken : undefined}
            onSelectionChange={setSelected}
            onFogShape={perms.isGm ? onFogShape : undefined}
            onWallAdd={perms.isGm ? onWallAdd : undefined}
            onWallUpdate={perms.isGm ? onWallUpdate : undefined}
            onWallRemove={perms.isGm ? onWallRemove : undefined}
            onWallSelect={controls.setSelectedWall}
            onToolStateChange={controls.setTool}
            onShape={readOnly ? undefined : feed.onShape}
            onShapeCancel={readOnly ? undefined : feed.onShapeCancel}
            onContextMenu={readOnly ? undefined : onContextMenu}
            onKey={readOnly ? undefined : onMapKey}
            measureAudience={{ value: feed.audience, options: audienceOptions, onChange: (v) => feed.setAudience(v as typeof feed.audience) }}
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
          {selectedToken && perms.canOpenEditor(selectedToken) || (perms.isGm && selected.length > 1) ? (
            <Material
              thickness="regular"
              className="a-selbar a-enter"
              role="toolbar"
              aria-label={selectedToken ? `Azioni su ${selectedToken.name}` : `Azioni su ${selected.length} token`}
            >
              <span className="a-selbar__name t-subhead">{selectedToken ? selectedToken.name : `${selected.length} token`}</span>
              {selectedToken ? (
                <Button variant="gray" size="sm" icon={<Pencil size={16} />} onClick={() => setEditor({ open: true, tokenId: selectedToken.id })}>
                  {perms.isGm ? "Modifica" : "Condizioni"}
                </Button>
              ) : null}
              {perms.isGm && selectedToken ? (
                <Button
                  variant="gray"
                  size="sm"
                  icon={selectedToken.hidden ? <Eye size={16} /> : <EyeOff size={16} />}
                  onClick={() => void run({ type: "token.update", tokenId: selectedToken.id, patch: { hidden: !selectedToken.hidden } })}
                >
                  {selectedToken.hidden ? "Rivela" : "Nascondi"}
                </Button>
              ) : null}
              {perms.isGm ? <ActionButtons onAction={(kind) => openAction(kind, selected)} /> : null}
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
      {perms.isGm && !mapOnly ? (
        <p className="a-map__badge t-caption1 a-muted">
          <ShieldCheck size={14} aria-hidden="true" /> Sei il GM di questo tavolo
        </p>
      ) : null}

      {readOnly ? null : (
        <>
          <TokenEditor
            view={view}
            scene={scene}
            tokenId={editor.tokenId}
            open={editor.open}
            onOpenChange={(open) => setEditor((e) => ({ ...e, open }))}
            onAddEffect={(id) => {
              setEditor((e) => ({ ...e, open: false }));
              openAction("effect", [id]);
            }}
          />
          <ActionSheet view={view} cellSize={scene?.grid.cellSize ?? 70} request={action} onClose={() => setAction(null)} />
          <PointMenu position={menu ? { x: menu.x, y: menu.y } : null} label="Azioni sul token" items={menuItems()} onClose={() => setMenu(null)} />
          <SceneForm
            open={sceneForm !== null}
            onOpenChange={(open) => !open && setSceneForm(null)}
            scene={sceneForm === "edit" ? scene : null}
            onCreated={setViewedId}
          />
        </>
      )}
    </>
  );

  if (mapOnly) {
    return (
      <>
        <DiceOverlay />
        {body}
      </>
    );
  }

  return (
    <TableFrame
      user={user}
      title={view.name}
      actions={actions}
      banner={<ConnectionBanner />}
      tabs={tabs}
      tabWindows={tabWindows}
      defaultTab="token"
      focusRequest={focusRequest}
      onVisibleTabChange={onVisibleTab}
      panelBadge={chat.unread}
    >
      <ChatLive />
      <DiceOverlay />
      <SheetWorkspace />
      {body}
    </TableFrame>
  );
}
