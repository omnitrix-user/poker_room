import { describe, expect, it } from "vitest";
import {
  applyAction,
  findInvariantViolations,
  freshDeck,
  legalActions,
  nextBlinds,
  shuffle,
  type BlindPositions,
  startHand,
  type Action,
  type HandState,
} from "../src/index.ts";

/** Small deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomAction(state: HandState, rnd: () => number): Action {
  const legal = legalActions(state, state.toAct!)!;
  const options: Action[] = [];
  if (legal.canCheck) options.push({ type: "check" }, { type: "check" });
  else options.push({ type: "call" }, { type: "call" }, { type: "fold" });
  if (legal.raiseKind) {
    const span = legal.maxRaiseTo - legal.minRaiseTo;
    const amount = legal.minRaiseTo + Math.floor(rnd() * rnd() * (span + 1));
    options.push({ type: legal.raiseKind, amount });
  }
  if (legal.canAllIn && rnd() < 0.3) options.push({ type: "allin" });
  return options[Math.floor(rnd() * options.length)]!;
}

describe("randomized hands", () => {
  it("every reachable state satisfies the invariants and chips are conserved", () => {
    const rnd = mulberry32(20261026);
    const randInt = (n: number) => Math.floor(rnd() * n);
    let hands = 0;
    let deadBlinds = 0;
    let showdowns = 0;
    let sidePots = 0;
    for (let game = 0; game < 400; game++) {
      const n = 2 + randInt(7);
      const bb = 2 * (1 + randInt(50));
      let stacks = Array.from({ length: n }, (_, i) => ({
        playerId: `p${i}`,
        seat: i * 1 + (i >= 3 ? 1 : 0), // leave a gap to exercise non-contiguous seats
        stack: 1 + randInt(bb * 60),
      }));
      let blinds: BlindPositions | null = null;
      for (let handNo = 1; handNo <= 30 && stacks.length >= 2; handNo++) {
        blinds = nextBlinds(
          stacks.map((p) => p.seat),
          blinds,
          (seats) => seats[randInt(seats.length)]!,
        );
        if (blinds.sbSeat === null) deadBlinds++;
        let s = startHand({
          handNo,
          config: { smallBlind: bb / 2, bigBlind: bb },
          buttonSeat: blinds.buttonSeat,
          seats: stacks,
          deck: shuffle(freshDeck(), randInt),
          blinds: { sbSeat: blinds.sbSeat, bbSeat: blinds.bbSeat },
        });
        const total = stacks.reduce((a, p) => a + p.stack, 0);
        let guard = 0;
        while (s.street !== "complete") {
          expect(findInvariantViolations(s)).toEqual([]);
          const actor = s.players.find((p) => p.seat === s.toAct)!;
          // A wrong player must always be rejected.
          const other = s.players.find((p) => p.seat !== s.toAct)!;
          expect(() => applyAction(s, other.playerId, { type: "fold" })).toThrow();
          s = applyAction(s, actor.playerId, randomAction(s, rnd));
          if (++guard > 500) throw new Error("hand did not terminate");
        }
        expect(findInvariantViolations(s)).toEqual([]);
        expect(Object.values(s.result!.stacks).reduce((a, b) => a + b, 0)).toBe(total);
        hands++;
        if (s.result!.endedBy === "showdown") showdowns++;
        if (s.result!.pots.length > 1) sidePots++;
        stacks = s.players.map((p) => ({ playerId: p.playerId, seat: p.seat, stack: p.stack })).filter((p) => p.stack > 0);
      }
    }
    expect(deadBlinds).toBeGreaterThan(20);
    // Make sure the fuzzer actually exercises the interesting paths.
    expect(hands).toBeGreaterThan(3000);
    expect(showdowns).toBeGreaterThan(300);
    expect(sidePots).toBeGreaterThan(50);
  });

  it("the shuffle produces each card in each position with roughly uniform frequency", () => {
    const counts = new Map<string, number>();
    const trials = 20000;
    for (let i = 0; i < trials; i++) {
      const top = shuffle(freshDeck())[0]!;
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    expect(counts.size).toBe(52);
    const expected = trials / 52;
    for (const c of counts.values()) expect(Math.abs(c - expected)).toBeLessThan(expected * 0.35);
  });
});
