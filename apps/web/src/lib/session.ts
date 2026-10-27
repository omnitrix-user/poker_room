import { useSyncExternalStore } from "react";
import type { Me } from "@riverroom/protocol";
import { api } from "./api.ts";

export type { Me };

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

/** Turns the current guest into an account (or creates a fresh account when signed out). */
export async function register(username: string, password: string, name?: string): Promise<Me> {
  const r = await api<{ player: Me }>("/api/account/register", { method: "POST", body: { username, password, ...(name ? { name } : {}) } });
  set({ status: "ready", me: r.player });
  return r.player;
}

export async function login(username: string, password: string): Promise<Me> {
  const r = await api<{ player: Me }>("/api/account/login", { method: "POST", body: { username, password } });
  set({ status: "ready", me: r.player });
  return r.player;
}

export async function logout(): Promise<void> {
  await api("/api/account/logout", { method: "POST", body: {} });
  set({ status: "ready", me: null });
}

export async function changePassword(current: string, next: string): Promise<number> {
  const r = await api<{ signedOutElsewhere: number }>("/api/account/password", { method: "POST", body: { current, next } });
  return r.signedOutElsewhere;
}
