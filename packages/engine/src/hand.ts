import type { Card } from "./cards.ts";
import { compareHands, describeHand, evaluateBest, type HandCategory, type HandValue } from "./evaluator.ts";
import { equity } from "./equity.ts";
import { buildPots, splitUncalled } from "./pots.ts";

export type Street = "preflop" | "flop" | "turn" | "river" | "complete";
export type PlayerStatus = "active" | "folded" | "allin";

export interface HandConfig {
  smallBlind: number;
  bigBlind: number;
}

export interface SeatInput {
  playerId: string;
  seat: number;
  stack: number;
}

export type Action =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  /** Open the betting on a street. `amount` is the total street bet. */
  | { type: "bet"; amount: number }
  /** Raise to `amount` total for this street (not the increment). */
  | { type: "raise"; amount: number }
  | { type: "allin" };

export type ActionType = Action["type"];

export interface HandPlayer {
  playerId: string;
  seat: number;
  startStack: number;
  stack: number;
  hole: Card[];
  /** Chips committed on the current street. */
  streetBet: number;
  /** Chips committed over the whole hand. */
  totalBet: number;
  status: PlayerStatus;
  /** Has voluntarily acted on the current street (blinds do not count). */
  hasActed: boolean;
  /** The current bet level right after this player last acted on this street. */
  actedAtBet: number;
}

export type HandEvent =
  | { kind: "blind"; playerId: string; blind: "small" | "big" | "post"; amount: number; allIn: boolean }
  | { kind: "deal"; street: Exclude<Street, "preflop" | "complete">; cards: Card[] }
  | {
      kind: "action";
      playerId: string;
      street: Street;
      action: ActionType;
      /** Chips moved from stack into the pot by this action. */
      amount: number;
      /** The player's street total after the action. */
      to: number;
      allIn: boolean;
    };

export interface ShownHand {
  playerId: string;
  hole: Card[];
  category: HandCategory;
  name: string;
  cards: Card[];
}

export interface PotResult {
  amount: number;
  eligible: string[];
  winners: { playerId: string; amount: number }[];
  /** Description of the winning hand (showdown only). */
  winningHand: string | null;
}

export interface EquityStage {
  /** Number of board cards known at this point of the runout. */
  board: number;
  /** Share of the pot each shown hand wins on average from here (0..1). */
  equity: Record<string, number>;
}

export interface HandResult {
  endedBy: "fold" | "showdown";
  refund: { playerId: string; amount: number } | null;
  pots: PotResult[];
  /** Hands revealed at showdown, in showing order. */
  shown: ShownHand[];
  /** Live players who lost at showdown and did not have to show. Their cards stay hidden. */
  mucked: string[];
  /** All-in equity before each remaining street when the board was run out without betting. */
  equity: EquityStage[];
  /** Total won per player, including refund of uncalled chips. */
  payouts: Record<string, number>;
  /** Final stacks after settlement. */
  stacks: Record<string, number>;
}

export interface HandState {
  handNo: number;
  config: HandConfig;
  buttonSeat: number;
  /** Null when the small blind is dead (nobody posts it this hand). */
  sbSeat: number | null;
  bbSeat: number;
  /** Ordered by seat ascending; clockwise order is ascending seat with wrap-around. */
  players: HandPlayer[];
  /** Undealt cards, top of deck first. Secret. */
  deck: Card[];
  board: Card[];
  street: Street;
  currentBet: number;
  /** Size of the last full bet/raise increment on this street; the minimum raise increment. */
  minRaise: number;
  /** Seat whose turn it is, or null when no decision is pending. */
  toAct: number | null;
  /** Number of accepted player actions in this hand. */
  seq: number;
  /** Seat of the last player to bet or raise on the current street. */
  lastAggressor: number | null;
  /** Board size when betting closed with two or more players still in (an all-in runout). */
  runoutFrom: number | null;
  events: HandEvent[];
  result: HandResult | null;
}

