import { freshDeck, rankOf, SUITS, type Card } from "./cards.ts";

const SUIT_INDEX: Record<string, number> = Object.fromEntries(SUITS.map((s, i) => [s, i]));

function encode(category: number, ranks: number[]): number {
  let v = category;
  for (let i = 0; i < 5; i++) v = v * 15 + (ranks[i] ?? 0);
  return v;
}

/** Highest straight in a rank bitmask (bit r set for rank r, ace also counts as 1), or 0. */
function straightHigh(mask: number): number {
  const m = mask & (1 << 14) ? mask | 0b10 : mask;
  for (let h = 14; h >= 5; h--) if (((m >> (h - 4)) & 0b11111) === 0b11111) return h;
  return 0;
}

function topRanks(mask: number, n: number, exclude: number[] = []): number[] {
  const out: number[] = [];
  for (let r = 14; r >= 2 && out.length < n; r--) if (mask & (1 << r) && !exclude.includes(r)) out.push(r);
  return out;
}

/**
 * Fast strength of the best five-card hand within 5–7 cards, as a single comparable number.
 * Orders hands exactly like `compareHands(evaluateBest(a), evaluateBest(b))` (verified by tests);
 * used where many evaluations are needed, such as equity calculation.
 */
export function rank7(cards: readonly Card[]): number {
  const counts = new Array<number>(15).fill(0);
  const suitMask = [0, 0, 0, 0];
  const suitCount = [0, 0, 0, 0];
  let rankMask = 0;
  for (const c of cards) {
    const r = rankOf(c);
    const s = SUIT_INDEX[c[1]!]!;
    counts[r]! += 1;
    suitMask[s]! |= 1 << r;
    suitCount[s]! += 1;
    rankMask |= 1 << r;
  }
  const flush = suitCount.findIndex((n) => n >= 5);
  if (flush >= 0) {
    const sf = straightHigh(suitMask[flush]!);
    if (sf) return encode(sf === 14 ? 9 : 8, [sf]);
  }
  const quads: number[] = [];
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 14; r >= 2; r--) {
    if (counts[r] === 4) quads.push(r);
    else if (counts[r] === 3) trips.push(r);
    else if (counts[r] === 2) pairs.push(r);
  }
  if (quads.length) return encode(7, [quads[0]!, ...topRanks(rankMask, 1, [quads[0]!])]);
  if (trips.length && (trips.length > 1 || pairs.length)) return encode(6, [trips[0]!, Math.max(trips[1] ?? 0, pairs[0] ?? 0)]);
  if (flush >= 0) return encode(5, topRanks(suitMask[flush]!, 5));
  const st = straightHigh(rankMask);
  if (st) return encode(4, [st]);
  if (trips.length) return encode(3, [trips[0]!, ...topRanks(rankMask, 2, [trips[0]!])]);
  if (pairs.length >= 2) return encode(2, [pairs[0]!, pairs[1]!, ...topRanks(rankMask, 1, [pairs[0]!, pairs[1]!])]);
  if (pairs.length) return encode(1, [pairs[0]!, ...topRanks(rankMask, 3, [pairs[0]!])]);
  return encode(0, topRanks(rankMask, 5));
}

/** Deterministic PRNG so equity numbers are reproducible for a given hand. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

export interface EquityOptions {
  /** Above this many possible runouts, sample instead of enumerating. */
  exactLimit?: number;
  samples?: number;
  seed?: number;
}

/**
 * Share of the pot each hand wins on average over every possible completion of the board
 * (ties split). Exact when the number of runouts is small, seeded Monte Carlo otherwise.
 * Cards that are not in any listed hand or on the board are treated as unknown.
 */
export function equity(hands: { playerId: string; hole: Card[] }[], board: Card[], opts: EquityOptions = {}): Record<string, number> {
  const known = new Set<Card>([...board, ...hands.flatMap((h) => h.hole)]);
  const rest = freshDeck().filter((c) => !known.has(c));
  const need = 5 - board.length;
  const wins = new Array<number>(hands.length).fill(0);
  let total = 0;
  const score = (runout: Card[]) => {
    let best = -1;
    let winners: number[] = [];
    hands.forEach((h, i) => {
      const v = rank7([...h.hole, ...board, ...runout]);
      if (v > best) {
        best = v;
        winners = [i];
      } else if (v === best) winners.push(i);
    });
    for (const w of winners) wins[w]! += 1 / winners.length;
    total += 1;
  };

  if (need === 0) score([]);
  else if (choose(rest.length, need) <= (opts.exactLimit ?? 3000)) {
    const pick: Card[] = [];
    const rec = (start: number) => {
      if (pick.length === need) return score(pick);
      for (let i = start; i < rest.length; i++) {
        pick.push(rest[i]!);
        rec(i + 1);
        pick.pop();
      }
    };
    rec(0);
  } else {
    const rnd = mulberry32(opts.seed ?? 1);
    const deck = rest.slice();
    for (let s = 0; s < (opts.samples ?? 3000); s++) {
      // Partial Fisher–Yates: only the cards we need.
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(rnd() * (deck.length - i));
        [deck[i], deck[j]] = [deck[j]!, deck[i]!];
      }
      score(deck.slice(0, need));
    }
  }
  return Object.fromEntries(hands.map((h, i) => [h.playerId, wins[i]! / total]));
}
