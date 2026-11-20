import type { ServerMessage, ShownShape } from "@lanterna/shared";
import type { MapEphemeral } from "../map";

/**
 * Forme effimere vive (misure pubbliche, frecce, ping): quelle ricevute dal server e quelle create qui (l'autore
 * non riceve la propria dal server). Non si salvano mai. Il server manda `ttlMs` (quanto resta), non un orario:
 * si converte in una scadenza locale con l'orologio di questo client.
 */

export interface LiveShape {
  /** `autore:id`: lo stesso `id` dello stesso autore sostituisce la forma. */
  key: string;
  id: string;
  authorId: string;
  sceneId: string;
  shape: ShownShape;
  color?: string;
  ttlMs: number;
  expiresAt: number;
}

export type ShapeMessage = Extract<ServerMessage, { type: "ephemeral.shown" | "ephemeral.cleared" }>;

export function isShapeMessage(m: ServerMessage): m is ShapeMessage {
  return m.type === "ephemeral.shown" || m.type === "ephemeral.cleared";
}

export const shapeKey = (authorId: string, id: string): string => `${authorId}:${id}`;

export class EphemeralStore {
  private items = new Map<string, LiveShape>();
  private listeners = new Set<() => void>();
  private snapshot: readonly LiveShape[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): readonly LiveShape[] => this.snapshot;

  private commit(): void {
    this.snapshot = [...this.items.values()];
    for (const l of [...this.listeners]) l();
    this.schedule();
  }

  /** Programma la rimozione della prossima forma in scadenza (i `ttlMs` sono brevi: un solo timer). */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.items.size === 0) return;
    const next = Math.min(...[...this.items.values()].map((i) => i.expiresAt));
    this.timer = setTimeout(() => this.prune(), Math.max(0, next - this.now()) + 5);
  }

  /** Toglie le forme scadute. */
  prune(): void {
    const t = this.now();
    let changed = false;
    for (const [k, v] of this.items) {
      if (v.expiresAt <= t) {
        this.items.delete(k);
        changed = true;
      }
    }
    if (changed) this.commit();
    else this.schedule();
  }

  add(shape: Omit<LiveShape, "key" | "expiresAt"> & { expiresAt?: number }): void {
    const key = shapeKey(shape.authorId, shape.id);
    this.items.set(key, { ...shape, key, expiresAt: shape.expiresAt ?? this.now() + shape.ttlMs });
    this.commit();
  }

  remove(authorId: string, id: string): void {
    if (this.items.delete(shapeKey(authorId, id))) this.commit();
  }

  /** Applica un messaggio del server. */
  receive(m: ShapeMessage): void {
    if (m.type === "ephemeral.shown") {
      this.add({ id: m.id, authorId: m.authorId, sceneId: m.sceneId, shape: m.shape, ttlMs: m.ttlMs, ...(m.color ? { color: m.color } : {}) });
    } else this.remove(m.authorId, m.id);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.items.size === 0) return;
    this.items.clear();
    this.commit();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}

/** Forme da disegnare sulla scena mostrata. */
export function shapesOfScene(shapes: readonly LiveShape[], sceneId: string | null): MapEphemeral[] {
  return shapes
    .filter((s) => s.sceneId === sceneId)
    .map((s) => ({ key: s.key, shape: s.shape, ...(s.color ? { color: s.color } : {}), expiresAt: s.expiresAt, ttlMs: s.ttlMs }));
}
