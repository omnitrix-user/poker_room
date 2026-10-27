import { useEffect, useRef, useState } from "react";
import type { GameView, RoomView } from "@riverroom/protocol";

/** When each remaining board card is revealed during an all-in runout (ms after it starts). */
const STAGE_GAP_MS = 1500;
const FIRST_STAGE_MS = 1100;
/** Time for the last card to land before the result is announced. */
const SETTLE_MS = 650;

export interface Presented {
  view: RoomView | null;
  /** True while an all-in runout is being revealed; results are withheld until it ends. */
  revealing: boolean;
}

/**
 * The server settles an all-in hand instantly. To keep the sweat, the client presents the
 * board street by street and withholds everything that would spoil it (the later cards in
 * the log, the winner, stacks after payout) until the last card lands. The authoritative
 * view is never changed — only what is shown, and only for a few seconds.
 */
export function useRunoutDirector(view: RoomView | null): Presented {
  const g = view?.game ?? null;
  const prev = useRef<{ hand: number; board: number } | null>(null);
  const [run, setRun] = useState<{ hand: number; visible: number; settled: boolean } | null>(null);

  // Detect a runout: the board jumped by more than one street in a completed hand with equity.
  const before = prev.current;
  const isRunout =
    g !== null &&
    g.street === "complete" &&
    (g.result?.equity.length ?? 0) > 0 &&
    before !== null &&
    before.hand === g.handNo &&
    before.board < g.board.length;
  const startVisible = isRunout ? before!.board : 0;

  useEffect(() => {
    if (!g) return;
    prev.current = { hand: g.handNo, board: g.board.length };
    if (!isRunout) return;
    const total = g.board.length;
    // Stages: flop (all three at once), then each single card.
    const stages: number[] = [];
    for (let n = startVisible; n < total; ) {
      n = n < 3 ? 3 : n + 1;
      stages.push(n);
    }
    setRun({ hand: g.handNo, visible: startVisible, settled: false });
    const timers = stages.map((n, i) => setTimeout(() => setRun((r) => (r && r.hand === g.handNo ? { ...r, visible: n } : r)), FIRST_STAGE_MS + i * STAGE_GAP_MS));
    const end = FIRST_STAGE_MS + (stages.length - 1) * STAGE_GAP_MS + SETTLE_MS;
    timers.push(setTimeout(() => setRun((r) => (r && r.hand === g.handNo ? { ...r, settled: true } : r)), end));
    return () => timers.forEach(clearTimeout);
  }, [g?.handNo, g?.board.length, g?.street]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!view || !g) return { view, revealing: false };
  // The effect hasn't scheduled the reveal yet on the very first render of the runout.
  const active = run && run.hand === g.handNo && !run.settled ? run : isRunout ? { hand: g.handNo, visible: startVisible, settled: false } : null;
  if (!active || g.street !== "complete" || !g.result) return { view, revealing: false };
  return { view: mask(view, g, active.visible), revealing: true };
}

function mask(view: RoomView, g: GameView, visible: number): RoomView {
  const r = g.result!;
  const payout = (id: string) => r.payouts[id] ?? 0;
  const board = g.board.slice(0, visible);
  let dealt = 0;
  const events = g.events.filter((e) => {
    if (e.kind !== "deal") return true;
    dealt += e.cards.length;
    return dealt <= visible;
  });
  const game: GameView = {
    ...g,
    board,
    events,
    players: g.players.map((p) => ({ ...p, stack: p.stack - payout(p.playerId) })),
    result: {
      ...r,
      pots: [],
      refund: null,
      payouts: {},
      stacks: {},
      mucked: [],
      // All-in hands are tabled before the runout; their final rank is not known yet.
      shown: r.shown.map((s) => ({ ...s, name: "", cards: [] })),
    },
  };
  return {
    ...view,
    nextHandAt: null,
    players: view.players.map((p) => (g.players.some((x) => x.playerId === p.playerId) ? { ...p, stack: p.stack - payout(p.playerId) } : p)),
    game,
  };
}
