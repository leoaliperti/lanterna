import { Suspense, lazy, useEffect, useState } from "react";
import { App } from "./App";

const Gallery = lazy(() => import("./ui/Gallery").then((m) => ({ default: m.Gallery })));

function isGalleryHash(): boolean {
  return window.location.hash === "#/ui";
}

/** Router minimo: la gallery del design system e' raggiungibile con #/ui solo in sviluppo. */
export function Root() {
  const [gallery, setGallery] = useState(isGalleryHash);
  useEffect(() => {
    const on = () => setGallery(isGalleryHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  if (import.meta.env.DEV && gallery) {
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    );
  }
  return <App />;
}