export class ActionError extends Error {
  constructor(
    public readonly code:
      | "hand_complete"
      | "not_your_turn"
      | "not_in_hand"
      | "illegal_action"
      | "invalid_amount",
    message: string,
  ) {
    super(message);
  }
}

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  /** Chips needed to call; 0 when checking is free. Capped at the player's stack. */
  callAmount: number;
  /** "bet" when no bet is open on this street, "raise" when facing one, null if neither is allowed. */
  raiseKind: "bet" | "raise" | null;
  /** Smallest legal raise-to total (equals maxRaiseTo when only an all-in is possible). */
  minRaiseTo: number;
  /** Largest raise-to total: the player's street bet plus stack. */
  maxRaiseTo: number;
  /** Whether going all-in is legal (as a call, bet, or raise). */
  canAllIn: boolean;
}

// ---------------------------------------------------------------------------
// Seat order helpers

/** Players in clockwise order starting after `seat`. */
function clockwiseFrom(players: readonly HandPlayer[], seat: number): HandPlayer[] {
  const after = players.filter((p) => p.seat > seat);
  const before = players.filter((p) => p.seat <= seat);
  return [...after, ...before];
}

/** Of a set of seats, the next one clockwise after `seat`. */
export function nextSeatAfter(seats: readonly number[], seat: number): number {
  const sorted = seats.slice().sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error("no seats");
  return sorted.find((s) => s > seat) ?? sorted[0]!;
}

function bySeat(state: HandState, seat: number): HandPlayer {
  const p = state.players.find((x) => x.seat === seat);
  if (!p) throw new Error(`no player in seat ${seat}`);
  return p;
}

function activeCount(state: HandState): number {
  return state.players.filter((p) => p.status === "active").length;
}

function liveCount(state: HandState): number {
  return state.players.filter((p) => p.status !== "folded").length;
}

/** Whether a player still owes a decision on this street. */
function needsToAct(state: HandState, p: HandPlayer): boolean {
  if (p.status !== "active") return false;
  if (activeCount(state) >= 2) return !p.hasActed || p.streetBet < state.currentBet;
  // The only player with chips left acts only if facing a bet larger than their own.
  const maxOther = Math.max(0, ...state.players.filter((o) => o !== p).map((o) => o.streetBet));
  return p.streetBet < maxOther;
}

// ---------------------------------------------------------------------------
// Starting a hand

export interface StartHandInput {
  handNo: number;
  config: HandConfig;
  buttonSeat: number;
  seats: SeatInput[];
  /** Pre-shuffled deck, top first. */
  deck: Card[];
  /**
   * Players entering the game (late joiners, players back from sitting out) who post a live
   * big blind to be dealt in. Ignored for players already in a blind position.
   */
  posting?: string[];
  /**
   * Explicit blind positions (see `nextBlinds`). When given, the button may be an empty seat
   * and the small blind may be dead. When omitted, blinds follow the button.
   */
  blinds?: { sbSeat: number | null; bbSeat: number };
}

