import { freshDeck, parseCards, startHand, type Card, type HandState, type SeatInput } from "../src/index.ts";

/**
 * Builds a deck so that each player receives the given hole cards and the board
 * comes out as specified (burn cards are taken from the unused remainder).
 */
export function stackedDeck(
  seats: SeatInput[],
  buttonSeat: number,
  holes: Record<string, string>,
  board = "",
): Card[] {
  const sorted = seats.slice().sort((a, b) => a.seat - b.seat);
  const after = sorted.filter((s) => s.seat > buttonSeat);
  const before = sorted.filter((s) => s.seat <= buttonSeat);
  const order = [...after, ...before];
  const used = new Set<Card>();
  const want = (s: string) => {
    const cs = parseCards(s);
    cs.forEach((c) => {
      if (used.has(c)) throw new Error(`card used twice in test: ${c}`);
      used.add(c);
    });
    return cs;
  };
  const holeCards = new Map(order.map((s) => [s.playerId, want(holes[s.playerId] ?? "")]));
  const boardCards = want(board);
  const rest = freshDeck().filter((c) => !used.has(c));
  const take = () => rest.shift()!;
  const deck: Card[] = [];
  for (let r = 0; r < 2; r++) for (const s of order) deck.push(holeCards.get(s.playerId)![r] ?? take());
  const b = (i: number) => boardCards[i] ?? take();
  deck.push(take(), b(0), b(1), b(2), take(), b(3), take(), b(4));
  deck.push(...rest);
  return deck;
}

export function seats(...stacks: number[]): SeatInput[] {
  return stacks.map((stack, i) => ({ playerId: String.fromCharCode(65 + i), seat: i, stack }));
}

export function deal(
  stacks: number[],
  opts: { button?: number; holes?: Record<string, string>; board?: string; sb?: number; bb?: number } = {},
): HandState {
  const s = seats(...stacks);
  const button = opts.button ?? 0;
  return startHand({
    handNo: 1,
    config: { smallBlind: opts.sb ?? 5, bigBlind: opts.bb ?? 10 },
    buttonSeat: button,
    seats: s,
    deck: stackedDeck(s, button, opts.holes ?? {}, opts.board),
  });
}

export function actorId(state: HandState): string {
  const p = state.players.find((x) => x.seat === state.toAct);
  if (!p) throw new Error("nobody to act");
  return p.playerId;
}

export function player(state: HandState, id: string) {
  return state.players.find((p) => p.playerId === id)!;
}
