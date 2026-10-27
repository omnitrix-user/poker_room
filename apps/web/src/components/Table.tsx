import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Card } from "@riverroom/engine";
import type { ChatMessage, GameView, HandPlayerView, PublicHandEvent, RoomView, SeatPlayerView } from "@riverroom/protocol";
import { chips, initials, toneFor } from "../lib/format.ts";
import { ChipStack } from "./Chips.tsx";
import { CardSlot, PlayingCard } from "./PlayingCard.tsx";

const BUBBLE_MS = 6000;
/** Where chips gather in the middle of the felt (pot position). */
const POT_POINT = { x: 50, y: 36 };

interface Props {
  view: RoomView;
  clockOffset: number;
  onSit?: (seat: number) => void;
  /** Portrait phone layout: a tall oval. */
  portrait: boolean;
  chat?: ChatMessage[];
  /** An all-in runout is being revealed (results withheld; show equity). */
  revealing?: boolean;
}

interface Slot {
  seat: number;
  /** Seat centre, in % of the table box. */
  x: number;
  y: number;
}

/**
 * Seats in clockwise order starting with the viewer, who always sits at the bottom.
 * In the lobby every physical seat is shown; during play only occupied seats, spread
 * evenly, so a heads-up game faces across the table instead of sitting side by side.
 */
function orderedSeats(view: RoomView): number[] {
  const occupied = view.players.map((p) => p.seat).sort((a, b) => a - b);
  const seats = view.status === "lobby" ? Array.from({ length: view.settings.maxSeats }, (_, i) => i) : occupied;
  if (seats.length === 0) return [];
  const anchor = view.you.seat !== null && seats.includes(view.you.seat) ? view.you.seat : seats[0]!;
  const start = seats.indexOf(anchor);
  return seats.map((_, i) => seats[(start + i) % seats.length]!);
}

/** Landscape: seats evenly spaced by angle around the oval's rail. */
function ellipseSlots(seats: number[]): Slot[] {
  return seats.map((seat, k) => {
    const a = ((90 + (k * 360) / seats.length) * Math.PI) / 180;
    return { seat, x: 50 + 49 * Math.cos(a), y: 50 + 50 * Math.sin(a) };
  });
}

/**
 * Portrait: a tall oval leaves no room beside the board, so opponents sit on the upper and
 * lower parts of the long sides and across the top, keeping the board's row clear.
 * Points run clockwise: left side bottom-to-top, the top, then the right side top-to-bottom.
 */
const PORTRAIT_PATHS: Record<number, [number, number][]> = {
  1: [[50, 0]],
  2: [[3, 27], [97, 27]],
  3: [[3, 27], [50, 0], [97, 27]],
  4: [[3, 70], [3, 27], [97, 27], [97, 70]],
  5: [[3, 70], [3, 27], [50, 0], [97, 27], [97, 70]],
  6: [[3, 70], [3, 27], [24, 3], [76, 3], [97, 27], [97, 70]],
  7: [[14, 90], [3, 70], [3, 27], [50, 0], [97, 27], [97, 70], [86, 90]],
};

function portraitSlots(seats: number[]): Slot[] {
  const path = PORTRAIT_PATHS[seats.length - 1] ?? [];
  return seats.map((seat, k) => {
    const [x, y] = k === 0 ? [50, 100] : path[k - 1]!;
    return { seat, x, y };
  });
}

/** Bets sit between the seat and the middle of the felt. */
function towardCentre(slot: Slot, f: number): { x: number; y: number } {
  return { x: 50 + (slot.x - 50) * f, y: 48 + (slot.y - 48) * f };
}

const pct = (p: { x: number; y: number }): CSSProperties => ({ left: `${p.x}%`, top: `${p.y}%` });

// ---------------------------------------------------------------------------
// Chip motion

interface Flight {
  id: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  amount: number;
  delay: number;
}

/**
 * Animates chips instead of making them teleport: bets sweep into the pot when a street
 * ends, and the pot slides to the winner(s) when the hand is settled. Purely cosmetic —
 * the numbers on screen are always the server's.
 */
