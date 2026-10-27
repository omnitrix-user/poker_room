import { useSyncExternalStore } from "react";
import { api } from "./api.ts";

export interface Me {
  id: string;
  name: string;
}

type State = { status: "loading" } | { status: "ready"; me: Me | null };

let state: State = { status: "loading" };
const listeners = new Set<() => void>();
const set = (s: State) => {
  state = s;
  listeners.forEach((l) => l());
};

let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  api<{ player: Me | null }>("/api/me")
    .then((r) => set({ status: "ready", me: r.player }))
    .catch(() => set({ status: "ready", me: null }));
}

export function useMe(): State {
  load();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Creates a guest identity (server sets an HttpOnly cookie) or renames the current one. */
export async function establishIdentity(name: string): Promise<Me> {
  const r = await api<{ player: Me }>("/api/session", { method: "POST", body: { name } });
  set({ status: "ready", me: r.player });
  return r.player;
}
