import { describe, expect, it } from "vitest";
import { ActionError, applyAction, assertInvariants, freshDeck, legalActions, startHand, type Action, type HandState } from "../src/index.ts";
import { actorId, deal, player } from "./helpers.ts";

function act(state: HandState, id: string, action: Action): HandState {
  expect(actorId(state)).toBe(id);
  const next = applyAction(state, id, action);
  assertInvariants(next);
  return next;
}

function expectError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ActionError);
    expect((e as ActionError).code).toBe(code);
    return;
  }
  throw new Error("expected an ActionError");
}

describe("blinds and order", () => {
  it("posts blinds left of the button and starts action under the gun", () => {
    const s = deal([1000, 1000, 1000, 1000], { button: 0 });
    expect(s.sbSeat).toBe(1);
    expect(s.bbSeat).toBe(2);
    expect(player(s, "B").streetBet).toBe(5);
    expect(player(s, "C").streetBet).toBe(10);
    expect(actorId(s)).toBe("D");
    expect(s.currentBet).toBe(10);
    assertInvariants(s);
  });

  it("wraps the blinds around the table", () => {
    const s = deal([1000, 1000, 1000], { button: 2 });
    expect(s.sbSeat).toBe(0);
    expect(s.bbSeat).toBe(1);
    expect(actorId(s)).toBe("C");
  });

  it("heads-up: the button posts the small blind and acts first pre-flop, last after", () => {
    let s = deal([1000, 1000], { button: 1 });
    expect(s.sbSeat).toBe(1);
    expect(s.bbSeat).toBe(0);
    expect(actorId(s)).toBe("B");
    s = act(s, "B", { type: "call" });
    // Big blind keeps the option.
    expect(legalActions(s, 0)).toMatchObject({ canCheck: true, raiseKind: "raise", minRaiseTo: 20 });
    s = act(s, "A", { type: "check" });
    expect(s.street).toBe("flop");
    expect(actorId(s)).toBe("A"); // big blind acts first post-flop
    s = act(s, "A", { type: "check" });
    s = act(s, "B", { type: "check" });
    expect(s.street).toBe("turn");
    expect(actorId(s)).toBe("A");
  });

  it("gives the big blind the option when limped to", () => {
    let s = deal([1000, 1000, 1000], { button: 0 });
    s = act(s, "A", { type: "call" });
    s = act(s, "B", { type: "call" });
    expect(s.street).toBe("preflop");
    expect(actorId(s)).toBe("C");
    s = act(s, "C", { type: "raise", amount: 30 });
    expect(actorId(s)).toBe("A");
  });

  it("first to act post-flop is the first live player left of the button", () => {
    let s = deal([1000, 1000, 1000, 1000], { button: 0 });
    s = act(s, "D", { type: "call" });
    s = act(s, "A", { type: "call" });
    s = act(s, "B", { type: "fold" });
    s = act(s, "C", { type: "check" });
    expect(s.street).toBe("flop");
    expect(s.board).toHaveLength(3);
    expect(actorId(s)).toBe("C");
  });
});

describe("posting to enter", () => {
  it("a returning player posts a live big blind and keeps the option", () => {
    const seats = [0, 1, 2, 3].map((i) => ({ playerId: String.fromCharCode(65 + i), seat: i, stack: 1000 }));
    let s = startHand({
      handNo: 1,
      config: { smallBlind: 5, bigBlind: 10 },
      buttonSeat: 0, // sb B, bb C, D posts
      seats,
      deck: freshDeck(),
      posting: ["D", "B"], // B is already the small blind: no extra post
    });
    assertInvariants(s);
    expect(s.events.filter((e) => e.kind === "blind").map((e) => [e.playerId, (e as { blind: string }).blind, (e as { amount: number }).amount])).toEqual([
      ["B", "small", 5],
      ["C", "big", 10],
      ["D", "post", 10],
    ]);
    expect(player(s, "D").streetBet).toBe(10);
    // D (first to act after the big blind) already matches the bet but still has an option.
    expect(actorId(s)).toBe("D");
    expect(legalActions(s, 3)).toMatchObject({ canCheck: true, raiseKind: "raise" });
    s = applyAction(s, "D", { type: "check" });
    s = applyAction(s, "A", { type: "call" });
    s = applyAction(s, "B", { type: "call" });
    s = applyAction(s, "C", { type: "check" });
    expect(s.street).toBe("flop");
    expect(s.players.reduce((t, p) => t + p.totalBet, 0)).toBe(40);
  });
});

