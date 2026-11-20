import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Layers, Map as MapIcon, MessageSquare, Pencil, Redo2, ShieldCheck, Undo2, Users, WifiOff } from "lucide-react";
import type { CampaignView, TokenView } from "@lanterna/shared";
import type { SessionUser } from "../api/client";
import { MapCanvas, type MapCanvasHandle } from "../map";
import { Button, IconButton, Material, Spinner } from "../ui";
import { EmptyState } from "../screens/EmptyState";
import { useCommands, useRealtimeState } from "../realtime/RealtimeProvider";
import { ChatLive, ChatPanel, ChatProvider, DiceOverlay, useChat, useChatShortcuts, useChatStore } from "../chat";
import { sceneToShow, tokensOfScene, toMapScene } from "./adapter";
import { ConnectionBanner, ConnectionDot } from "./ConnectionStatus";
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
  return <LiveTable user={user} view={view} actions={actions} />;
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
  const mapScene = useMemo(() => (scene ? toMapScene(view, scene) : null), [view, scene]);
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
      banner={<ConnectionBanner />}
      tabs={tabs}
      defaultTab="token"
      focusRequest={focusRequest}
      onVisibleTabChange={onVisibleTab}
      panelBadge={chat.unread}
    >
      <ChatLive />
      <DiceOverlay />
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
              ? "Una scena e' una mappa con la sua griglia e i suoi token. Creala, poi carica l'immagine della mappa."
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
        <EmptyState icon={<MapIcon size={36} />} title="In attesa della mappa" description="Il GM non ha ancora aperto una scena. Comparira' qui appena sara' pronta." />
      )}
      {perms.isGm ? (
        <p className="a-map__badge t-caption1 a-muted">
          <ShieldCheck size={14} aria-hidden="true" /> Sei il GM di questo tavolo
        </p>
      ) : null}

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
