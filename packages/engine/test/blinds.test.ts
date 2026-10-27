import { describe, expect, it } from "vitest";
import { applyAction, assertInvariants, freshDeck, legalActions, nextBlinds, shuffle, startHand, type BlindPositions } from "../src/index.ts";

describe("moving big blind", () => {
  it("rotates normally: button to the old small blind, old big blind posts the small blind", () => {
    let pos = nextBlinds([0, 2, 5, 7], null, () => 0);
    expect(pos).toEqual({ buttonSeat: 0, sbSeat: 2, bbSeat: 5 });
    const bbs: number[] = [];
    for (let i = 0; i < 8; i++) {
      const next = nextBlinds([0, 2, 5, 7], pos);
      expect(next.sbSeat).toBe(pos.bbSeat);
      expect(next.buttonSeat).toBe(pos.sbSeat);
      bbs.push(next.bbSeat);
      pos = next;
    }
    // Over two orbits everyone pays the big blind exactly twice.
    expect(bbs.sort()).toEqual([0, 0, 2, 2, 5, 5, 7, 7]);
  });

  it("when last hand's small blind busts, the button is dead on their empty seat", () => {
    const prev: BlindPositions = { buttonSeat: 0, sbSeat: 1, bbSeat: 2 };
    expect(nextBlinds([0, 2, 3], prev)).toEqual({ buttonSeat: 1, sbSeat: 2, bbSeat: 3 });
  });

  it("when last hand's big blind busts, the small blind is dead and the big blind still moves on", () => {
    const prev: BlindPositions = { buttonSeat: 0, sbSeat: 1, bbSeat: 2 };
    expect(nextBlinds([0, 1, 3], prev)).toEqual({ buttonSeat: 1, sbSeat: null, bbSeat: 3 });
  });

  it("heads-up alternates the big blind and the button posts the small blind", () => {
    let pos = nextBlinds([1, 4], null, () => 1);
    expect(pos).toEqual({ buttonSeat: 1, sbSeat: 1, bbSeat: 4 });
    for (let i = 0; i < 4; i++) {
      const next = nextBlinds([1, 4], pos);
      expect(next.bbSeat).not.toBe(pos.bbSeat);
      expect(next.sbSeat).toBe(next.buttonSeat);
      pos = next;
    }
  });

  it("going heads-up never gives the same player the big blind twice in a row", () => {
    const prev: BlindPositions = { buttonSeat: 0, sbSeat: 1, bbSeat: 2 };
    // Seat 1 busts: 0 and 2 remain; 2 just paid the big blind.
    const next = nextBlinds([0, 2], prev);
    expect(next).toEqual({ buttonSeat: 2, sbSeat: 2, bbSeat: 0 });
  });

  it("a player joining a heads-up game slots into the rotation", () => {
    const prev: BlindPositions = { buttonSeat: 0, sbSeat: 0, bbSeat: 3 };
    expect(nextBlinds([0, 3, 5], prev)).toEqual({ buttonSeat: 0, sbSeat: 3, bbSeat: 5 });
  });

  it("random arrivals and departures keep the blinds valid and fair", () => {
    let seed = 99;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let present = [0, 1, 2, 3, 4, 5];
    let pos = nextBlinds(present, null, (s) => s[rnd(s.length)]!);
    for (let hand = 0; hand < 5000; hand++) {
      // Occasionally someone leaves or arrives (keeping at least two players).
      if (rnd(10) === 0) {
        const seat = rnd(8);
        if (present.includes(seat)) {
          if (present.length > 2) present = present.filter((s) => s !== seat);
        } else present = [...present, seat].sort((a, b) => a - b);
      }
      const next = nextBlinds(present, pos);
      expect(present).toContain(next.bbSeat);
      if (next.sbSeat !== null) {
        expect(present).toContain(next.sbSeat);
        expect(next.sbSeat).not.toBe(next.bbSeat);
      }
      // Nobody pays the big blind twice in a row.
      expect(next.bbSeat === pos.bbSeat && present.length >= 2).toBe(false);
      if (present.length === 2) expect(next.sbSeat).toBe(next.buttonSeat);
      pos = next;
    }
  });
});

describe("hands with dead blinds", () => {
  const seats = [0, 2, 3].map((seat) => ({ playerId: `p${seat}`, seat, stack: 1000 }));

  it("plays a hand with a dead small blind and a dead button", () => {
    // Button on empty seat 1, no small blind, big blind seat 3.
    let s = startHand({
      handNo: 1,
      config: { smallBlind: 5, bigBlind: 10 },
      buttonSeat: 1,
      seats,
      deck: shuffle(freshDeck()),
      blinds: { sbSeat: null, bbSeat: 3 },
    });
    assertInvariants(s);
    expect(s.events.filter((e) => e.kind === "blind")).toHaveLength(1);
    // Pre-flop: first to act is left of the big blind.
    expect(s.toAct).toBe(0);
    s = applyAction(s, "p0", { type: "call" });
    s = applyAction(s, "p2", { type: "call" });
    expect(legalActions(s, 3)!.canCheck).toBe(true);
    s = applyAction(s, "p3", { type: "check" });
    // Post-flop: first live player left of the (dead) button seat 1 is seat 2.
    expect(s.street).toBe("flop");
    expect(s.toAct).toBe(2);
    while (s.street !== "complete") s = applyAction(s, s.players.find((p) => p.seat === s.toAct)!.playerId, { type: "check" });
    assertInvariants(s);
  });

  it("rejects impossible blind positions", () => {
    const base = { handNo: 1, config: { smallBlind: 5, bigBlind: 10 }, buttonSeat: 1, seats, deck: freshDeck() };
    expect(() => startHand({ ...base, blinds: { sbSeat: null, bbSeat: 1 } })).toThrow();
    expect(() => startHand({ ...base, blinds: { sbSeat: 3, bbSeat: 3 } })).toThrow();
  });
});
