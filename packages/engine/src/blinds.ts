/**
 * Where the button and blinds go for the next hand, using the "moving big blind" rule:
 * the big blind always advances to the next player dealt in, so nobody skips it or pays it
 * twice when players bust, leave, or sit out. Consequences of that rule:
 *  - the small blind is posted by last hand's big blind if they're still dealt in;
 *    otherwise there is no small blind this hand (a "dead" small blind);
 *  - the button sits on last hand's small-blind seat, which may now be empty (a "dead" button).
 * Heads-up, the button posts the small blind and the big blind alternates.
 */
export interface BlindPositions {
  /** May be a seat with nobody dealt in (dead button). */
  buttonSeat: number;
  /** Null when the small blind is dead. */
  sbSeat: number | null;
  bbSeat: number;
}

function nextAfter(sorted: number[], seat: number): number {
  return sorted.find((s) => s > seat) ?? sorted[0]!;
}

function prevBefore(sorted: number[], seat: number): number {
  const before = sorted.filter((s) => s < seat);
  return before.length ? before[before.length - 1]! : sorted[sorted.length - 1]!;
}

/**
 * @param seats seats dealt into the next hand (at least two)
 * @param previous positions used last hand, or null for the first hand
 * @param pickButton chooses the first button among `seats` (random in play, fixed in tests)
 */
export function nextBlinds(
  seats: readonly number[],
  previous: BlindPositions | null,
  pickButton: (seats: number[]) => number = (s) => s[0]!,
): BlindPositions {
  const sorted = [...new Set(seats)].sort((a, b) => a - b);
  if (sorted.length < 2) throw new Error("need at least two seats");

  if (!previous) {
    const button = pickButton(sorted);
    if (!sorted.includes(button)) throw new Error("button must be a dealt-in seat");
    return standard(sorted, button);
  }

  const bbSeat = nextAfter(sorted, previous.bbSeat);

  if (sorted.length === 2) {
    // Heads-up: the other player has the button and posts the small blind.
    const other = sorted.find((s) => s !== bbSeat)!;
    return { buttonSeat: other, sbSeat: other, bbSeat };
  }

  // Last hand's big blind posts the small blind, if they're still dealt in and
  // sit directly before the new big blind among the players dealt in.
  const sbCandidate = previous.bbSeat;
  const sbSeat = sorted.includes(sbCandidate) && prevBefore(sorted, bbSeat) === sbCandidate ? sbCandidate : null;
  // The button moves to where the small blind was, even if that seat is now empty.
  let buttonSeat = previous.sbSeat ?? previous.buttonSeat;
  // Keep the button behind the blinds: if it would land on or past the small blind, step back.
  if (sbSeat !== null && buttonSeat === sbSeat) buttonSeat = prevBefore(sorted, sbSeat);
  if (buttonSeat === bbSeat) buttonSeat = prevBefore(sorted, sbSeat ?? bbSeat);
  return { buttonSeat, sbSeat, bbSeat };
}

function standard(sorted: number[], button: number): BlindPositions {
  if (sorted.length === 2) {
    return { buttonSeat: button, sbSeat: button, bbSeat: nextAfter(sorted, button) };
  }
  const sb = nextAfter(sorted, button);
  return { buttonSeat: button, sbSeat: sb, bbSeat: nextAfter(sorted, sb) };
}
