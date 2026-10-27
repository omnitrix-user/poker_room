import { legalActions, potTotal, type Card, type HandState } from "@riverroom/engine";
import type { GameView, PublicHandEvent, PublicHandResult, RoomView, SeatPlayerView } from "@riverroom/protocol";
import { roundsTotal } from "./model.ts";
import type { Room } from "./room.ts";

/**
 * Builds the view of a room for one recipient. Views are assembled field by field from
 * an allowlist; the hand state (which holds the deck and every hole card) is never
 * serialized wholesale. Other players' hole cards appear only once shown at showdown.
 */
export function buildRoomView(room: Room, viewerId: string): RoomView {
  const d = room.data;
  const hand = d.hand;
  const viewer = d.members.find((m) => m.playerId === viewerId);
  const inHand = (id: string) => hand?.players.find((p) => p.playerId === id);

  const players: SeatPlayerView[] = d.members
    .filter((m) => m.seat !== null)
    .map((m) => {
      const presence = room.presence.get(m.playerId);
      const hp = inHand(m.playerId);
      return {
        playerId: m.playerId,
        name: m.name,
        seat: m.seat!,
        stack: hp ? hp.stack : d.status === "lobby" ? d.settings.startingStack : m.stack,
        buyIn: m.buyIn,
        connected: presence?.connected ?? false,
        away: presence?.away ?? false,
        ready: m.ready,
        isHost: m.playerId === d.hostId,
        left: m.left,
        sittingOut: Boolean(m.sittingOut),
        willPost: Boolean(m.needsPost),
      };
    });

  return {
    roomId: d.id,
    code: d.code,
    status: d.status,
    hostId: d.hostId,
    settings: d.settings,
    players,
    you: { playerId: viewerId, seat: viewer?.seat ?? null, isHost: d.hostId === viewerId },
    game: hand ? buildGameView(hand, viewerId, room.turnDeadline, d.shows ?? {}) : null,
    nextHandAt: room.nextHandAt,
    endRequested: d.endRequested,
    waitingFor: room.waitingFor,
    handsPlayed: d.handsPlayed,
    roundsTotal: roundsTotal(d),
    vote: d.vote ? { ...d.vote, voters: d.vote.voters.slice(), yes: d.vote.yes.slice() } : null,
    finalWindowUntil: room.finalWindowUntil,
    serverTime: Date.now(),
  };
}

export function buildGameView(
  hand: HandState,
  viewerId: string,
  turnDeadline: number | null,
  shows: Record<string, Card[]>,
): GameView {
  const shown = new Map((hand.result?.shown ?? []).map((s) => [s.playerId, s.hole]));
  const viewer = hand.players.find((p) => p.playerId === viewerId);
  return {
    handNo: hand.handNo,
    seq: hand.seq,
    street: hand.street,
    board: hand.board.slice(),
    buttonSeat: hand.buttonSeat,
    sbSeat: hand.sbSeat,
    bbSeat: hand.bbSeat,
    smallBlind: hand.config.smallBlind,
    bigBlind: hand.config.bigBlind,
    currentBet: hand.currentBet,
    minRaise: hand.minRaise,
    potTotal: potTotal(hand),
    toActSeat: hand.toAct,
    turnDeadline: hand.toAct === null ? null : turnDeadline,
    players: hand.players.map((p) => ({
      playerId: p.playerId,
      seat: p.seat,
      status: p.status,
      stack: p.stack,
      streetBet: p.streetBet,
      totalBet: p.totalBet,
      cards: p.playerId === viewerId ? p.hole.slice() : (shown.get(p.playerId) ?? shows[p.playerId])?.slice() ?? null,
      showedByChoice: Boolean(shows[p.playerId]),
    })),
    events: hand.events.map(publicEvent),
    result: hand.result ? publicResult(hand.result) : null,
    legal: viewer && hand.toAct === viewer.seat ? legalActions(hand, viewer.seat) : null,
  };
}

function publicEvent(e: HandState["events"][number]): PublicHandEvent {
  switch (e.kind) {
    case "blind":
      return { kind: "blind", playerId: e.playerId, blind: e.blind, amount: e.amount, allIn: e.allIn };
    case "deal":
      return { kind: "deal", street: e.street, cards: e.cards.slice() };
    case "action":
      return { kind: "action", playerId: e.playerId, street: e.street, action: e.action, amount: e.amount, to: e.to, allIn: e.allIn };
  }
}

function publicResult(r: NonNullable<HandState["result"]>): PublicHandResult {
  return {
    endedBy: r.endedBy,
    refund: r.refund ? { ...r.refund } : null,
    pots: r.pots.map((p) => ({ amount: p.amount, eligible: p.eligible.slice(), winners: p.winners.map((w) => ({ ...w })), winningHand: p.winningHand })),
    shown: r.shown.map((s) => ({ playerId: s.playerId, hole: s.hole.slice(), category: s.category, name: s.name, cards: s.cards.slice() })),
    // Older snapshots predate mucking and equity.
    mucked: (r.mucked ?? []).slice(),
    equity: (r.equity ?? []).map((e) => ({ board: e.board, equity: { ...e.equity } })),
    payouts: { ...r.payouts },
    stacks: { ...r.stacks },
  };
}