function useChipFlights(game: GameView | null, slots: Slot[], portrait: boolean): Flight[] {
  const prev = useRef<GameView | null>(null);
  const [flights, setFlights] = useState<Flight[]>([]);
  const nextId = useRef(0);
  useEffect(() => {
    const before = prev.current;
    prev.current = game;
    if (!game || !before || before.handNo !== game.handNo) return;
    const slotOf = (seat: number) => slots.find((s) => s.seat === seat);
    const out: Flight[] = [];
    const streetEnded = before.street !== game.street;
    if (streetEnded) {
      for (const p of before.players) {
        const slot = slotOf(p.seat);
        if (p.streetBet > 0 && slot) out.push({ id: ++nextId.current, from: towardCentre(slot, portrait ? 0.56 : 0.62), to: POT_POINT, amount: p.streetBet, delay: 0 });
      }
    }
    const settledNow = (game.result?.pots.length ?? 0) > 0 && !(before.result?.pots.length ?? 0);
    if (settledNow && game.result) {
      const won = new Map<string, number>();
      for (const pot of game.result.pots) for (const w of pot.winners) won.set(w.playerId, (won.get(w.playerId) ?? 0) + w.amount);
      for (const [id, amount] of won) {
        const seat = game.players.find((p) => p.playerId === id)?.seat;
        const slot = seat === undefined ? undefined : slotOf(seat);
        if (slot) out.push({ id: ++nextId.current, from: POT_POINT, to: { x: slot.x, y: slot.y }, amount, delay: streetEnded ? 450 : 150 });
      }
    }
    if (out.length) setFlights((f) => [...f, ...out]);
  }, [game?.handNo, game?.street, game?.seq, game?.result?.pots.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!flights.length) return;
    const longest = Math.max(...flights.map((f) => f.delay)) + 700;
    const t = setTimeout(() => setFlights([]), longest);
    return () => clearTimeout(t);
  }, [flights]);
  return flights;
}

// ---------------------------------------------------------------------------
// Chat bubbles

function useBubbles(chat: ChatMessage[] | undefined, clockOffset: number): Map<string, string> {
  const [, tick] = useState(0);
  const now = Date.now() + clockOffset;
  const recent = (chat ?? []).filter((m) => now - m.at < BUBBLE_MS);
  const soonest = recent.length ? Math.min(...recent.map((m) => m.at + BUBBLE_MS - now)) : null;
  useEffect(() => {
    if (soonest === null) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(50, soonest));
    return () => clearTimeout(t);
  }, [soonest, chat?.length]);
  const map = new Map<string, string>();
  for (const m of recent) map.set(m.playerId, m.text);
  return map;
}

// ---------------------------------------------------------------------------

