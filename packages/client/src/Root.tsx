import { Suspense, lazy, useEffect, useState } from "react";
import { App } from "./App";

// In produzione la costante e' null e il chunk della gallery non entra nel bundle.
const Gallery = import.meta.env.DEV ? lazy(() => import("./ui/Gallery").then((m) => ({ default: m.Gallery }))) : null;

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

  if (Gallery && gallery) {
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    );
  }
  return <App />;
}
