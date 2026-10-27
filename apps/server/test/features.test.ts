import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, HandDetail, RoomView } from "@riverroom/protocol";
import type { Room } from "../src/room.ts";
import { act, actor, expectOk, openSocket, player, settle, startedTable, startServer, type Server, type TestPlayer } from "./harness.ts";

let server: Server;
beforeEach(async () => {
  server = await startServer();
});
afterEach(async () => {
  await server.stop();
});

const liveRoom = () => [...(server.rooms as unknown as { rooms: Map<string, Room> }).rooms.values()][0]!;

/** Shoves every decision until one player is out of chips. */
async function playUntilBust(players: TestPlayer[]) {
  for (let guard = 0; guard < 300; guard++) {
    const v = players[0]!.state();
    if (v.players.some((p) => p.stack === 0) && (!v.game || v.game.street === "complete")) return v;
    const g = v.game;
    if (!g || g.street === "complete" || g.toActSeat === null) {
      await players[0]!.waitFor((x) => x.players.some((p) => p.stack === 0) || (x.game?.toActSeat ?? null) !== null, 5000);
      continue;
    }
    const a = actor(players);
    const legal = a.state().game!.legal;
    if (!legal) {
      await settle(players);
      continue;
    }
    const ack = await act(a, legal.canAllIn ? { type: "allin" } : legal.canCheck ? { type: "check" } : { type: "call" });
    if (!ack.ok && ack.code !== "stale") throw new Error(ack.message);
    await settle(players);
  }
  throw new Error("nobody busted");
}

describe("rebuys", () => {
  it("keeps the session open for a busted player who can rebuy, and deals them back in", async () => {
    const { players } = await startedTable(server, ["A", "B"], { startingStack: 200, smallBlind: 10, bigBlind: 20, rebuys: true });
    const v = await playUntilBust(players);
    const busted = players.find((p) => v.players.find((x) => x.playerId === p.id)!.stack === 0)!;
    const winner = players.find((p) => p !== busted)!;
    const waiting = await winner.waitFor((x) => x.waitingFor !== null, 5000);
    expect(waiting.status).toBe("playing");
    expect(waiting.waitingFor).toMatch(/rebuy/);
    expect(await winner.emit("room:rebuy")).toMatchObject({ ok: false });
    expectOk(await busted.emit("room:rebuy"));
    const next = await busted.waitFor((x) => x.game !== null && x.game.street !== "complete" && x.game.players.some((p) => p.playerId === busted.id), 5000);
    const me = next.players.find((p) => p.playerId === busted.id)!;
    expect(me.buyIn).toBe(400);
    const total = next.players.reduce((s, p) => s + p.stack, 0) + next.game!.potTotal;
    expect(total).toBe(600);
  });

  it("refuses rebuys when the table has them turned off", async () => {
    const { players } = await startedTable(server, ["A", "B"], { startingStack: 200, rebuys: false });
    expect(await players[0]!.emit("room:rebuy")).toMatchObject({ ok: false, code: "bad_request" });
  });
});

describe("sitting out", () => {
  it("skips a sitting-out player for new hands until they're back", async () => {
    const { players } = await startedTable(server, ["A", "B", "C"]);
    const c = players[2]!;
    expectOk(await c.emit("room:sitout", { sitOut: true }));
    // Finish hand 1 by folding around.
    while (players[0]!.state().game!.street !== "complete") {
      expectOk(await act(actor(players), { type: "fold" }));
      await settle(players);
    }
    const h2 = await players[0]!.waitFor((x) => x.game?.handNo === 2);
    expect(h2.game!.players.map((p) => p.playerId)).not.toContain(c.id);
    expect(h2.players.find((p) => p.playerId === c.id)!.sittingOut).toBe(true);
    expectOk(await c.emit("room:sitout", { sitOut: false }));
    while (players[0]!.state().game!.street !== "complete") {
      const ps = players.filter((p) => p !== c);
      expectOk(await act(actor(ps), { type: "fold" }));
      await settle(ps);
    }
    const h3 = await c.waitFor((x) => x.game?.handNo === 3);
    expect(h3.game!.players.map((p) => p.playerId)).toContain(c.id);
  });

  it("sits out a connected player who lets the turn clock expire", async () => {
    const { players } = await startedTable(server, ["A", "B", "C"]);
    const room = liveRoom();
    // Shorten the clock for the test, then re-arm it.
    (room.data.settings as { turnSeconds: number }).turnSeconds = 0.3;
    // The next turn starts with the short clock.
    expectOk(await act(actor(players), { type: "call" }));
    await settle(players);
    const a = actor(players);
    const other = players.find((p) => p !== a)!;
    const v = await other.waitFor((x) => x.players.find((p) => p.playerId === a.id)!.sittingOut, 4000);
    expect(v.game!.players.find((p) => p.playerId === a.id)!.status).toBe("folded");
    expect(other.notices.some((n) => n.includes("sitting out"))).toBe(true);
  });
});