describe("bets and raises", () => {
  it("enforces the minimum opening bet and minimum raise", () => {
    let s = deal([1000, 1000, 1000], { button: 0 });
    expect(legalActions(s, 0)).toMatchObject({ callAmount: 10, raiseKind: "raise", minRaiseTo: 20, maxRaiseTo: 1000 });
    expectError(() => applyAction(s, "A", { type: "raise", amount: 15 }), "invalid_amount");
    s = act(s, "A", { type: "raise", amount: 35 }); // raise by 25
    expect(legalActions(s, 1)).toMatchObject({ callAmount: 30, minRaiseTo: 60 });
    s = act(s, "B", { type: "raise", amount: 100 }); // raise by 65
    expect(legalActions(s, 2)!.minRaiseTo).toBe(165);
    s = act(s, "C", { type: "fold" });
    s = act(s, "A", { type: "call" });
    expect(s.street).toBe("flop");
    expect(legalActions(s, 1)).toMatchObject({ canCheck: true, callAmount: 0, raiseKind: "bet", minRaiseTo: 10 });
    expectError(() => applyAction(s, "B", { type: "raise", amount: 50 }), "illegal_action");
    expectError(() => applyAction(s, "B", { type: "bet", amount: 5 }), "invalid_amount");
    s = act(s, "B", { type: "bet", amount: 40 });
    expect(legalActions(s, 0)).toMatchObject({ callAmount: 40, raiseKind: "raise", minRaiseTo: 80 });
    expectError(() => applyAction(s, "A", { type: "check" }), "illegal_action");
  });

  it("rejects actions out of turn, from unknown players, and after the hand", () => {
    let s = deal([1000, 1000, 1000]);
    expectError(() => applyAction(s, "B", { type: "call" }), "not_your_turn");
    expectError(() => applyAction(s, "Z", { type: "call" }), "not_in_hand");
    s = act(s, "A", { type: "fold" });
    s = act(s, "B", { type: "fold" });
    expect(s.street).toBe("complete");
    expectError(() => applyAction(s, "C", { type: "check" }), "hand_complete");
  });

  it("cannot bet more than the stack", () => {
    const s = deal([200, 1000, 1000]);
    expectError(() => applyAction(s, "A", { type: "raise", amount: 201 }), "invalid_amount");
    expect(legalActions(s, 0)!.maxRaiseTo).toBe(200);
  });

  it("does not mutate the input state", () => {
    const s = deal([1000, 1000, 1000]);
    const snapshot = JSON.stringify(s);
    applyAction(s, "A", { type: "raise", amount: 50 });
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it("ends the hand when everyone folds and returns the uncalled bet", () => {
    let s = deal([1000, 1000, 1000]);
    s = act(s, "A", { type: "raise", amount: 50 });
    s = act(s, "B", { type: "fold" });
    s = act(s, "C", { type: "fold" });
    expect(s.result!.endedBy).toBe("fold");
    expect(s.result!.refund).toEqual({ playerId: "A", amount: 40 });
    expect(s.result!.stacks).toEqual({ A: 1015, B: 995, C: 990 });
    expect(s.result!.shown).toEqual([]);
  });
});

describe("all-ins", () => {
  it("a short call puts the player all-in for less", () => {
    let s = deal([1000, 60, 1000], { button: 2 }); // A sb, B bb? button 2 -> sb A(0), bb B(1)
    s = act(s, "C", { type: "raise", amount: 200 });
    s = act(s, "A", { type: "fold" });
    expect(legalActions(s, 1)).toMatchObject({ callAmount: 50, raiseKind: null, canAllIn: true });
    s = act(s, "B", { type: "call" });
    expect(player(s, "B").status).toBe("allin");
    expect(s.street).toBe("complete"); // nobody left to bet against; board runs out
    expect(s.board).toHaveLength(5);
    expect(s.result!.refund).toEqual({ playerId: "C", amount: 140 });
  });

  it("a short all-in raise does not reopen betting for players who already acted", () => {
    // A opens to 100, B shoves 150 (short raise), C calls. A may only call or fold.
    let s = deal([1000, 150, 1000, 1000], { button: 3 }); // sb A, bb B, utg C
    s = act(s, "C", { type: "raise", amount: 100 });
    s = act(s, "D", { type: "call" });
    s = act(s, "A", { type: "fold" });
    s = act(s, "B", { type: "allin" });
    expect(player(s, "B").streetBet).toBe(150);
    expect(s.currentBet).toBe(150);
    expect(s.minRaise).toBe(90); // unchanged by the short raise
    expect(legalActions(s, 2)).toMatchObject({ callAmount: 50, raiseKind: null, canAllIn: false });
    expectError(() => applyAction(s, "C", { type: "raise", amount: 400 }), "illegal_action");
    expectError(() => applyAction(s, "C", { type: "allin" }), "illegal_action");
    s = act(s, "C", { type: "call" });
    expect(legalActions(s, 3)!.raiseKind).toBeNull();
    s = act(s, "D", { type: "call" });
    expect(s.street).toBe("flop");
  });

  it("a player who has not yet acted may re-raise over a short all-in", () => {
    let s = deal([1000, 1000, 130, 1000], { button: 0 }); // sb B, bb C, utg D
    s = act(s, "D", { type: "raise", amount: 100 });
    s = act(s, "A", { type: "fold" });
    // B (small blind) has not acted voluntarily; C is short.
    s = act(s, "B", { type: "call" });
    s = act(s, "C", { type: "allin" }); // 130: raise of 30 < 90, short
    expect(legalActions(s, 3)!.raiseKind).toBeNull();
  });

  it("a full all-in raise reopens the betting", () => {
    let s = deal([1000, 1000, 400], { button: 0 }); // sb B, bb C, utg A
    s = act(s, "A", { type: "raise", amount: 100 });
    s = act(s, "B", { type: "call" });
    s = act(s, "C", { type: "allin" }); // 400: raise of 300 >= 90
    expect(s.minRaise).toBe(300);
    expect(legalActions(s, 0)).toMatchObject({ callAmount: 300, raiseKind: "raise", minRaiseTo: 700 });
  });

  it("several short all-ins that add up to a full raise reopen the betting", () => {
    let s = deal([1000, 1000, 160, 230], { button: 1 }); // sb C, bb D, utg A
    s = act(s, "A", { type: "raise", amount: 100 }); // minRaise 90
    s = act(s, "B", { type: "call" });
    s = act(s, "C", { type: "allin" }); // 160 (+60, short)
    s = act(s, "D", { type: "allin" }); // 230 (+70, short) — A faces +130 >= 90
    expect(legalActions(s, 0)!.raiseKind).toBe("raise");
    expect(legalActions(s, 0)!.minRaiseTo).toBe(320);
  });

  it("an all-in big blind for less than the blind still requires the full blind to call", () => {
    let s = deal([1000, 1000, 6], { button: 0 }); // sb B, bb C (6 chips)
    expect(player(s, "C").status).toBe("allin");
    expect(s.currentBet).toBe(10);
    expect(legalActions(s, 0)!.callAmount).toBe(10);
    s = act(s, "A", { type: "call" });
    s = act(s, "B", { type: "call" });
    expect(s.street).toBe("flop");
  });

  it("heads-up all-in from the blinds runs out the board immediately", () => {
    const s = deal([5, 8], { button: 0 }); // A posts sb 5 (all-in), B posts 8 (all-in)
    expect(s.street).toBe("complete");
    expect(s.board).toHaveLength(5);
    expect(s.result!.refund).toEqual({ playerId: "B", amount: 3 });
    assertInvariants(s);
  });

  it("does not ask the last player with chips to act when they already cover every all-in", () => {
    const s = deal([1000, 3], { button: 0 }); // A sb 5, B bb all-in for 3
    expect(s.street).toBe("complete");
    expect(s.result!.refund).toEqual({ playerId: "A", amount: 2 });
  });

  it("no raising when every opponent is all-in", () => {
    let s = deal([1000, 1000, 1000], { button: 0 });
    s = act(s, "A", { type: "allin" });
    s = act(s, "B", { type: "fold" });
    expect(legalActions(s, 2)).toMatchObject({ raiseKind: null, callAmount: 990, canAllIn: true });
  });
});
