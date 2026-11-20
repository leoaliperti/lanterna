import { Suspense, lazy, useEffect, useState } from "react";
import { App } from "./App";
import { SessionProvider } from "./session/SessionProvider";
import { ToastProvider } from "./ui";

// In produzione le costanti sono null e i chunk delle pagine di prova non entrano nel bundle.
const Gallery = import.meta.env.DEV ? lazy(() => import("./ui/Gallery").then((m) => ({ default: m.Gallery }))) : null;
const MapDemo = import.meta.env.DEV ? lazy(() => import("./map/MapDemo").then((m) => ({ default: m.MapDemo }))) : null;

function currentRoute(): "ui" | "map" | "app" {
  const hash = window.location.hash;
  if (hash === "#/ui") return "ui";
  if (hash === "#/map" || hash.startsWith("#/map?")) return "map";
  return "app";
}

/** Router minimo: la gallery del design system (#/ui) e la prova della mappa (#/map) esistono solo in sviluppo. */
export function Root() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const on = () => setRoute(currentRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  if (Gallery && route === "ui") {
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    );
  }
  if (MapDemo && route === "map") {
    return (
      <Suspense fallback={null}>
        <MapDemo />
      </Suspense>
    );
  }
  return (
    <ToastProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ToastProvider>
  );
}