export function startHand(input: StartHandInput): HandState {
  const { config } = input;
  if (!(Number.isInteger(config.smallBlind) && Number.isInteger(config.bigBlind))) throw new Error("blinds must be integers");
  if (config.smallBlind <= 0 || config.bigBlind < config.smallBlind) throw new Error("invalid blinds");
  const seats = input.seats.slice().sort((a, b) => a.seat - b.seat);
  if (seats.length < 2 || seats.length > 10) throw new Error("a hand needs 2 to 10 players");
  if (new Set(seats.map((s) => s.seat)).size !== seats.length) throw new Error("duplicate seat");
  if (new Set(seats.map((s) => s.playerId)).size !== seats.length) throw new Error("duplicate player");
  if (seats.some((s) => !Number.isInteger(s.stack) || s.stack <= 0)) throw new Error("every player needs chips");
  const dealtIn = (seat: number | null) => seat !== null && seats.some((s) => s.seat === seat);
  if (!input.blinds && !dealtIn(input.buttonSeat)) throw new Error("button must be on a dealt-in seat");
  if (input.blinds) {
    const { sbSeat, bbSeat } = input.blinds;
    if (!dealtIn(bbSeat)) throw new Error("big blind must be dealt in");
    if (sbSeat !== null && (!dealtIn(sbSeat) || sbSeat === bbSeat)) throw new Error("invalid small blind");
  }
  if (new Set(input.deck).size !== input.deck.length || input.deck.length < seats.length * 2 + 8)
    throw new Error("invalid deck");

  const seatNums = seats.map((s) => s.seat);
  const headsUp = seats.length === 2;
  // Heads-up the button posts the small blind and acts first pre-flop.
  const sbSeat = input.blinds ? input.blinds.sbSeat : headsUp ? input.buttonSeat : nextSeatAfter(seatNums, input.buttonSeat);
  const bbSeat = input.blinds ? input.blinds.bbSeat : nextSeatAfter(seatNums, sbSeat!);

  const state: HandState = {
    handNo: input.handNo,
    config,
    buttonSeat: input.buttonSeat,
    sbSeat,
    bbSeat,
    players: seats.map((s) => ({
      playerId: s.playerId,
      seat: s.seat,
      startStack: s.stack,
      stack: s.stack,
      hole: [],
      streetBet: 0,
      totalBet: 0,
      status: "active",
      hasActed: false,
      actedAtBet: 0,
    })),
    deck: input.deck.slice(),
    board: [],
    street: "preflop",
    currentBet: 0,
    minRaise: config.bigBlind,
    toAct: null,
    seq: 0,
    lastAggressor: null,
    runoutFrom: null,
    events: [],
    result: null,
  };

  // Deal one card at a time, starting left of the button.
  const dealOrder = clockwiseFrom(state.players, state.buttonSeat);
  for (let round = 0; round < 2; round++) for (const p of dealOrder) p.hole.push(state.deck.shift()!);

  if (sbSeat !== null) postBlind(state, bySeat(state, sbSeat), "small", config.smallBlind);
  postBlind(state, bySeat(state, bbSeat), "big", config.bigBlind);
  for (const p of clockwiseFrom(state.players, bbSeat)) {
    if (p.seat === sbSeat || p.seat === bbSeat || !input.posting?.includes(p.playerId)) continue;
    postBlind(state, p, "post", config.bigBlind);
  }
  // Callers must match the full big blind even if the big blind is short.
  state.currentBet = Math.max(config.bigBlind, ...state.players.map((p) => p.streetBet));

  advance(state, bbSeat);
  return state;
}

function commit(p: HandPlayer, amount: number): void {
  if (amount < 0 || amount > p.stack) throw new Error("invalid commit");
  p.stack -= amount;
  p.streetBet += amount;
  p.totalBet += amount;
  if (p.stack === 0) p.status = "allin";
}

function postBlind(state: HandState, p: HandPlayer, blind: "small" | "big" | "post", size: number): void {
  const amount = Math.min(size, p.stack);
  commit(p, amount);
  state.events.push({ kind: "blind", playerId: p.playerId, blind, amount, allIn: p.stack === 0 });
}

// ---------------------------------------------------------------------------
// Legal actions

export function legalActions(state: HandState, seat: number): LegalActions | null {
  if (state.street === "complete" || state.toAct !== seat) return null;
  const p = bySeat(state, seat);
  const toCall = Math.max(0, state.currentBet - p.streetBet);
  const callAmount = Math.min(toCall, p.stack);
  const maxRaiseTo = p.streetBet + p.stack;
  const othersCanRespond = state.players.some((o) => o !== p && o.status === "active");
  // A short all-in raise does not reopen the betting for someone who already acted,
  // unless the total raised since they acted amounts to a full raise.
  const reopened = !p.hasActed || state.currentBet - p.actedAtBet >= state.minRaise;
  const canRaise = othersCanRespond && reopened && p.stack > toCall;
  const fullMin = state.currentBet === 0 ? state.config.bigBlind : state.currentBet + state.minRaise;
  return {
    canFold: true,
    canCheck: toCall === 0,
    callAmount,
    raiseKind: canRaise ? (state.currentBet === 0 ? "bet" : "raise") : null,
    minRaiseTo: canRaise ? Math.min(fullMin, maxRaiseTo) : 0,
    maxRaiseTo: canRaise ? maxRaiseTo : 0,
    canAllIn: p.stack > 0 && (canRaise || p.stack <= toCall),
  };
}

