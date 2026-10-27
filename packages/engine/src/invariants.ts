import type { HandState } from "./hand.ts";

/**
 * Structural invariants that must hold for every reachable hand state.
 * Returns a list of violations (empty when the state is consistent).
 */
export function findInvariantViolations(state: HandState): string[] {
  const errors: string[] = [];
  const startTotal = state.players.reduce((s, p) => s + p.startStack, 0);

  for (const p of state.players) {
    if (p.stack < 0) errors.push(`negative stack for ${p.playerId}`);
    if (p.streetBet < 0 || p.totalBet < p.streetBet) errors.push(`bad contribution for ${p.playerId}`);
    if (!Number.isInteger(p.stack) || !Number.isInteger(p.totalBet)) errors.push(`non-integer chips for ${p.playerId}`);
    if (p.hole.length !== 2) errors.push(`${p.playerId} does not hold two cards`);
    if (p.status === "allin" && p.stack !== 0 && state.street !== "complete") errors.push(`${p.playerId} all-in with chips`);
  }

  const cards = [...state.deck, ...state.board, ...state.players.flatMap((p) => p.hole)];
  if (new Set(cards).size !== cards.length) errors.push("duplicate card");

  if (state.street === "complete") {
    if (!state.result) errors.push("complete hand without result");
    const end = state.players.reduce((s, p) => s + p.stack, 0);
    if (end !== startTotal) errors.push(`chips not conserved: ${startTotal} -> ${end}`);
    if (state.toAct !== null) errors.push("turn pending on complete hand");
    if (state.result) {
      const live = new Set(state.players.filter((p) => p.status !== "folded").map((p) => p.playerId));
      if (state.result.endedBy === "showdown") {
        const shown = new Set(state.result.shown.map((x) => x.playerId));
        const mucked = new Set(state.result.mucked);
        for (const id of live) if (shown.has(id) === mucked.has(id)) errors.push(`${id} must be either shown or mucked`);
        for (const pot of state.result.pots) for (const w of pot.winners) if (!shown.has(w.playerId)) errors.push(`winner ${w.playerId} not shown`);
      } else if (state.result.shown.length || state.result.mucked.length) errors.push("cards shown in a hand won by folds");
      for (const pot of state.result.pots) {
        const paid = pot.winners.reduce((s, w) => s + w.amount, 0);
        if (paid !== pot.amount) errors.push("pot not fully distributed");
        for (const w of pot.winners) {
          if (!live.has(w.playerId) || !pot.eligible.includes(w.playerId)) errors.push(`ineligible winner ${w.playerId}`);
        }
      }
    }
  } else {
    const inPlay = state.players.reduce((s, p) => s + p.stack + p.totalBet, 0);
    if (inPlay !== startTotal) errors.push(`chips not conserved mid-hand: ${startTotal} -> ${inPlay}`);
    const maxBet = Math.max(...state.players.map((p) => p.streetBet));
    if (state.currentBet < maxBet) errors.push("current bet below a street bet");
    if (state.toAct === null) errors.push("no player to act on an incomplete hand");
    else {
      const actor = state.players.find((p) => p.seat === state.toAct);
      if (!actor || actor.status !== "active") errors.push("player to act cannot act");
    }
    const expectedBoard = { preflop: 0, flop: 3, turn: 4, river: 5 }[state.street];
    if (state.board.length !== expectedBoard) errors.push("board size does not match street");
  }
  return errors;
}

export function assertInvariants(state: HandState): void {
  const errors = findInvariantViolations(state);
  if (errors.length) throw new Error(`Hand invariant violated: ${errors.join("; ")}`);
}
