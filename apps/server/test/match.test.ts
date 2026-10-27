import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, RoomView } from "@riverroom/protocol";
import { act, actor, expectOk, openSocket, player, settle, startedTable, startServer, type Server, type TestPlayer } from "./harness.ts";

let server: Server;
beforeEach(async () => {
  server = await startServer();
});
afterEach(async () => {
  await server.stop();
});

/** Folds hands until the given hand number has finished. */
async function foldThrough(players: TestPlayer[], handNo: number) {
  for (let guard = 0; guard < 200; guard++) {
    const g = players[0]!.state().game;
    if (g && g.handNo >= handNo && g.street === "complete") return;
    if (!g || g.street === "complete" || g.toActSeat === null) {
      await players[0]!.waitFor((v) => (v.game?.toActSeat ?? null) !== null || (v.game?.handNo ?? 0) >= handNo, 5000).catch(() => {});
      continue;
    }
    const ack = await act(actor(players), { type: "fold" });
    if (!ack.ok && ack.code !== "stale") throw new Error(ack.message);
    await settle(players);
  }
  throw new Error("did not reach hand " + handNo);
}

describe("match length", () => {
  it("ends after the agreed number of rounds, with a short window to extend", async () => {
    const { players } = await startedTable(server, ["A", "B"], { rounds: 2 });
    expect(players[0]!.state().roundsTotal).toBe(2);
    await foldThrough(players, 2);
    const window = await players[0]!.waitFor((v) => v.finalWindowUntil !== null);
    expect(window.status).toBe("playing");
    const done = await players[0]!.waitFor((v) => v.status === "finished", 4000);
    expect(done.handsPlayed).toBe(2);
    expect(done.players.reduce((s, p) => s + p.stack - p.buyIn, 0)).toBe(0);
  });

  it("extends only when every player agrees", async () => {
    const { players } = await startedTable(server, ["A", "B", "C"], { rounds: 1 });
    const [a, b, c] = players as [TestPlayer, TestPlayer, TestPlayer];
    expectOk(await a.emit("room:vote-start", { add: 5 }));
    const v = await b.waitFor((x) => x.vote !== null);
    expect(v.vote).toMatchObject({ add: 5, proposerId: a.id, yes: [a.id] });
    expect(v.vote!.voters.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(await a.emit("room:vote-start", { add: 5 })).toMatchObject({ ok: false });
    expectOk(await b.emit("room:vote", { id: v.vote!.id, yes: true }));
    expect((await c.waitFor((x) => x.vote?.yes.length === 2)).roundsTotal).toBe(1);
    expectOk(await c.emit("room:vote", { id: v.vote!.id, yes: true }));
    const extended = await a.waitFor((x) => x.vote === null && x.roundsTotal === 6);
    expect(extended.status).toBe("playing");
    expect(a.notices.some((n) => n.includes("Everyone agreed"))).toBe(true);
  });

  it("a single no cancels the extension and the match ends as planned", async () => {
    const { players } = await startedTable(server, ["A", "B"], { rounds: 1 });
    const [a, b] = players as [TestPlayer, TestPlayer];
    await foldThrough(players, 1);
    await a.waitFor((x) => x.finalWindowUntil !== null);
    expectOk(await a.emit("room:vote-start", { add: 10 }));
    const v = await b.waitFor((x) => x.vote !== null);
    expectOk(await b.emit("room:vote", { id: v.vote!.id, yes: false }));
    const done = await a.waitFor((x) => x.status === "finished", 4000);
    expect(done.roundsTotal).toBe(1);
    expect(a.notices.some((n) => n.includes("voted no"))).toBe(true);
  });

  it("a vote nobody finishes lapses as a no", async () => {
    const { players } = await startedTable(server, ["A", "B"], { rounds: 50 });
    expectOk(await players[0]!.emit("room:vote-start", { add: 5 }));
    await players[1]!.waitFor((x) => x.vote !== null);
    const after = await players[1]!.waitFor((x) => x.vote === null, 3000);
    expect(after.roundsTotal).toBe(50);
    expect(players[1]!.notices.some((n) => n.includes("ran out of time"))).toBe(true);
  });

  it("an extension agreed after the final round keeps the match going", async () => {
    const { players } = await startedTable(server, ["A", "B"], { rounds: 1 });
    const [a, b] = players as [TestPlayer, TestPlayer];
    await foldThrough(players, 1);
    await a.waitFor((x) => x.finalWindowUntil !== null);
    expectOk(await b.emit("room:vote-start", { add: 5 }));
    const v = await a.waitFor((x) => x.vote !== null);
    expectOk(await a.emit("room:vote", { id: v.vote!.id, yes: true }));
    const next = await a.waitFor((x) => x.game?.handNo === 2, 5000);
    expect(next.roundsTotal).toBe(6);
    expect(next.finalWindowUntil).toBeNull();
  });
});

describe("posting to enter", () => {
  it("a late joiner posts a big blind on their first hand", async () => {
    const { code, players } = await startedTable(server, ["A", "B", "C"]);
    const late = await player(server, "Late");
    expectOk(await late.emit("room:join", { code }));
    const seen: RoomView = await late.waitFor((v) => v.players.some((p) => p.playerId === late.id));
    expect(seen.players.find((p) => p.playerId === late.id)!.willPost).toBe(true);
    await foldThrough(players, 1);
    const h2 = await late.waitFor((v) => v.game?.handNo === 2, 5000);
    const inBlinds = h2.game!.sbSeat === h2.you.seat || h2.game!.bbSeat === h2.you.seat;
    const posts = h2.game!.events.filter((e) => e.kind === "blind" && e.playerId === late.id);
    expect(posts).toHaveLength(1);
    if (!inBlinds) expect(posts[0]).toMatchObject({ blind: "post", amount: 20 });
    expect(h2.players.find((p) => p.playerId === late.id)!.willPost).toBe(false);
  });
});

describe("chat persistence", () => {
  it("keeps table chat across a server restart", async () => {
    const { code, players } = await startedTable(server, ["A", "B"]);
    expectOk(await players[0]!.emit("room:chat", { text: "see you after the restart" }));
    const { db, config } = server;
    for (const p of players) p.socket.disconnect();
    await server.close();
    await new Promise((r) => server.http.close(r));
    server = await startServer({ db, config });
    const socket = await openSocket(server, players[1]!.cookie);
    const history = new Promise<ChatMessage[]>((resolve) => socket.once("room:chat-history", resolve));
    expect(await socket.timeout(3000).emitWithAck("room:join", { code })).toEqual({ ok: true });
    expect((await history).map((m) => m.text)).toEqual(["see you after the restart"]);
    socket.disconnect();
  });
});

