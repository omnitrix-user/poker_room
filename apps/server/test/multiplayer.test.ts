import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Card } from "@riverroom/engine";
import type { HandDetail, RoomView, SessionSummary, StatsResponse } from "@riverroom/protocol";
import {
  act,
  actor,
  createRoom,
  expectOk,
  openSocket,
  player,
  settle,
  sleep,
  startedTable,
  startServer,
  type Server,
  type TestPlayer,
} from "./harness.ts";

let server: Server;
beforeEach(async () => {
  server = await startServer();
});
afterEach(async () => {
  await server.stop();
});

/** Folds/checks everyone down so the hand ends quickly. */
async function finishHandByFolding(players: TestPlayer[]) {
  const handNo = players[0]!.state().game!.handNo;
  while (players[0]!.state().game?.handNo === handNo && players[0]!.state().game?.street !== "complete") {
    const a = actor(players);
    expectOk(await act(a, { type: "fold" }));
    await settle(players);
  }
}

describe("identity and rooms", () => {
  it("refuses sockets without a server-issued session", async () => {
    await expect(openSocket(server, null)).rejects.toThrow(/unauthenticated/);
    await expect(openSocket(server, "rr_session=" + "x".repeat(43))).rejects.toThrow(/unauthenticated/);
  });

  it("validates display names", async () => {
    const bad = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "<script>" }),
    });
    expect(bad.status).toBe(400);
  });

  it("keeps a stable identity across requests", async () => {
    const p = await player(server, "Ava");
    const me = await p.api<{ player: { id: string; name: string } }>("/api/me");
    expect(me.body.player).toEqual({ id: p.id, name: "Ava" });
  });

  it("joins, assigns seats, and treats duplicate joins idempotently", async () => {
    const a = await player(server, "Ava");
    const b = await player(server, "Ben");
    const code = await createRoom(a);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expectOk(await a.emit("room:join", { code }));
    expectOk(await b.emit("room:join", { code }));
    expectOk(await b.emit("room:join", { code }));
    const v = await a.waitFor((x) => x.players.length === 2);
    expect(v.players.map((p) => [p.name, p.seat])).toEqual([
      ["Ava", 0],
      ["Ben", 1],
    ]);
    expect(v.hostId).toBe(a.id);
    expect(v.you).toEqual({ playerId: a.id, seat: 0, isHost: true });
  });

  it("rejects bad and unknown codes, and full tables", async () => {
    const [a, b, c] = [await player(server, "A"), await player(server, "B"), await player(server, "C")];
    expect(await a.emit("room:join", { code: "nope" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(await a.emit("room:join", { code: "ABCDEFGH" })).toMatchObject({ ok: false, code: "room_not_found" });
    const code = await createRoom(a, { maxSeats: 2 });
    expectOk(await a.emit("room:join", { code }));
    expectOk(await b.emit("room:join", { code: code.toLowerCase() }));
    expect(await c.emit("room:join", { code })).toMatchObject({ ok: false, code: "room_full" });
  });

  it("enforces host privileges and readiness before starting", async () => {
    const a = await player(server, "Ava");
    const b = await player(server, "Ben");
    const code = await createRoom(a);
    expectOk(await a.emit("room:join", { code }));
    expect(await a.emit("game:start")).toMatchObject({ ok: false, code: "cannot_start" });
    expectOk(await b.emit("room:join", { code }));
    expect(await b.emit("game:start")).toMatchObject({ ok: false, code: "not_host" });
    expect(await a.emit("game:start")).toMatchObject({ ok: false, code: "cannot_start" });
    expect(
      await b.emit("room:settings", { settings: { smallBlind: 1, bigBlind: 2, startingStack: 1000, maxSeats: 6, turnSeconds: 0, rebuys: false, rounds: 20 } }),
    ).toMatchObject({ ok: false, code: "not_host" });
    expect(await b.emit("room:sit", { seat: 0 })).toMatchObject({ ok: false, code: "seat_taken" });
    expectOk(await b.emit("room:sit", { seat: 4 }));
    expectOk(await b.emit("room:ready", { ready: true }));
    expectOk(await a.emit("game:start"));
    const v = await b.waitFor((x) => x.game !== null);
    expect(v.status).toBe("playing");
    expect(v.players.find((p) => p.playerId === b.id)!.seat).toBe(4);
  });

  it("rejects actions from sockets that have not joined the room", async () => {
    const { players } = await startedTable(server, ["A", "B"]);
    const outsider = await player(server, "Mallory");
    const g = players[0]!.state().game!;
    const ack = await outsider.emit("game:action", { actionId: randomUUID(), handNo: g.handNo, seq: g.seq, action: { type: "fold" } });
    expect(ack).toMatchObject({ ok: false, code: "not_member" });
  });
});

describe("hidden information", () => {
  it("never sends another player's hole cards or the deck", async () => {
    const { players } = await startedTable(server, ["A", "B", "C"]);
    await settle(players);
    const holes = new Map<string, Card[]>();
    for (const p of players) {
      const mine = p.state().game!.players.find((x) => x.playerId === p.id)!;
      expect(mine.cards).toHaveLength(2);
      holes.set(p.id, mine.cards!);
      for (const other of p.state().game!.players.filter((x) => x.playerId !== p.id)) expect(other.cards).toBeNull();
    }
    for (const p of players) {
      for (const payload of p.raw) {
        expect(payload).not.toMatch(/"deck"/);
        for (const [id, cards] of holes) {
          if (id === p.id) continue;
          // The other player's exact two-card holding must not appear anywhere in the payload.
          expect(payload).not.toContain(JSON.stringify(cards));
        }
      }
    }
  });

  it("reveals cards only at showdown", async () => {
    const { players } = await startedTable(server, ["A", "B"]);
    // Check/call down to showdown.
    for (let i = 0; i < 20 && players[0]!.state().game!.street !== "complete"; i++) {
      const a = actor(players);
      const legal = a.state().game!.legal!;
      expectOk(await act(a, legal.canCheck ? { type: "check" } : { type: "call" }));
      await settle(players);
    }
    const g = players[0]!.state().game!;
    expect(g.result!.endedBy).toBe("showdown");
    // The first to show and every winner are revealed; a beaten hand may be mucked and then
    // must stay hidden from everyone else.
    expect(g.result!.shown.length + g.result!.mucked.length).toBe(2);
    for (const p of players) {
      const view = p.state().game!;
      for (const hp of view.players) {
        if (hp.playerId === p.id) expect(hp.cards).toHaveLength(2);
        else if (view.result!.mucked.includes(hp.playerId)) expect(hp.cards).toBeNull();
        else expect(hp.cards).toHaveLength(2);
      }
    }
  });
});

describe("action processing", () => {
  it("rejects out-of-turn, stale, and illegal actions; deduplicates action ids", async () => {
    const { players } = await startedTable(server, ["A", "B", "C"]);
    const a = actor(players);
    const notActor = players.find((p) => p !== a)!;
    expect(await act(notActor, { type: "fold" })).toMatchObject({ ok: false, code: "not_your_turn" });
    expect(await act(a, { type: "check" })).toMatchObject({ ok: false, code: "illegal_action" });
    expect(await act(a, { type: "raise", amount: 25 })).toMatchObject({ ok: false, code: "invalid_amount" });
    expect(await act(a, { type: "raise", amount: 10 ** 9 })).toMatchObject({ ok: false, code: "invalid_amount" });
    expect(await act(a, { type: "call" }, { seq: 99 })).toMatchObject({ ok: false, code: "stale" });
    expect(await act(a, { type: "call" }, { handNo: 7 })).toMatchObject({ ok: false, code: "stale" });
    expect(await a.emit("game:action", { actionId: "not-a-uuid", handNo: 1, seq: 0, action: { type: "call" } })).toMatchObject({
      ok: false,
      code: "bad_request",
    });

    const seq = a.state().game!.seq;
    const actionId = randomUUID();
    const first = await act(a, { type: "call" }, { actionId });
    const second = await act(a, { type: "call" }, { actionId, seq });
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    await settle(players);
    expect(players[0]!.state().game!.seq).toBe(seq + 1);
    const events = players[0]!.state().game!.events.filter((e) => e.kind === "action");
    expect(events).toHaveLength(1);
  });

  it("serializes simultaneous actions: exactly one wins", async () => {
    const { players } = await startedTable(server, ["A", "B"]);
    const a = actor(players);
    const results = await Promise.all([
      act(a, { type: "call" }),
      act(a, { type: "fold" }),
      act(a, { type: "raise", amount: 60 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "stale")).toBe(true);
  });

  it("plays a full hand and persists the result, history, and stats", async () => {
    const { players } = await startedTable(server, ["Ava", "Ben", "Cy"]);
    await finishHandByFolding(players);
    const g = players[0]!.state().game!;
    expect(g.street).toBe("complete");
    expect(g.result!.endedBy).toBe("fold");
    const total = Object.values(g.result!.stacks).reduce((s, x) => s + x, 0);
    expect(total).toBe(6000);
    // Both clients agree on the result.
    for (const p of players) expect(p.state().game!.result).toEqual(g.result);

    const [ava] = players;
    const history = await ava!.api<{ sessions: SessionSummary[] }>("/api/history");
    expect(history.body.sessions).toHaveLength(1);
    const roomId = history.body.sessions[0]!.roomId;
    const detail = await ava!.api<{ hands: { handNo: number }[] }>(`/api/history/${roomId}`);
    expect(detail.body.hands.map((h) => h.handNo)).toEqual([1]);

    const hand = await ava!.api<HandDetail>(`/api/history/${roomId}/hands/1`);
    expect(hand.status).toBe(200);
    expect(hand.body.events.filter((e) => e.kind === "blind")).toHaveLength(2);
    expect(hand.body.events.filter((e) => e.kind === "action").length).toBeGreaterThanOrEqual(2);
    // Own cards visible, opponents' unrevealed cards not.
    for (const p of hand.body.players) {
      if (p.playerId === ava!.id) expect(p.shown).toHaveLength(2);
      else expect(p.shown).toBeNull();
    }
    expect(JSON.stringify(hand.body)).not.toMatch(/deck|hole_enc/);

    const stats = await ava!.api<StatsResponse>("/api/stats");
    expect(stats.body.handsPlayed).toBe(1);
    expect(stats.body.sessions).toBe(1);

    // Non-members cannot read the session.
    const outsider = await player(server, "Eve");
    expect((await outsider.api(`/api/history/${roomId}`)).status).toBe(404);
    expect((await outsider.api(`/api/history/${roomId}/hands/1`)).status).toBe(404);
    expect((await outsider.api<StatsResponse>("/api/stats")).body.handsPlayed).toBe(0);
  });

  it("deals the next hand and moves the button", async () => {
    const { players } = await startedTable(server, ["A", "B", "C"]);
    const firstButton = players[0]!.state().game!.buttonSeat;
    await finishHandByFolding(players);
    const v = await players[0]!.waitFor((x) => x.game?.handNo === 2);
    expect(v.game!.buttonSeat).not.toBe(firstButton);
    const chips = v.players.reduce((s, p) => s + p.stack, 0) + v.game!.potTotal;
    expect(chips).toBe(6000);
  });
});

describe("connections", () => {
  it("lets a player reconnect with a fresh socket and keep their seat and cards", async () => {
    const { players } = await startedTable(server, ["A", "B"]);
    const a = actor(players);
    const before = a.state().game!.players.find((p) => p.playerId === a.id)!.cards;
    await a.reconnect();
    const other = players.find((p) => p !== a)!;
    await other.waitFor((v) => v.players.find((p) => p.playerId === a.id)!.connected === false);
    expectOk(await a.emit("room:join", { code: other.state().code }));
    const v = await a.waitFor(() => true);
    expect(v.game!.players.find((p) => p.playerId === a.id)!.cards).toEqual(before);
    expect(v.you.seat).not.toBeNull();
    expectOk(await act(a, { type: "call" }));
  });

  it("auto-folds a disconnected player after the grace period when they must act", async () => {
    const { players } = await startedTable(server, ["A", "B", "C"]);
    const a = actor(players);
    a.socket.disconnect();
    const others = players.filter((p) => p !== a);
    await others[0]!.waitFor((x) => x.game!.players.find((p) => p.playerId === a.id)!.status === "folded", 3000);
    await others[0]!.waitFor((x) => x.players.find((p) => p.playerId === a.id)!.away, 3000);
    expect(others[0]!.notices.some((n) => n.includes("folded"))).toBe(true);
  });

  it("does not fold a disconnected player who owes no decision", async () => {
    const { players } = await startedTable(server, ["A", "B", "C"]);
    const a = actor(players);
    const idle = players.filter((p) => p !== a).find((p) => p.state().game!.toActSeat !== p.state().you.seat)!;
    // Make sure the idle player is not next to act.
    const nextSeat = (() => {
      const g = a.state().game!;
      const seats = g.players.map((p) => p.seat).sort((x, y) => x - y);
      return seats.find((s) => s > g.toActSeat!) ?? seats[0];
    })();
    const sleeper = players.find((p) => p.state().you.seat !== nextSeat && p !== a) ?? idle;
    sleeper.socket.disconnect();
    await sleep(600);
    const g = a.state().game!;
    expect(g.players.find((p) => p.playerId === sleeper.id)!.status).toBe("active");
  });

  it("supersedes an older tab when the same player joins from a new one", async () => {
    const { code, players } = await startedTable(server, ["A", "B"]);
    const a = players[0]!;
    const second = await openSocket(server, a.cookie);
    const ack = await second.timeout(3000).emitWithAck("room:join", { code });
    expect(ack).toEqual({ ok: true });
    await sleep(100);
    expect(a.superseded).toBe(true);
    second.disconnect();
  });
});

describe("persistence and recovery", () => {
  it("restores a live hand after a server restart", async () => {
    const { code, players } = await startedTable(server, ["A", "B", "C"]);
    const a = actor(players);
    expectOk(await act(a, { type: "call" }));
    await settle(players);
    const before = players[0]!.state().game!;
    const myCardsBefore = players.map((p) => p.state().game!.players.find((x) => x.playerId === p.id)!.cards);

    // Restart on the same database (the "process" dies; Postgres keeps the data).
    const db = server.db;
    const config = server.config;
    for (const p of players) p.socket.disconnect();
    await server.close();
    await new Promise((r) => server.http.close(r));
    server = await startServer({ db, config });
    expect(server.restored).toBe(1);

    for (const p of players) {
      await p.reconnect(server);
      expectOk(await p.emit("room:join", { code }));
    }
    await settle(players);
    const after = players[0]!.state().game!;
    expect(after.handNo).toBe(before.handNo);
    expect(after.seq).toBe(before.seq);
    expect(after.toActSeat).toBe(before.toActSeat);
    expect(after.potTotal).toBe(before.potTotal);
    players.forEach((p, i) => expect(p.state().game!.players.find((x) => x.playerId === p.id)!.cards).toEqual(myCardsBefore[i]));
    // Play continues.
    expectOk(await act(actor(players), { type: "fold" }));
  });

  it("rejects an action cleanly when the database write fails, without changing state", async () => {
    const { players } = await startedTable(server, ["A", "B"]);
    const a = actor(players);
    const seq = a.state().game!.seq;
    const realTx = server.db.tx.bind(server.db);
    let failNext = true;
    server.db.tx = (fn) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("disk full"));
      }
      return realTx(fn);
    };
    const ack = await act(a, { type: "call" });
    expect(ack).toMatchObject({ ok: false, code: "persistence_failed" });
    const room = [...(server.rooms as unknown as { rooms: Map<string, { data: { hand: { seq: number } } }> }).rooms.values()][0]!;
    expect(room.data.hand.seq).toBe(seq);
    // A retry (new action id, same seq) succeeds exactly once.
    expectOk(await act(a, { type: "call" }));
    await settle(players);
    expect(players[0]!.state().game!.seq).toBe(seq + 1);
  });

  it("refuses to apply the same transition twice (settlement idempotency)", async () => {
    const { players } = await startedTable(server, ["A", "B"]);
    const room = [...(server.rooms as unknown as { rooms: Map<string, import("../src/room.ts").Room> }).rooms.values()][0]!;
    const prev = structuredClone(room.data);
    const a = actor(players);
    expectOk(await act(a, { type: "fold" })); // heads-up: fold ends the hand and settles
    const next = structuredClone(room.data);
    // Re-applying the same settlement from the old version must fail and write nothing.
    await expect(server.store.commit(prev, next, null)).rejects.toThrow();
    const rows = await server.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM hand_players`);
    expect(rows[0]!.n).toBe(2);
  });

  it("ends a session on host request and records standings", async () => {
    const { players } = await startedTable(server, ["Ava", "Ben"]);
    expectOk(await players[0]!.emit("room:end"));
    await players[1]!.waitFor((x) => x.endRequested);
    await finishHandByFolding(players);
    const v: RoomView = await players[1]!.waitFor((x) => x.status === "finished");
    expect(v.status).toBe("finished");
    const history = await players[1]!.api<{ sessions: SessionSummary[] }>("/api/history");
    const s = history.body.sessions[0]!;
    expect(s.status).toBe("finished");
    expect(s.players.reduce((sum, p) => sum + p.net, 0)).toBe(0);
    // A finished room can't be joined, whether or not it is still in memory.
    expect(await players[0]!.emit("room:join", { code: v.code })).toMatchObject({ ok: false, code: "room_finished" });
    (server.rooms as unknown as { rooms: Map<string, unknown> }).rooms.clear();
    expect(await players[0]!.emit("room:join", { code: v.code })).toMatchObject({ ok: false, code: "room_finished" });
  });

  it("finishes automatically when one player has every chip", async () => {
    const { players } = await startedTable(server, ["A", "B"], { startingStack: 200, smallBlind: 10, bigBlind: 20 });
    for (let guard = 0; guard < 400; guard++) {
      const v = players[0]!.state();
      if (v.status === "finished") break;
      if (!v.game || v.game.street === "complete" || v.game.toActSeat === null) {
        await players[0]!.waitFor((x) => x.status === "finished" || (x.game?.toActSeat ?? null) !== null);
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
    const v = await players[0]!.waitFor((x) => x.status === "finished");
    expect(v.players.map((p) => p.stack).sort((x, y) => x - y)).toEqual([0, 400]);
  });
});
