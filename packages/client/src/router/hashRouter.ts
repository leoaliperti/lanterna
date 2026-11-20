import { useEffect, useState } from "react";

/** Percorso corrente dall'hash (`#/admin/users` -> `/admin/users`). Senza hash e' `/`. */
export function currentPath(): string {
  const raw = window.location.hash.replace(/^#/, "");
  const path = raw.split("?")[0] ?? "";
  if (!path || path === "/") return "/";
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.replace(/\/+$/, "") || "/";
}

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const hash = `#${path}`;
  if (window.location.hash === hash) return;
  if (opts.replace) {
    // replaceState non emette hashchange: lo inviamo a mano.
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = hash;
  }
}

/** Router a hash minimo, senza dipendenze. */
export function usePath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const on = () => setPath(currentPath());
    window.addEventListener("hashchange", on);
    on();
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return path;
}
