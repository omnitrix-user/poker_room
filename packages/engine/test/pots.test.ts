import { describe, expect, it } from "vitest";
import { applyAction, assertInvariants, buildPots, splitUncalled, type HandState, type Action } from "../src/index.ts";
import { actorId, deal } from "./helpers.ts";

function play(s: HandState, ...steps: [string, Action][]): HandState {
  for (const [id, a] of steps) {
    expect(actorId(s)).toBe(id);
    s = applyAction(s, id, a);
    assertInvariants(s);
  }
  return s;
}

describe("pot construction", () => {
  it("builds main and side pots from contribution levels", () => {
    const pots = buildPots([
      { playerId: "A", amount: 100, folded: false },
      { playerId: "B", amount: 300, folded: false },
      { playerId: "C", amount: 500, folded: false },
      { playerId: "D", amount: 500, folded: false },
    ]);
    expect(pots).toEqual([
      { amount: 400, eligible: ["A", "B", "C", "D"] },
      { amount: 600, eligible: ["B", "C", "D"] },
      { amount: 400, eligible: ["C", "D"] },
    ]);
  });

  it("counts folded chips without making the folder eligible", () => {
    const pots = buildPots([
      { playerId: "A", amount: 50, folded: false },
      { playerId: "B", amount: 200, folded: true },
      { playerId: "C", amount: 200, folded: false },
    ]);
    expect(pots).toEqual([
      { amount: 150, eligible: ["A", "C"] },
      { amount: 300, eligible: ["C"] },
    ]);
  });

  it("returns only the unmatched part of the largest bet", () => {
    const { refund, contribs } = splitUncalled([
      { playerId: "A", amount: 100, folded: false },
      { playerId: "B", amount: 400, folded: false },
      { playerId: "C", amount: 250, folded: true },
    ]);
    expect(refund).toEqual({ playerId: "B", amount: 150 });
    expect(contribs.find((c) => c.playerId === "B")!.amount).toBe(250);
  });
});

describe("settlement", () => {
  it("three unequal all-ins: each pot goes to the best eligible hand", () => {
    // A has the best hand but only covers the main pot; B wins the side pot over C.
    let s = deal([100, 300, 500], {
      button: 2, // sb A, bb B, C first
      holes: { A: "As Ad", B: "Ks Kd", C: "Qs Qd" },
      board: "2c 7h 9d Jc 3s",
    });
    s = play(s, ["C", { type: "allin" }], ["A", { type: "allin" }], ["B", { type: "allin" }]);
    const r = s.result!;
    expect(r.endedBy).toBe("showdown");
    expect(r.refund).toEqual({ playerId: "C", amount: 200 });
    expect(r.pots.map((p) => [p.amount, p.winners])).toEqual([
      [300, [{ playerId: "A", amount: 300 }]],
      [400, [{ playerId: "B", amount: 400 }]],
    ]);
    expect(r.stacks).toEqual({ A: 300, B: 400, C: 200 });
    expect(r.shown.map((x) => x.playerId).sort()).toEqual(["A", "B", "C"]);
  });

  it("a folded player's chips stay in the pot but they cannot win it", () => {
    let s = deal([1000, 1000, 200], {
      button: 0, // sb B, bb C, A first
      holes: { A: "2c 7d", B: "As Ah", C: "Ks Kh" },
      board: "3c 8h 9d Jc 4s",
    });
    s = play(
      s,
      ["A", { type: "raise", amount: 300 }],
      ["B", { type: "call" }],
      ["C", { type: "allin" }],
      // flop: B acts first; A folds after contributing 300
      ["B", { type: "bet", amount: 100 }],
      ["A", { type: "fold" }],
    );
    const r = s.result!;
    expect(r.endedBy).toBe("showdown");
    // Main pot: 200 x3 = 600 (A, B, C contributed). Side: A 100 + B 100 = 200 (B only eligible),
    // plus B's uncalled 100 flop bet returned.
    expect(r.refund).toEqual({ playerId: "B", amount: 100 });
    expect(r.pots).toEqual([
      expect.objectContaining({ amount: 600, eligible: ["B", "C"] }),
      expect.objectContaining({ amount: 200, eligible: ["B"] }),
    ]);
    expect(r.pots.flatMap((p) => p.winners.map((w) => w.playerId))).not.toContain("A");
    expect(r.stacks).toEqual({ A: 700, B: 1500, C: 0 });
  });

  it("splits tied pots and gives the odd chip to the first winner left of the button", () => {
    let s = deal([1000, 1000, 1000], {
      button: 0, // sb B, bb C
      sb: 5,
      bb: 10,
      holes: { A: "2c 3d", B: "Kc Qd", C: "Kh Qs" },
      board: "As Ad Jh Tc 4s",
    });
    s = play(
      s,
      ["A", { type: "call" }],
      ["B", { type: "call" }],
      ["C", { type: "check" }],
      ["B", { type: "bet", amount: 15 }],
      ["C", { type: "call" }],
      ["A", { type: "fold" }],
      ["B", { type: "check" }],
      ["C", { type: "check" }],
      ["B", { type: "check" }],
      ["C", { type: "check" }],
    );
    const pot = s.result!.pots[0]!;
    expect(pot.amount).toBe(60);
    expect(pot.winners).toEqual([
      { playerId: "B", amount: 30 },
      { playerId: "C", amount: 30 },
    ]);
    expect(pot.winningHand).toBe("Straight, Ace high");
  });

  it("odd chip distribution follows the documented house rule", () => {
    let u = deal([1000, 1000, 1000], {
      button: 0,
      sb: 5,
      bb: 10,
      holes: { A: "2c 3d", B: "Kh Qs", C: "Kc Qd" },
      board: "As Ad Jh Tc 4s",
    });
    // A raises then folds to a flop bet, leaving dead money that makes the pot odd (83).
    u = play(u, ["A", { type: "raise", amount: 21 }], ["B", { type: "call" }], ["C", { type: "call" }]);
    u = play(u, ["B", { type: "check" }], ["C", { type: "bet", amount: 10 }], ["A", { type: "fold" }], ["B", { type: "call" }]);
    for (let i = 0; i < 2; i++) u = play(u, ["B", { type: "check" }], ["C", { type: "check" }]);
    const odd = u.result!.pots[0]!;
    expect(odd.amount).toBe(83);
    // B is first left of the button (seat 0), so B receives the odd chip.
    expect(odd.winners).toEqual([
      { playerId: "B", amount: 42 },
      { playerId: "C", amount: 41 },
    ]);
  });

  it("four-way all-in with tied side pot winners", () => {
    let s = deal([50, 150, 300, 300], {
      button: 3, // sb A, bb B, C first
      holes: { A: "2c 2d", B: "Ah Kh", C: "Ad Kd", D: "Qc Js" },
      board: "As 7h 8d 3c 4s",
    });
    s = play(s, ["C", { type: "allin" }], ["D", { type: "allin" }], ["A", { type: "allin" }], ["B", { type: "allin" }]);
    const r = s.result!;
    // Main 200 (A,B,C,D): B and C tie with AK -> 100 each.
    // Side 1: 300 (B,C,D): split 150 each. Side 2: 300 (C,D): C wins.
    expect(r.pots.map((p) => p.amount)).toEqual([200, 300, 300]);
    expect(r.stacks).toEqual({ A: 0, B: 250, C: 550, D: 0 });
  });
});
