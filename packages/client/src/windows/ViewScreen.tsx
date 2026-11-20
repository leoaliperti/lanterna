import { Map as MapIcon } from "lucide-react";
import type { SessionUser } from "../api/client";
import { Banner, Button, Spinner } from "../ui";
import { ChatPanel, ChatProvider, DiceOverlay } from "../chat";
import { SheetWorkspace, SheetsPanel, SheetsProvider } from "../sheets";
import { RealtimeProvider, useRealtimeState } from "../realtime/RealtimeProvider";
import { useSession } from "../session/SessionProvider";
import { useHashParam } from "../router/hashRouter";
import { EmptyState } from "../screens/EmptyState";
import { Table } from "../table/Table";
import { useCampaigns } from "../table/useCampaigns";
import { CombatTracker } from "./CombatTracker";
import { useRememberWindowGeometry } from "./layout";
import { formatViewRoute, viewTitle, type SecondaryRoute } from "./routes";
import { ViewFrame } from "./ViewFrame";
import "./windows.css";

/**
 * Finestra secondaria (M9): stessa sessione (cookie) del browser, oppure login su un altro PC.
 * Ogni finestra apre la SUA connessione WebSocket; la vista giocatore la apre con `viewAs`, cosi'
 * il server filtra tutto come per quel membro (la vista non si ricostruisce mai nel client).
 */
export function ViewScreen({ route }: { route: SecondaryRoute }) {
  const { user, logout } = useSession();
  const { state, reload } = useCampaigns();
  const wanted = useHashParam("campaign");
  useRememberWindowGeometry(route);

  if (!user) return null;
  if (state.status === "loading") {
    return (
      <div className="w-view__center">
        <Spinner label="Caricamento" size="lg" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="w-view__center">
        <div className="a-onboard">
          <Banner tone="danger" title="Non riesco a caricare le campagne">
            {state.message}
          </Banner>
          <Button variant="gray" onClick={reload}>
            Riprova
          </Button>
        </div>
      </div>
    );
  }
  // `?campaign=<id>` come per il tavolo: la stessa campagna della finestra di partenza; senza, la prima.
  const campaign = state.campaigns.find((c) => c.id === wanted) ?? state.campaigns[0];
  if (!campaign) {
    return (
      <div className="w-view__center">
        <EmptyState icon={<MapIcon size={36} />} title="Nessuna campagna" description="Apri prima il tavolo nella finestra principale." />
      </div>
    );
  }
  const connection = route.kind === "player" ? { viewAs: route.userId } : undefined;
  return (
    <RealtimeProvider
      key={`${campaign.id}${formatViewRoute(route)}`}
      campaignId={campaign.id}
      connection={connection}
      onSessionEnded={() => void logout().catch(() => undefined)}
    >
      <ViewContent route={route} user={user} campaignName={campaign.name} />
    </RealtimeProvider>
  );
}

function ViewContent({ route, user, campaignName }: { route: SecondaryRoute; user: SessionUser; campaignName: string }) {
  const { view } = useRealtimeState();
  const names = {
    scene: route.kind === "scene" ? view?.scenes.find((s) => s.id === route.sceneId)?.name : undefined,
    player: route.kind === "player" ? view?.members.find((m) => m.userId === route.userId)?.displayName : undefined
  };
  const title = viewTitle(route, names);

  switch (route.kind) {
    case "map":
    case "scene":
    case "player":
      return (
        <Table
          user={user}
          campaignName={campaignName}
          mapOnly={{
            title,
            sceneId: route.kind === "scene" ? route.sceneId : null,
            readOnly: route.kind === "player",
            tilesAs: route.kind === "player" ? route.userId : null
          }}
        />
      );
    case "chat":
      return (
        <ChatProvider selfId={user.id}>
          <ViewFrame title={title} layout="panel">
            <DiceOverlay />
            <div className="w-view__content w-view__chat">{view ? <ChatPanel user={user} /> : <Spinner label="Connessione" />}</div>
          </ViewFrame>
        </ChatProvider>
      );
    case "notes":
      return (
        <ChatProvider selfId={user.id}>
          <ViewFrame title={title} layout="panel">
            {view ? (
              <SheetsProvider campaignId={view.campaignId} user={user} syncTokens={false}>
                <div className="w-view__content">
                  <SheetsPanel />
                </div>
                <SheetWorkspace />
              </SheetsProvider>
            ) : (
              <Spinner label="Connessione" />
            )}
          </ViewFrame>
        </ChatProvider>
      );
    case "combat":
      return (
        <ViewFrame title={title} layout="panel">
          <div className="w-view__content">
            {view ? <CombatTracker view={view} canControl={view.viewer.role === "admin"} /> : <Spinner label="Connessione" />}
          </div>
        </ViewFrame>
      );
  }
}
