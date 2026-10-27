import { describe, expect, it } from "vitest";
import {
  applyAction,
  assertInvariants,
  compareHands,
  equity,
  evaluateBest,
  freshDeck,
  parseCards,
  rank7,
  shuffle,
  type Action,
  type HandState,
} from "../src/index.ts";
import { actorId, deal } from "./helpers.ts";

function play(s: HandState, ...steps: [string, Action][]): HandState {
  for (const [id, a] of steps) {
    expect(actorId(s)).toBe(id);
    s = applyAction(s, id, a);
    assertInvariants(s);
  }
  return s;
}

describe("rank7", () => {
  it("orders random hands exactly like the reference evaluator", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 30000; i++) {
      const d = shuffle(freshDeck(), rnd);
      const a = d.slice(0, 7);
      const b = d.slice(7, 14);
      const expected = compareHands(evaluateBest(a), evaluateBest(b));
      expect(Math.sign(rank7(a) - rank7(b))).toBe(expected);
    }
  });

  it("handles the edge cases", () => {
    const r = (s: string) => rank7(parseCards(s));
    expect(r("Ah 2c 3d 4s 5h 9c Kd")).toBeLessThan(r("2h 3c 4d 5s 6h 9c Kd")); // wheel < six-high straight
    expect(r("As Ks Qs Js Ts 2c 3c")).toBeGreaterThan(r("9s 8s 7s 6s 5s Ac Ad"));
    expect(r("9c 9d 9h 4s 4d 4h 2c")).toBe(r("9c 9d 9h 4s 4d 2s 3c")); // 999-44 either way
    expect(r("Ks Kd 7h 7c 3s 3d Qc")).toBeGreaterThan(r("Ks Kd 7h 7c 3s 3d Jc"));
  });
});

describe("equity", () => {
  it("matches well-known preflop numbers within sampling error", () => {
    const e = equity(
      [
        { playerId: "aa", hole: parseCards("As Ah") },
        { playerId: "kk", hole: parseCards("Ks Kh") },
      ],
      [],
      { samples: 20000 },
    );
    expect(e.aa).toBeGreaterThan(0.79);
    expect(e.aa).toBeLessThan(0.85);
    expect(e.aa! + e.kk!).toBeCloseTo(1, 6);
  });

  it("is exact on the turn and splits ties", () => {
    // Both play the board's broadway draw identically: every river is a tie.
    const tie = equity(
      [
        { playerId: "a", hole: parseCards("2c 3d") },
        { playerId: "b", hole: parseCards("2h 3s") },
      ],
      parseCards("Ts Jd Qc Kh"),
    );
    expect(tie.a).toBeCloseTo(0.5, 6);
    // Set over set: the nines need the last nine (one out among 44 unseen cards).
    const e = equity(
      [
        { playerId: "nines", hole: parseCards("9s 9h") },
        { playerId: "aces", hole: parseCards("Ah Ad") },
      ],
      parseCards("Ac 9d 2s 5h"),
    );
    expect(e.nines).toBeCloseTo(1 / 44, 6);
  });
});

describe("showdown order and mucking", () => {
  it("the called river bettor shows first; a losing caller mucks", () => {
    let s = deal([1000, 1000], {
      button: 0, // A is SB/button, B is BB
      holes: { A: "As Ks", B: "2c 7d" },
      board: "Ac 9h 4d 3s Jc",
    });
    s = play(s, ["A", { type: "call" }], ["B", { type: "check" }]);
    for (let i = 0; i < 2; i++) s = play(s, ["B", { type: "check" }], ["A", { type: "check" }]);
    s = play(s, ["B", { type: "bet", amount: 20 }], ["A", { type: "call" }]);
    // B bet the river and was called: B shows first and loses; A wins and shows.
    expect(s.result!.shown.map((x) => x.playerId)).toEqual(["B", "A"]);
    expect(s.result!.mucked).toEqual([]);

    let t = deal([1000, 1000], { button: 0, holes: { A: "2c 7d", B: "As Ks" }, board: "Ac 9h 4d 3s Jc" });
    t = play(t, ["A", { type: "call" }], ["B", { type: "check" }]);
    for (let i = 0; i < 2; i++) t = play(t, ["B", { type: "check" }], ["A", { type: "check" }]);
    t = play(t, ["B", { type: "bet", amount: 20 }], ["A", { type: "call" }]);
    // B shows the winner first; A loses and may muck.
    expect(t.result!.shown.map((x) => x.playerId)).toEqual(["B"]);
    expect(t.result!.mucked).toEqual(["A"]);
  });

  it("with no river bet, the first player left of the button shows first", () => {
    let s = deal([1000, 1000, 1000], {
      button: 0, // sb B, bb C
      holes: { A: "Kc Kd", B: "2c 7d", C: "3h 8s" },
      board: "Ac 9h 4d Js 5c",
    });
    s = play(s, ["A", { type: "call" }], ["B", { type: "call" }], ["C", { type: "check" }]);
    for (let i = 0; i < 3; i++) s = play(s, ["B", { type: "check" }], ["C", { type: "check" }], ["A", { type: "check" }]);
    expect(s.result!.shown.map((x) => x.playerId)).toEqual(["B", "A"]);
    expect(s.result!.mucked).toEqual(["C"]);
  });

  it("an all-in runout tables every hand and records equity by street", () => {
    let s = deal([1000, 1000], { button: 0, holes: { A: "As Ah", B: "Ks Kh" }, board: "2c 7d 9h 3s 4c" });
    s = play(s, ["A", { type: "allin" }], ["B", { type: "call" }]);
    const r = s.result!;
    expect(s.runoutFrom).toBe(0);
    expect(r.shown).toHaveLength(2);
    expect(r.mucked).toEqual([]);
    expect(r.equity.map((e) => e.board)).toEqual([0, 3, 4]);
    expect(r.equity[0]!.equity.A).toBeGreaterThan(0.75);
    // On this turn KK is drawing to two kings: 2/44.
    expect(r.equity[2]!.equity.B).toBeCloseTo(2 / 44, 6);
  });

  it("an all-in player always shows even when not everyone was all-in", () => {
    let s = deal([1000, 1000, 100], {
      button: 0, // sb B, bb C (short)
      holes: { A: "2c 7d", B: "Qs Qh", C: "Ks 3d" },
      board: "Ac 9h 4d Js 5c",
    });
    s = play(s, ["A", { type: "call" }], ["B", { type: "call" }], ["C", { type: "allin" }], ["A", { type: "call" }], ["B", { type: "call" }]);
    for (let i = 0; i < 3; i++) s = play(s, ["B", { type: "check" }], ["A", { type: "check" }]);
    const shownIds = s.result!.shown.map((x) => x.playerId);
    expect(shownIds).toContain("C");
    expect(shownIds).toContain("B");
    expect(s.result!.mucked).toEqual(["A"]);
  });
});
