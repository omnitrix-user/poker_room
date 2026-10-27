import { parse, serialize } from "cookie";
import { SESSION_COOKIE } from "@riverroom/protocol";
import type { Store } from "./store.ts";

export function tokenFromCookieHeader(header: string | undefined): string | null {
  if (!header) return null;
  const token = parse(header)[SESSION_COOKIE];
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function sessionCookie(token: string, secure: boolean): string {
  return serialize(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function playerFromCookie(store: Store, header: string | undefined) {
  const token = tokenFromCookieHeader(header);
  return token ? store.playerForToken(token) : null;
}
