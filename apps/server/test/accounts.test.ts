import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Me, SessionSummary, StatsResponse } from "@riverroom/protocol";
import { verifyPassword, hashPassword } from "../src/passwords.ts";
import { act, actor, expectOk, openSocket, settle, startedTable, startServer, testConfig, type Server } from "./harness.ts";

let server: Server;
beforeEach(async () => {
  server = await startServer();
});
afterEach(async () => {
  await server.stop();
});

type Res<T> = { status: number; body: T; cookie: string | null };
async function call<T = Record<string, unknown>>(path: string, body: unknown, cookie?: string | null): Promise<Res<T>> {
  const res = await fetch(`${server.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  return { status: res.status, body: (await res.json()) as T, cookie: set ? set.split(";")[0]! : null };
}
const me = async (cookie: string | null) => (await call<{ player: Me | null }>("/api/me", undefined, cookie)).body.player;

describe("passwords", () => {
  it("hashes with a random salt and verifies", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("wrong", a)).toBe(false);
    expect(await verifyPassword("anything", "garbage")).toBe(false);
  });
});

describe("accounts", () => {
  it("a guest who registers keeps their identity and history, and can log in on another device", async () => {
    const { players } = await startedTable(server, ["Ayu", "Ben"]);
    const ayu = players[0]!;
    expectOk(await act(actor(players), { type: "fold" }));
    await settle(players);

    const reg = await call<{ player: Me }>("/api/account/register", { username: "Ayush_1", password: "s3cret-pass" }, ayu.cookie);
    expect(reg.status).toBe(200);
    expect(reg.body.player).toEqual({ id: ayu.id, name: "Ayu", username: "Ayush_1" });
    expect(await me(ayu.cookie)).toEqual({ id: ayu.id, name: "Ayu", username: "Ayush_1" });

    // Another device, no cookie: log in (username is case-insensitive) and see the same history.
    const login = await call<{ player: Me }>("/api/account/login", { username: "ayush_1", password: "s3cret-pass" });
    expect(login.status).toBe(200);
    expect(login.body.player.id).toBe(ayu.id);
    const phone = login.cookie!;
    expect(phone).not.toBe(ayu.cookie);
    const history = await call<{ sessions: SessionSummary[] }>("/api/history", undefined, phone);
    expect(history.body.sessions).toHaveLength(1);
    const stats = await call<StatsResponse>("/api/stats", undefined, phone);
    expect(stats.body.handsPlayed).toBe(1);
    expect(stats.body.biggestPot).toBeGreaterThanOrEqual(0);

    // The new device takes the same seat at the live table.
    const socket = await openSocket(server, phone);
    expect(await socket.timeout(3000).emitWithAck("room:join", { code: ayu.state().code })).toEqual({ ok: true });
    socket.disconnect();
  });

  it("someone without a session can create an account directly", async () => {
    const reg = await call<{ player: Me }>("/api/account/register", { username: "fresh", password: "password1", name: "Freshie" });
    expect(reg.status).toBe(200);
    expect(reg.body.player).toMatchObject({ name: "Freshie", username: "fresh" });
    expect((await me(reg.cookie))?.username).toBe("fresh");
  });

  it("rejects taken usernames (any letter case), bad input, and double registration", async () => {
    const a = await call("/api/account/register", { username: "Meera", password: "password1" });
    expect(a.status).toBe(200);
    expect((await call("/api/account/register", { username: "MEERA", password: "password1" })).status).toBe(409);
    expect((await call("/api/account/register", { username: "x", password: "password1" })).status).toBe(400);
    expect((await call("/api/account/register", { username: "has space", password: "password1" })).status).toBe(400);
    expect((await call("/api/account/register", { username: "okname", password: "short" })).status).toBe(400);
    expect((await call("/api/account/register", { username: "another", password: "password1" }, a.cookie)).status).toBe(409);
  });

  it("gives the same answer for a wrong password and an unknown user", async () => {
    await call("/api/account/register", { username: "kabir", password: "password1" });
    const wrong = await call<{ error: string }>("/api/account/login", { username: "kabir", password: "nope-nope" });
    const unknown = await call<{ error: string }>("/api/account/login", { username: "nobody", password: "nope-nope" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toBe(unknown.body.error);
    expect(wrong.cookie).toBeNull();
  });

  it("limits login attempts per username", async () => {
    await call("/api/account/register", { username: "target", password: "password1" });
    const results: number[] = [];
    for (let i = 0; i < 12; i++) results.push((await call("/api/account/login", { username: "target", password: "guess" + i })).status);
    expect(results.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(results.slice(10)).toEqual([429, 429]);
  });

  it("logs out: the session stops working and the cookie is cleared", async () => {
    const reg = await call("/api/account/register", { username: "leaver", password: "password1" });
    const out = await call<{ ok: boolean }>("/api/account/logout", {}, reg.cookie);
    expect(out.body.ok).toBe(true);
    expect(out.cookie).toMatch(/^rr_session=$/);
    expect(await me(reg.cookie)).toBeNull();
  });

  it("changing the password signs out other devices and replaces the old password", async () => {
    const reg = await call("/api/account/register", { username: "ivy", password: "password1" });
    const laptop = reg.cookie!;
    const phone = (await call("/api/account/login", { username: "ivy", password: "password1" })).cookie!;
    expect((await call("/api/account/password", { current: "wrong-one", next: "newpassword2" }, laptop)).status).toBe(401);
    const changed = await call<{ signedOutElsewhere: number }>("/api/account/password", { current: "password1", next: "newpassword2" }, laptop);
    expect(changed.status).toBe(200);
    expect(changed.body.signedOutElsewhere).toBe(1);
    expect(await me(phone)).toBeNull();
    expect((await me(laptop))?.username).toBe("ivy");
    expect((await call("/api/account/login", { username: "ivy", password: "password1" })).status).toBe(401);
    expect((await call("/api/account/login", { username: "ivy", password: "newpassword2" })).status).toBe(200);
  });

  it("a signed-out session can't keep playing on an open connection", async () => {
    await server.stop();
    server = await startServer({ config: testConfig({ sessionRecheckMs: 0 }) });
    const { players } = await startedTable(server, ["A", "B"]);
    const a = players[0]!;
    await call("/api/account/logout", {}, a.cookie);
    const ack = await a.emit("room:ready", { ready: true });
    expect(ack).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});
