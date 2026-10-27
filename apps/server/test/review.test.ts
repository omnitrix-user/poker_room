import { io as connectClient } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, actor, expectOk, openSocket, settle, startedTable, startServer, type Server } from "./harness.ts";

let server: Server;
beforeEach(async () => {
  server = await startServer();
});
afterEach(async () => {
  await server.stop();
});

describe("review regressions", () => {
  it("a superseded tab can no longer act for the player", async () => {
    const { code, players } = await startedTable(server, ["A", "B"]);
    const a = actor(players);
    const g = a.state().game!;
    const newer = await openSocket(server, a.cookie);
    expect(await newer.timeout(3000).emitWithAck("room:join", { code })).toEqual({ ok: true });
    // The old socket is still connected but must be refused.
    const stale = await act(a, { type: "call" });
    expect(stale).toMatchObject({ ok: false, code: "not_member" });
    const fresh = await newer.timeout(3000).emitWithAck("game:action", {
      actionId: crypto.randomUUID(),
      handNo: g.handNo,
      seq: g.seq,
      action: { type: "call" },
    });
    expect(fresh).toEqual({ ok: true });
    newer.disconnect();
  });

  it("a player who leaves mid-hand is folded, never checked through", async () => {
    const { players } = await startedTable(server, ["A", "B", "C"]);
    const v = players[0]!.state();
    const bbSeat = v.game!.bbSeat;
    const bb = players.find((p) => p.state().you.seat === bbSeat)!;
    const others = players.filter((p) => p !== bb);
    expectOk(await bb.emit("room:leave"));
    // Everyone else limps, so the big blind could check for free.
    for (let i = 0; i < 2; i++) {
      const a = actor(others);
      expectOk(await act(a, { type: "call" }));
      await settle(others);
    }
    const after = await others[0]!.waitFor((x) => x.game!.players.find((p) => p.playerId === bb.id)!.status === "folded", 4000);
    const events = after.game!.events.filter((e) => e.kind === "action" && e.playerId === bb.id);
    expect(events.map((e) => (e.kind === "action" ? e.action : ""))).toEqual(["fold"]);
  });

  it("refuses state-changing API requests from another site", async () => {
    const res = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ name: "Mallory" }),
    });
    expect(res.status).toBe(403);
    const same = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url },
      body: JSON.stringify({ name: "Ok" }),
    });
    expect(same.status).toBe(200);
  });

  it("rejects socket connections from a foreign origin", async () => {
    const { cookie } = await (async () => {
      const res = await fetch(`${server.url}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ori" }),
      });
      return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
    })();
    const socket = connectClient(server.url, {
      transports: ["websocket"],
      extraHeaders: { cookie, origin: "https://evil.example" },
      reconnection: false,
      forceNew: true,
    });
    server.clients.push(socket);
    await expect(
      new Promise((resolve, reject) => {
        socket.once("connect", () => resolve("connected"));
        socket.once("connect_error", reject);
      }),
    ).rejects.toThrow();
  });
});