describe("showing cards", () => {
  it("lets a player reveal their hand after winning uncontested, and records it", async () => {
    const { players } = await startedTable(server, ["A", "B"]);
    const folder = actor(players);
    const winner = players.find((p) => p !== folder)!;
    expectOk(await act(folder, { type: "fold" }));
    await settle(players);
    const g = folder.state().game!;
    expect(g.players.find((p) => p.playerId === winner.id)!.cards).toBeNull();
    const winnerCards = winner.state().game!.players.find((p) => p.playerId === winner.id)!.cards;
    expectOk(await winner.emit("game:show", { handNo: g.handNo }));
    const v = await folder.waitFor((x) => x.game!.players.find((p) => p.playerId === winner.id)!.cards !== null);
    const shown = v.game!.players.find((p) => p.playerId === winner.id)!;
    expect(shown.cards).toEqual(winnerCards);
    expect(shown.showedByChoice).toBe(true);
    const roomId = v.roomId;
    const hand = await folder.api<HandDetail>(`/api/history/${roomId}/hands/${g.handNo}`);
    expect(hand.body.players.find((p) => p.playerId === winner.id)!.shown).toEqual(winnerCards);
    // Can't show a hand that's gone.
    expect(await winner.emit("game:show", { handNo: 99 })).toMatchObject({ ok: false });
  });
});

describe("chat", () => {
  it("broadcasts table chat to members, sends history on join, and rate-limits", async () => {
    const { code, players } = await startedTable(server, ["A", "B"]);
    const got: ChatMessage[] = [];
    players[1]!.socket.on("room:chat", (m: ChatMessage) => got.push(m));
    expectOk(await players[0]!.emit("room:chat", { text: "  nice   hand  " }));
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([expect.objectContaining({ playerId: players[0]!.id, name: "A", text: "nice hand" })]);
    expect(await players[0]!.emit("room:chat", { text: "" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await players[0]!.emit("room:chat", { text: "x".repeat(161) })).toMatchObject({ ok: false, code: "bad_request" });

    const history = new Promise<ChatMessage[]>((resolve) => players[1]!.socket.once("room:chat-history", resolve));
    const second = await openSocket(server, players[1]!.cookie);
    second.once("room:chat-history", () => {});
    const historyOnNew = new Promise<ChatMessage[]>((resolve) => second.once("room:chat-history", resolve));
    await second.timeout(3000).emitWithAck("room:join", { code });
    expect((await historyOnNew).map((m) => m.text)).toEqual(["nice hand"]);
    void history;
    second.disconnect();

    const outsider = await player(server, "Z");
    expect(await outsider.emit("room:chat", { text: "hi" })).toMatchObject({ ok: false, code: "not_member" });

    const results = [];
    for (let i = 0; i < 8; i++) results.push(await players[0]!.emit("room:chat", { text: `m${i}` }));
    expect(results.some((r) => !r.ok && r.code === "rate_limited")).toBe(true);
  });
});

describe("reliability and identity", () => {
  it("recognises an already-applied action after its in-memory record is gone", async () => {
    const { players } = await startedTable(server, ["A", "B", "C"]);
    const a = actor(players);
    const g = a.state().game!;
    const actionId = randomUUID();
    expectOk(await act(a, { type: "call" }, { actionId }));
    // Simulate a restart losing the acknowledgement cache.
    (liveRoom() as unknown as { recentActions: Map<string, unknown> }).recentActions.clear();
    const retry = await a.emit("game:action", { actionId, handNo: g.handNo, seq: g.seq, action: { type: "call" } });
    expect(retry).toEqual({ ok: true });
    await settle(players);
    expect(players[0]!.state().game!.seq).toBe(g.seq + 1);
  });

  it("moves an identity to another device with a single-use link", async () => {
    const { code, players } = await startedTable(server, ["A", "B"]);
    const a = players[0]!;
    const link = await a.api<{ token: string }>("/api/session/link", { method: "POST", body: "{}" });
    expect(link.status).toBe(200);
    const claim = (token: string) =>
      fetch(`${server.url}/api/session/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    const res = await claim(link.body.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { player: { id: string } }).player.id).toBe(a.id);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect(cookie).not.toBe(a.cookie);
    expect((await claim(link.body.token)).status).toBe(410);
    expect((await claim("x".repeat(43))).status).toBe(410);
    // The new device is the same player in the same seat.
    const phone = await openSocket(server, cookie);
    const state = new Promise<RoomView>((resolve) => phone.once("room:state", resolve));
    expect(await phone.timeout(3000).emitWithAck("room:join", { code })).toEqual({ ok: true });
    expect((await state).you.seat).toBe(a.state().you.seat);
    phone.disconnect();
  });
});