export function Table({ view, clockOffset, onSit, portrait, chat, revealing = false }: Props) {
  const game = view.game;
  const seatOrder = orderedSeats(view);
  const slots = portrait ? portraitSlots(seatOrder) : ellipseSlots(seatOrder);
  const bySeat = new Map(view.players.map((p) => [p.seat, p]));
  const handBySeat = new Map(game?.players.map((p) => [p.seat, p]) ?? []);
  const complete = game?.street === "complete";
  const winners = new Set(complete ? game!.result!.pots.flatMap((p) => p.winners.map((w) => w.playerId)) : []);
  const showdown = complete && game!.result!.endedBy === "showdown";
  const winningCards = new Set<Card>(showdown ? game!.result!.shown.filter((s) => winners.has(s.playerId)).flatMap((s) => s.cards) : []);
  const flights = useChipFlights(game, slots, portrait);
  const bubbles = useBubbles(chat, clockOffset);
  const lastActions = game && !complete ? lastActionByPlayer(game) : new Map<string, PublicHandEvent>();
  // Equity for the stage that matches the cards currently on screen.
  const equityStage = revealing ? game!.result!.equity.find((e) => e.board === game!.board.length) : undefined;

  return (
    <div className={`table ${portrait ? "portrait" : ""}`} data-street={game?.street ?? view.status}>
      <div className="rail">
        <div className="felt">
          <div className="felt-line" aria-hidden="true" />
          <div className="center">
            {game ? (
              <>
                <PotLine game={game} view={view} />
                <Board game={game} winningCards={showdown ? winningCards : null} />
              </>
            ) : (
              <LobbyCenter view={view} />
            )}
          </div>
        </div>
      </div>

      {slots.map(({ seat, x, y }) => {
        const player = bySeat.get(seat);
        const hp = handBySeat.get(seat);
        return (
          <div key={seat} className={`seat-anchor ${y < 40 ? "top-half" : ""}`} style={{ left: `${x}%`, top: `${y}%` }}>
            {player ? (
              <Seat
                player={player}
                hand={hp}
                game={game}
                isYou={player.playerId === view.you.playerId}
                isWinner={winners.has(player.playerId)}
                winningCards={showdown ? winningCards : null}
                clockOffset={clockOffset}
                turnSeconds={view.settings.turnSeconds}
                lobby={view.status === "lobby"}
                lastAction={lastActions.get(player.playerId)}
                equity={equityStage?.equity[player.playerId]}
                bubble={bubbles.get(player.playerId)}
              />
            ) : (
              <EmptySeat seat={seat} onSit={onSit} />
            )}
          </div>
        );
      })}

      {game &&
        slots.map((slot) => {
          const hp = handBySeat.get(slot.seat);
          return (
            <div key={`bet-${slot.seat}`} className="bet-anchor" style={pct(towardCentre(slot, portrait ? 0.56 : 0.62))}>
              {hp && hp.streetBet > 0 && game.street !== "complete" && (
                <ChipStack key={`${game.handNo}-${game.street}`} amount={hp.streetBet} className="bet" />
              )}
              {slot.seat === game.buttonSeat && (
                <span className="dealer-btn" title="Dealer button" aria-label="Dealer">
                  D
                </span>
              )}
            </div>
          );
        })}

      {game && !slots.some((sl) => sl.seat === game.buttonSeat) && slots.length >= 2 && (
        <DeadButton slots={slots} seat={game.buttonSeat} portrait={portrait} />
      )}

      <div className="fx-layer" aria-hidden="true">
        {flights.map((f) => (
          <div
            key={f.id}
            className="flight"
            style={
              {
                "--fx": `${f.from.x}%`,
                "--fy": `${f.from.y}%`,
                "--tx": `${f.to.x}%`,
                "--ty": `${f.to.y}%`,
                "--delay": `${f.delay}ms`,
              } as CSSProperties
            }
          >
            <ChipStack amount={f.amount} max={4} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The button on an empty seat: drawn between the occupied seats on either side of it. */
function DeadButton({ slots, seat, portrait }: { slots: Slot[]; seat: number; portrait: boolean }) {
  const bySeat = slots.slice().sort((a, b) => a.seat - b.seat);
  const before = [...bySeat].reverse().find((s) => s.seat < seat) ?? bySeat[bySeat.length - 1]!;
  const after = bySeat.find((s) => s.seat > seat) ?? bySeat[0]!;
  const f = portrait ? 0.56 : 0.62;
  const a = towardCentre(before, f);
  const b = towardCentre(after, f);
  return (
    <div className="bet-anchor" style={pct({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })}>
      <span className="dealer-btn dead" title="Dead button (that seat is empty)" aria-label="Dead button">
        D
      </span>
    </div>
  );
}

function lastActionByPlayer(game: GameView): Map<string, PublicHandEvent> {
  const map = new Map<string, PublicHandEvent>();
  for (const e of game.events) {
    if (e.kind === "deal") map.clear();
    else if (e.kind === "action") map.set(e.playerId, e);
  }
  return map;
}

function actionLabel(e: PublicHandEvent): { text: string; tone: string } | null {
  if (e.kind !== "action") return null;
  if (e.allIn && e.action !== "fold") return { text: `All-in ${chips(e.to)}`, tone: "hot" };
  switch (e.action) {
    case "fold":
      return { text: "Fold", tone: "faint" };
    case "check":
      return { text: "Check", tone: "plain" };
    case "call":
      return { text: `Call ${chips(e.amount)}`, tone: "plain" };
    case "bet":
      return { text: `Bet ${chips(e.to)}`, tone: "brass" };
    case "raise":
      return { text: `Raise ${chips(e.to)}`, tone: "brass" };
    default:
      return null;
  }
}

function Board({ game, winningCards }: { game: GameView; winningCards: Set<Card> | null }) {
  // Cards that appear together (a flop) flip in one after another.
  const seen = useRef<{ hand: number; count: number }>({ hand: game.handNo, count: game.board.length });
  if (seen.current.hand !== game.handNo) seen.current = { hand: game.handNo, count: 0 };
  const firstNew = seen.current.count;
  useEffect(() => {
    seen.current = { hand: game.handNo, count: game.board.length };
  });
  return (
    <div className="board" aria-label={game.board.length ? `Board: ${game.board.length} cards` : "No board cards yet"}>
      {Array.from({ length: 5 }, (_, i) => {
        const card = game.board[i];
        if (!card) return <CardSlot key={`slot-${i}`} size="md" />;
        return (
          <PlayingCard
            key={`${game.handNo}-${card}`}
            card={card}
            size="md"
            animate="flip"
            delay={i >= firstNew ? (i - firstNew) * 90 : 0}
            highlight={winningCards?.has(card)}
            dim={winningCards ? !winningCards.has(card) : false}
          />
        );
      })}
    </div>
  );
}

function PotLine({ game, view }: { game: GameView; view: RoomView }) {
  const name = (id: string) => view.players.find((p) => p.playerId === id)?.name ?? "Player";
  const r = game.result;
  if (game.street === "complete" && r && r.pots.length > 0) {
    const main = r.pots[0];
    const totals = new Map<string, number>();
    for (const pot of r.pots) for (const w of pot.winners) totals.set(w.playerId, (totals.get(w.playerId) ?? 0) + w.amount);
    const parts = [...totals].map(([id, amt]) => `${name(id)} ${chips(amt)}`);
    return (
      <div className="pot result" role="status">
        <span className="pot-label">{totals.size > 1 ? "Split" : "Wins"}</span>
        <span className="pot-amount">{parts.join(" · ")}</span>
        {main?.winningHand && <span className="pot-hand">{main.winningHand}</span>}
        {r.pots.length > 1 && <span className="pot-hand faint">{r.pots.length - 1} side pot{r.pots.length > 2 ? "s" : ""}</span>}
      </div>
    );
  }
  // The full pot, including bets still in front of players this street.
  return (
    <div className="pot" aria-label={`Pot ${chips(game.potTotal)}`}>
      <span className="pot-label">{game.street === "complete" ? "All-in" : "Pot"}</span>
      <span className="pot-amount num">{chips(game.potTotal)}</span>
    </div>
  );
}

function LobbyCenter({ view }: { view: RoomView }) {
  const seated = view.players.length;
  return (
    <div className="lobby-center">
      <span className="eyebrow">{view.status === "finished" ? "Session over" : "Waiting room"}</span>
      <span className="lobby-count">
        {seated} of {view.settings.maxSeats} seated
      </span>
      <span className="faint num">
        Blinds {chips(view.settings.smallBlind)}/{chips(view.settings.bigBlind)} · Buy-in {chips(view.settings.startingStack)}
      </span>
      {view.roundsTotal !== null && <span className="faint num">{view.roundsTotal} rounds</span>}
    </div>
  );
}

function EmptySeat({ seat, onSit }: { seat: number; onSit?: (seat: number) => void }) {
  if (!onSit) return <div className="seat empty" aria-hidden="true" />;
  return (
    <button type="button" className="seat empty open" onClick={() => onSit(seat)} aria-label={`Sit in seat ${seat + 1}`}>
      <span>Seat {seat + 1}</span>
      <span className="faint">Sit here</span>
    </button>
  );
}

interface SeatProps {
  player: SeatPlayerView;
  hand: HandPlayerView | undefined;
  game: GameView | null;
  isYou: boolean;
  isWinner: boolean;
  winningCards: Set<Card> | null;
  clockOffset: number;
  turnSeconds: number;
  lobby: boolean;
  lastAction: PublicHandEvent | undefined;
  equity: number | undefined;
  bubble: string | undefined;
}

function Seat({ player, hand, game, isYou, isWinner, winningCards, clockOffset, turnSeconds, lobby, lastAction, equity, bubble }: SeatProps) {
  const toAct = game && game.toActSeat === player.seat && game.street !== "complete";
  const status = seatStatus(player, hand, game, lobby, Boolean(toAct), lastAction);
  const blind = game && game.street !== "complete" ? (game.sbSeat === player.seat ? "SB" : game.bbSeat === player.seat ? "BB" : null) : null;
  const cls = [
    "seat",
    isYou && "you",
    toAct && "turn",
    hand?.status === "folded" && "folded",
    hand?.status === "allin" && "allin",
    !player.connected && "offline",
    isWinner && "winner",
    !hand && !lobby && "sitting-out",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cls}
      aria-label={`${player.name}${isYou ? " (you)" : ""}, stack ${chips(player.stack)}${status ? `, ${status.text}` : ""}`}
    >
      {bubble && (
        <div className="bubble" role="note">
          {bubble}
        </div>
      )}
      {hand && <HoleCards hand={hand} handNo={game!.handNo} isYou={isYou} winningCards={winningCards} />}
      <div className="plate">
        <span className="mono" style={{ background: toneFor(player.playerId) }} aria-hidden="true">
          {initials(player.name)}
        </span>
        <span className="meta">
          <span className="name">
            {player.name}
            {player.isHost && <span className="host-mark" title="Host">Host</span>}
          </span>
          <span className="stack num">{hand?.status === "allin" && (game?.street !== "complete" || !game.result?.pots.length) ? "All-in" : chips(player.stack)}</span>
        </span>
        {blind && <span className="blind-tag">{blind}</span>}
        {equity !== undefined && <span className="equity num">{Math.round(equity * 100)}%</span>}
      </div>
      {status && (
        <span key={status.text} className={`seat-status ${status.tone}`}>
          {status.text}
        </span>
      )}
      {toAct && game!.turnDeadline && turnSeconds > 0 && (
        <TurnClock key={`${game!.handNo}:${game!.seq}`} deadline={game!.turnDeadline} offset={clockOffset} total={turnSeconds * 1000} />
      )}
    </div>
  );
}

function seatStatus(
  p: SeatPlayerView,
  hand: HandPlayerView | undefined,
  game: GameView | null,
  lobby: boolean,
  toAct: boolean,
  lastAction: PublicHandEvent | undefined,
): { text: string; tone: string } | null {
  if (lobby) {
    if (p.isHost) return null;
    return p.ready ? { text: "Ready", tone: "ok" } : { text: "Not ready", tone: "faint" };
  }
  if (p.left) return { text: "Left", tone: "faint" };
  if (p.away) return { text: "Away", tone: "warn" };
  if (!p.connected) return { text: "Reconnecting…", tone: "warn" };
  if (toAct) return { text: "To act", tone: "turn" };
  const result = game?.street === "complete" ? game.result : null;
  if (result && hand) {
    const shown = result.shown.find((s) => s.playerId === p.playerId);
    const won = result.pots.reduce((sum, pot) => sum + (pot.winners.find((w) => w.playerId === p.playerId)?.amount ?? 0), 0);
    if (won > 0 && !shown?.name) return { text: `Wins ${chips(won)}`, tone: "brass" };
    if (shown?.name) return { text: shown.name, tone: result.pots.some((pot) => pot.winners.some((w) => w.playerId === p.playerId)) ? "brass" : "plain" };
    if (result.mucked.includes(p.playerId)) return { text: "Mucked", tone: "faint" };
    if (hand.showedByChoice) return { text: "Shows", tone: "brass" };
  }
  if (lastAction) return actionLabel(lastAction);
  if (hand?.status === "allin") return { text: "All-in", tone: "hot" };
  if (hand?.status === "folded") return { text: "Folded", tone: "faint" };
  if (!hand && p.stack === 0) return { text: "Out", tone: "faint" };
  if (!hand && p.sittingOut) return { text: "Sitting out", tone: "faint" };
  if (!hand && p.willPost) return { text: "Posts to join", tone: "faint" };
  if (!hand) return { text: "Next hand", tone: "faint" };
  return null;
}

function HoleCards({ hand, handNo, isYou, winningCards }: { hand: HandPlayerView; handNo: number; isYou: boolean; winningCards: Set<Card> | null }) {
  const folded = hand.status === "folded";
  const cards = hand.cards;
  // A folded opponent's cards leave the table — unless they chose to show them.
  if (folded && !isYou && !cards) return <div className="hole mucked" aria-hidden="true" />;
  const size = isYou ? "lg" : "sm";
  return (
    <div className={`hole ${isYou ? "mine" : ""} ${folded && !hand.showedByChoice ? "folded" : ""}`}>
      {[0, 1].map((i) => {
        const c = cards?.[i] ?? null;
        return (
          <PlayingCard
            key={`${handNo}-${i}-${c ?? "back"}`}
            card={c}
            size={size}
            animate={c && !isYou ? "flip" : "deal"}
            delay={i * 70}
            highlight={c ? winningCards?.has(c) : false}
            dim={winningCards && c ? !winningCards.has(c) : false}
          />
        );
      })}
    </div>
  );
}

function TurnClock({ deadline, offset, total }: { deadline: number; offset: number; total: number }) {
  const remaining = Math.max(0, deadline - (Date.now() + offset));
  const [secs, setSecs] = useState(Math.ceil(remaining / 1000));
  useEffect(() => {
    const id = setInterval(() => setSecs(Math.max(0, Math.ceil((deadline - (Date.now() + offset)) / 1000))), 250);
    return () => clearInterval(id);
  }, [deadline, offset]);
  const start = Math.min(1, remaining / total);
  return (
    <div className={`turn-clock ${secs <= 5 ? "low" : ""}`} role="timer" aria-label={`${secs} seconds left`}>
      <span className="bar" style={{ "--start": start, "--dur": `${remaining}ms` } as CSSProperties} />
      {secs <= 10 && <span className="secs num">{secs}s</span>}
    </div>
  );
}
