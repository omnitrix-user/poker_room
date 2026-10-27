import { rankOf, suitOf, type Card } from "./cards.ts";

export enum HandCategory {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
  RoyalFlush = 9,
}

export const CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: "High card",
  [HandCategory.OnePair]: "One pair",
  [HandCategory.TwoPair]: "Two pair",
  [HandCategory.ThreeOfAKind]: "Three of a kind",
  [HandCategory.Straight]: "Straight",
  [HandCategory.Flush]: "Flush",
  [HandCategory.FullHouse]: "Full house",
  [HandCategory.FourOfAKind]: "Four of a kind",
  [HandCategory.StraightFlush]: "Straight flush",
  [HandCategory.RoyalFlush]: "Royal flush",
};

/**
 * A comparable hand strength. `score` is compared lexicographically:
 * [category, ...tiebreak ranks]. Two hands are equal iff their scores are equal.
 */
export interface HandValue {
  category: HandCategory;
  score: number[];
  /** The five cards that make the hand, ordered by significance. */
  cards: Card[];
}

export function compareHands(a: HandValue, b: HandValue): number {
  const n = Math.max(a.score.length, b.score.length);
  for (let i = 0; i < n; i++) {
    const d = (a.score[i] ?? 0) - (b.score[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Evaluates exactly five cards. */
export function evaluate5(cards: readonly Card[]): HandValue {
  if (cards.length !== 5) throw new Error("evaluate5 requires five cards");
  const ranks = cards.map(rankOf);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]!));

  // Group by rank: sort by (count desc, rank desc).
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0]);

  const distinct = [...counts.keys()].sort((x, y) => y - x);
  let straightHigh = 0;
  if (distinct.length === 5) {
    if (distinct[0]! - distinct[4]! === 4) straightHigh = distinct[0]!;
    // The wheel: A-2-3-4-5 plays as a five-high straight.
    else if (distinct[0] === 14 && distinct[1] === 5 && distinct[4] === 2) straightHigh = 5;
  }

  const orderedCards = orderCards(cards, groups, straightHigh);

  if (straightHigh && flush) {
    const category = straightHigh === 14 ? HandCategory.RoyalFlush : HandCategory.StraightFlush;
    return { category, score: [category, straightHigh], cards: orderedCards };
  }
  const shape = groups.map((g) => g[1]).join("");
  const groupRanks = groups.map((g) => g[0]);
  if (shape === "41") return value(HandCategory.FourOfAKind, groupRanks, orderedCards);
  if (shape === "32") return value(HandCategory.FullHouse, groupRanks, orderedCards);
  if (flush) return value(HandCategory.Flush, distinct, orderedCards);
  if (straightHigh) return value(HandCategory.Straight, [straightHigh], orderedCards);
  if (shape === "311") return value(HandCategory.ThreeOfAKind, groupRanks, orderedCards);
  if (shape === "221") return value(HandCategory.TwoPair, groupRanks, orderedCards);
  if (shape === "2111") return value(HandCategory.OnePair, groupRanks, orderedCards);
  return value(HandCategory.HighCard, distinct, orderedCards);
}

function value(category: HandCategory, tiebreak: number[], cards: Card[]): HandValue {
  return { category, score: [category, ...tiebreak], cards };
}

function orderCards(cards: readonly Card[], groups: [number, number][], straightHigh: number): Card[] {
  const byRankDesc = cards.slice().sort((a, b) => rankOf(b) - rankOf(a));
  if (straightHigh === 5) {
    // Show the wheel as 5-4-3-2-A.
    return [...byRankDesc.slice(1), byRankDesc[0]!];
  }
  const order = new Map(groups.map((g, i) => [g[0], i]));
  return byRankDesc.sort((a, b) => order.get(rankOf(a))! - order.get(rankOf(b))!);
}

/** Best five-card hand from 5–7 cards, by checking every five-card combination. */
export function evaluateBest(cards: readonly Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) throw new Error("evaluateBest requires 5 to 7 cards");
  let best: HandValue | null = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const v = evaluate5([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
            if (!best || compareHands(v, best) > 0) best = v;
          }
  return best!;
}

export function describeHand(v: HandValue): string {
  const name = (r: number) => RANK_NAMES[r] ?? String(r);
  const plural = (r: number) => (r === 6 ? "Sixes" : `${name(r)}s`);
  const [, a = 0, b = 0] = v.score;
  switch (v.category) {
    case HandCategory.RoyalFlush:
      return "Royal flush";
    case HandCategory.StraightFlush:
      return `Straight flush, ${name(a)} high`;
    case HandCategory.FourOfAKind:
      return `Four ${plural(a)}`;
    case HandCategory.FullHouse:
      return `Full house, ${plural(a)} full of ${plural(b)}`;
    case HandCategory.Flush:
      return `Flush, ${name(a)} high`;
    case HandCategory.Straight:
      return `Straight, ${name(a)} high`;
    case HandCategory.ThreeOfAKind:
      return `Three ${plural(a)}`;
    case HandCategory.TwoPair:
      return `Two pair, ${plural(a)} and ${plural(b)}`;
    case HandCategory.OnePair:
      return `Pair of ${plural(a)}`;
    default:
      return `${name(a)} high`;
  }
}

const RANK_NAMES: Record<number, string> = {
  2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six", 7: "Seven", 8: "Eight",
  9: "Nine", 10: "Ten", 11: "Jack", 12: "Queen", 13: "King", 14: "Ace",
};
