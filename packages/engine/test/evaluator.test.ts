import { describe, expect, it } from "vitest";
import { compareHands, describeHand, evaluateBest, evaluate5, HandCategory, parseCards } from "../src/index.ts";

const best = (s: string) => evaluateBest(parseCards(s));
const cmp = (a: string, b: string) => compareHands(best(a), best(b));

describe("hand categories", () => {
  const cases: [string, HandCategory][] = [
    ["As Ks Qs Js Ts", HandCategory.RoyalFlush],
    ["9h 8h 7h 6h 5h", HandCategory.StraightFlush],
    ["5d 4d 3d 2d Ad", HandCategory.StraightFlush],
    ["7c 7d 7h 7s 2d", HandCategory.FourOfAKind],
    ["Kc Kd Kh 4s 4d", HandCategory.FullHouse],
    ["Ac Jc 8c 5c 2c", HandCategory.Flush],
    ["Th 9c 8d 7s 6h", HandCategory.Straight],
    ["5h 4c 3d 2s Ah", HandCategory.Straight],
    ["Qs Qd Qh 9c 2d", HandCategory.ThreeOfAKind],
    ["Js Jd 4h 4c 9d", HandCategory.TwoPair],
    ["8s 8d Kh 4c 2d", HandCategory.OnePair],
    ["As Jd 9h 4c 2d", HandCategory.HighCard],
  ];
  for (const [cards, cat] of cases) {
    it(`${cards} is category ${HandCategory[cat]}`, () => {
      expect(evaluate5(parseCards(cards)).category).toBe(cat);
    });
  }

  it("orders every category correctly", () => {
    const hands = cases.map(([c]) => best(c)).reverse();
    for (let i = 1; i < hands.length; i++) {
      expect(compareHands(hands[i]!, hands[i - 1]!)).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not treat K-A-2-3-4 as a straight", () => {
    expect(evaluate5(parseCards("Kh Ad 2c 3s 4h")).category).toBe(HandCategory.HighCard);
  });
});

describe("tie-breaks", () => {
  it("the wheel is the lowest straight", () => {
    expect(cmp("5h 4c 3d 2s Ah", "6h 5c 4d 3s 2h")).toBe(-1);
    expect(describeHand(best("5h 4c 3d 2s Ah Kd Kc"))).toBe("Straight, Five high");
  });
  it("competing straights compare by top card", () => {
    expect(cmp("Th 9c 8d 7s 6h 2c 2d", "9h 8c 7d 6s 5h Ac Ad")).toBe(1);
    expect(cmp("Ah Kc Qd Js Th", "Kh Qc Jd Ts 9h")).toBe(1);
  });
  it("flushes compare kicker by kicker", () => {
    expect(cmp("Ac Jc 8c 5c 2c", "Ad Jd 8d 4d 3d")).toBe(1);
    expect(cmp("Ac Jc 8c 5c 2c", "Ad Jd 8d 5d 2d")).toBe(0);
    expect(cmp("Kc Qc Jc 9c 7c", "Ad 5d 4d 3d 7d")).toBe(-1);
  });
  it("full houses compare trips, then pair", () => {
    expect(cmp("Kc Kd Kh 2s 2d", "Qc Qd Qh As Ad")).toBe(1);
    expect(cmp("Kc Kd Kh 9s 9d 2c 3c", "Kc Kd Kh 8s 8d 2c 3c")).toBe(1);
  });
  it("full house from two sets of trips uses the higher trips", () => {
    const v = best("9c 9d 9h 4s 4d 4h 2c");
    expect(v.category).toBe(HandCategory.FullHouse);
    expect(v.score).toEqual([HandCategory.FullHouse, 9, 4]);
  });
  it("two pair: high pair, low pair, kicker", () => {
    expect(cmp("Js Jd 4h 4c 9d", "Jh Jc 3h 3c Ad")).toBe(1);
    expect(cmp("Js Jd 4h 4c 9d", "Jh Jc 4s 4d 8d")).toBe(1);
    // Three pairs: best two pairs plus the best remaining kicker.
    expect(best("Ks Kd 7h 7c 3s 3d Qc").score).toEqual([HandCategory.TwoPair, 13, 7, 12]);
  });
  it("pairs and high cards use all kickers", () => {
    expect(cmp("8s 8d Kh 4c 3d", "8h 8c Kd 4s 2d")).toBe(1);
    expect(cmp("As Jd 9h 4c 3d", "Ah Jc 9d 4s 2d")).toBe(1);
  });
  it("quads compare kicker", () => {
    expect(cmp("7c 7d 7h 7s Ad Kc 2d", "7c 7d 7h 7s Kd Qc 2d")).toBe(1);
  });
  it("straight flush beats a higher regular straight and steel wheel beats quads", () => {
    expect(cmp("5d 4d 3d 2d Ad", "Ac Ad Ah As Kd")).toBe(1);
  });
});

describe("best five of seven", () => {
  it("plays the board when the board is best (zero hole cards)", () => {
    const board = "Ts Js Qs Ks As";
    expect(best(`2c 3d ${board}`).category).toBe(HandCategory.RoyalFlush);
    expect(cmp(`2c 3d ${board}`, `4c 5d ${board}`)).toBe(0);
  });
  it("uses exactly one hole card", () => {
    const v = best("Ah 2c Kd Kc Ks 7h 3d");
    expect(v.category).toBe(HandCategory.ThreeOfAKind);
    expect(v.score).toEqual([HandCategory.ThreeOfAKind, 13, 14, 7]);
    expect(v.cards).toContain("Ah");
    expect(v.cards).not.toContain("2c");
  });
  it("uses two hole cards", () => {
    const v = best("9h 8h Th Jh 2c 3d Qh");
    expect(v.category).toBe(HandCategory.StraightFlush);
    expect(v.cards).toEqual(expect.arrayContaining(["9h", "8h"]));
  });
  it("ties when both players share the best five cards", () => {
    // Board straight; both hole cards irrelevant.
    expect(cmp("2c 2d 5h 6c 7d 8s 9h", "Ac Kd 5h 6c 7d 8s 9h")).toBe(0);
    expect(cmp("Tc 2d 5h 6c 7d 8s 9h", "Ac Kd 5h 6c 7d 8s 9h")).toBe(1);
    expect(cmp("2c 3c 5h 6c 7d 8s 9h", "2d 3d 5h 6c 7d 8s 9h")).toBe(0);
  });
  it("prefers the flush over a straight on the same cards", () => {
    expect(best("6h 7h 8c 9h Th 2h Kd").category).toBe(HandCategory.Flush);
  });
  it("finds the highest straight among six connected cards", () => {
    expect(best("4c 5d 6h 7s 8c 9d 2h").score).toEqual([HandCategory.Straight, 9]);
  });
  it("chooses the best flush of six suited cards", () => {
    expect(best("Ah Kh 2h 3h 4h 9h 5h").score).toEqual([HandCategory.StraightFlush, 5]);
    expect(best("Ah Kh 2h 3h 4h 9h 5c").score).toEqual([HandCategory.Flush, 14, 13, 9, 4, 3]);
    expect(best("Ah Kh 2h 3h 7h 9h 5c").score).toEqual([HandCategory.Flush, 14, 13, 9, 7, 3]);
  });
});
