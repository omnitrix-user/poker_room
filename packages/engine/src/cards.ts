export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"] as const;
export const SUITS = ["s", "h", "d", "c"] as const;

export type RankChar = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
/** A card is its rank character followed by its suit, e.g. "As", "Td", "2c". */
export type Card = `${RankChar}${Suit}`;

export function rankOf(card: Card): number {
  // 2..14 (ace high)
  return RANKS.indexOf(card[0] as RankChar) + 2;
}

export function suitOf(card: Card): Suit {
  return card[1] as Suit;
}

export function isCard(value: unknown): value is Card {
  return (
    typeof value === "string" &&
    value.length === 2 &&
    (RANKS as readonly string[]).includes(value[0]!) &&
    (SUITS as readonly string[]).includes(value[1]!)
  );
}

export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}`);
  return deck;
}

/** Returns an unbiased integer in [0, maxExclusive) using the platform CSPRNG. */
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
    throw new RangeError("maxExclusive out of range");
  }
  const buf = new Uint32Array(1);
  // Rejection sampling removes modulo bias.
  const limit = 2 ** 32 - (2 ** 32 % maxExclusive);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    const x = buf[0]!;
    if (x < limit) return x % maxExclusive;
  }
}

/** Fisher–Yates shuffle. Returns a new array. */
export function shuffle<T>(items: readonly T[], randomInt: (n: number) => number = secureRandomInt): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function parseCards(s: string): Card[] {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  return parts.map((p) => {
    if (!isCard(p)) throw new Error(`Invalid card: ${p}`);
    return p;
  });
}