// ---------------------------------------------------------------------------
// Applying actions

/** Applies an action for the player in `seat`. Returns a new state; the input is not mutated. */
export function applyAction(prev: HandState, playerId: string, action: Action): HandState {
  if (prev.street === "complete") throw new ActionError("hand_complete", "The hand is over.");
  const seatPlayer = prev.players.find((p) => p.playerId === playerId);
  if (!seatPlayer) throw new ActionError("not_in_hand", "You are not dealt into this hand.");
  if (prev.toAct !== seatPlayer.seat) throw new ActionError("not_your_turn", "It is not your turn.");
  const legal = legalActions(prev, seatPlayer.seat)!;

  const state = structuredClone(prev);
  const p = bySeat(state, seatPlayer.seat);
  const street = state.street;
  const before = p.streetBet;

  let type: ActionType = action.type;
  let raiseTo: number | null = null;

  switch (action.type) {
    case "fold":
      p.status = "folded";
      break;
    case "check":
      if (!legal.canCheck) throw new ActionError("illegal_action", "You cannot check facing a bet.");
      break;
    case "call":
      if (legal.canCheck) throw new ActionError("illegal_action", "There is nothing to call.");
      commit(p, legal.callAmount);
      break;
    case "bet":
    case "raise": {
      if (legal.raiseKind === null) throw new ActionError("illegal_action", "Raising is not allowed here.");
      if (legal.raiseKind !== action.type)
        throw new ActionError("illegal_action", action.type === "bet" ? "There is already a bet; raise instead." : "There is no bet to raise; bet instead.");
      const amt = action.amount;
      if (!Number.isInteger(amt) || amt < legal.minRaiseTo || amt > legal.maxRaiseTo)
        throw new ActionError("invalid_amount", `Amount must be between ${legal.minRaiseTo} and ${legal.maxRaiseTo}.`);
      raiseTo = amt;
      break;
    }
    case "allin":
      if (!legal.canAllIn) throw new ActionError("illegal_action", "You cannot go all-in here.");
      if (p.stack <= state.currentBet - p.streetBet) {
        type = "call";
        commit(p, p.stack);
      } else {
        type = state.currentBet === 0 ? "bet" : "raise";
        raiseTo = legal.maxRaiseTo;
      }
      break;
  }

  if (raiseTo !== null) {
    state.lastAggressor = p.seat;
    const increment = raiseTo - state.currentBet;
    commit(p, raiseTo - p.streetBet);
    if (increment >= state.minRaise) state.minRaise = increment;
    state.currentBet = raiseTo;
  }

  if (p.status !== "folded") {
    p.hasActed = true;
    p.actedAtBet = state.currentBet;
  }
  state.seq += 1;
  state.events.push({
    kind: "action",
    playerId: p.playerId,
    street,
    action: type,
    amount: p.streetBet - before,
    to: p.streetBet,
    allIn: p.status === "allin",
  });

  advance(state, p.seat);
  return state;
}

/** Moves the turn forward, dealing streets and settling as required. Mutates `state`. */
function advance(state: HandState, fromSeat: number): void {
  for (;;) {
    if (liveCount(state) === 1) {
      settle(state, "fold");
      return;
    }
    const next = clockwiseFrom(state.players, fromSeat).find((p) => needsToAct(state, p));
    if (next) {
      state.toAct = next.seat;
      return;
    }
    // Betting round is complete.
    if (state.street === "river") {
      settle(state, "showdown");
      return;
    }
    // Nobody (or only one player) can still bet: the rest of the board is a runout.
    if (activeCount(state) < 2 && state.runoutFrom == null) state.runoutFrom = state.board.length;
    dealNextStreet(state);
    fromSeat = state.buttonSeat;
  }
}

function dealNextStreet(state: HandState): void {
  const next = state.street === "preflop" ? "flop" : state.street === "flop" ? "turn" : "river";
  state.deck.shift(); // burn
  const count = next === "flop" ? 3 : 1;
  const cards = state.deck.splice(0, count);
  state.board.push(...cards);
  state.street = next;
  state.currentBet = 0;
  state.minRaise = state.config.bigBlind;
  state.lastAggressor = null;
  for (const p of state.players) {
    p.streetBet = 0;
    p.hasActed = false;
    p.actedAtBet = 0;
  }
  state.events.push({ kind: "deal", street: next, cards });
}

