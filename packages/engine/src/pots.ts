export interface Contribution {
  playerId: string;
  amount: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** Player ids that may win this pot. Never contains a folded player. */
  eligible: string[];
}

/**
 * Removes the part of the largest contribution that nobody else matched.
 * Returns the refund (if any) and the adjusted contributions.
 */
export function splitUncalled(contribs: readonly Contribution[]): {
  refund: { playerId: string; amount: number } | null;
  contribs: Contribution[];
} {
  const sorted = contribs.slice().sort((a, b) => b.amount - a.amount);
  const top = sorted[0];
  const second = sorted[1]?.amount ?? 0;
  if (!top || top.amount <= second) return { refund: null, contribs: contribs.slice() };
  const excess = top.amount - second;
  return {
    refund: { playerId: top.playerId, amount: excess },
    contribs: contribs.map((c) => (c === top ? { ...c, amount: second } : c)),
  };
}

/**
 * Builds the main pot and side pots from total hand contributions.
 * Each distinct contribution level of a live (non-folded) player closes a pot;
 * only live players who contributed at least that level are eligible for it.
 * Folded players' chips are counted in the pots they contributed to.
 */
export function buildPots(contribs: readonly Contribution[]): Pot[] {
  const levels = [...new Set(contribs.filter((c) => !c.folded && c.amount > 0).map((c) => c.amount))].sort(
    (a, b) => a - b,
  );
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const c of contribs) amount += Math.min(c.amount, level) - Math.min(c.amount, prev);
    const eligible = contribs.filter((c) => !c.folded && c.amount >= level).map((c) => c.playerId);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  // Folded chips above the highest live level (only possible without an uncalled-bet
  // refund) belong to the last pot rather than vanishing.
  const leftover = contribs.reduce((s, c) => s + Math.max(0, c.amount - prev), 0);
  if (leftover > 0) {
    const last = pots[pots.length - 1];
    if (!last) throw new Error("Chips contributed but no live player to award them to");
    last.amount += leftover;
  }
  return pots;
}