// ---------------------------------------------------------------------------
// Settlement

function settle(state: HandState, endedBy: "fold" | "showdown"): void {
  state.toAct = null;
  const { refund, contribs } = splitUncalled(
    state.players.map((p) => ({ playerId: p.playerId, amount: p.totalBet, folded: p.status === "folded" })),
  );
  const payouts: Record<string, number> = {};
  for (const p of state.players) payouts[p.playerId] = 0;
  if (refund) payouts[refund.playerId]! += refund.amount;

  const live = state.players.filter((p) => p.status !== "folded");
  const values = new Map<string, HandValue>();
  if (endedBy === "showdown") for (const p of live) values.set(p.playerId, evaluateBest([...p.hole, ...state.board]));

  // Odd chips go to winners in clockwise order starting left of the button.
  const oddChipOrder = clockwiseFrom(state.players, state.buttonSeat).map((p) => p.playerId);

  const pots: PotResult[] = buildPots(contribs).map((pot) => {
    let winners = pot.eligible;
    let winningHand: string | null = null;
    if (endedBy === "showdown") {
      let best: HandValue | null = null;
      for (const id of pot.eligible) {
        const v = values.get(id)!;
        const cmp = best ? compareHands(v, best) : 1;
        if (cmp > 0) {
          best = v;
          winners = [id];
        } else if (cmp === 0) winners = [...winners, id];
      }
      winningHand = describeHand(best!);
    }
    const ordered = oddChipOrder.filter((id) => winners.includes(id));
    const share = Math.floor(pot.amount / ordered.length);
    let remainder = pot.amount - share * ordered.length;
    const split = ordered.map((playerId) => {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      return { playerId, amount: share + extra };
    });
    for (const w of split) payouts[w.playerId]! += w.amount;
    return { amount: pot.amount, eligible: pot.eligible, winners: split, winningHand };
  });

  const shown: ShownHand[] = [];
  const mucked: string[] = [];
  let equityStages: EquityStage[] = [];
  if (endedBy === "showdown") {
    // Showing order: the last river aggressor (who was called), else first live player left of the button.
    const aggressor = state.lastAggressor === null ? undefined : live.find((p) => p.seat === state.lastAggressor);
    const order = aggressor ? [aggressor, ...clockwiseFrom(live, aggressor.seat).filter((p) => p !== aggressor)] : clockwiseFrom(live, state.buttonSeat);
    const potWinners = new Set(pots.flatMap((p) => p.winners.map((w) => w.playerId)));
    // Everyone shows after an all-in runout; otherwise the first to show, all-in players, and
    // anyone who wins chips must show, and other losing hands are mucked.
    const allTabled = state.runoutFrom != null;
    for (const [i, p] of order.entries()) {
      if (allTabled || i === 0 || p.status === "allin" || potWinners.has(p.playerId)) {
        const v = values.get(p.playerId)!;
        shown.push({ playerId: p.playerId, hole: p.hole.slice(), category: v.category, name: describeHand(v), cards: v.cards });
      } else mucked.push(p.playerId);
    }
    if (allTabled) {
      const hands = live.map((p) => ({ playerId: p.playerId, hole: p.hole }));
      const stages = [...new Set([state.runoutFrom!, 3, 4].filter((n) => n >= state.runoutFrom! && n < 5))];
      equityStages = stages.map((n) => ({ board: n, equity: equity(hands, state.board.slice(0, n), { seed: state.handNo * 31 + n }) }));
    }
  }

  const stacks: Record<string, number> = {};
  for (const p of state.players) {
    p.stack += payouts[p.playerId]!;
    stacks[p.playerId] = p.stack;
  }
  state.street = "complete";
  state.result = { endedBy, refund, pots, shown, mucked, equity: equityStages, payouts, stacks };
}

// ---------------------------------------------------------------------------
// Derived info

export function potTotal(state: HandState): number {
  return state.players.reduce((s, p) => s + p.totalBet, 0);
}
