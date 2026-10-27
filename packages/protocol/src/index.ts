import { z } from "zod";
import type { ActionType, Card, EquityStage, HandCategory, LegalActions, PlayerStatus, Street } from "@riverroom/engine";

// ---------------------------------------------------------------------------
// Shared constants

export const MIN_SEATS = 2;
export const MAX_SEATS = 8;
export const TURN_CLOCK_OPTIONS = [0, 15, 30, 60] as const;
export const SESSION_COOKIE = "rr_session";
export const MAX_ROUNDS = 500;
export const ROUND_OPTIONS = [10, 20, 30, 50, 100] as const;
export const EXTEND_OPTIONS = [5, 10, 20] as const;

// ---------------------------------------------------------------------------
// Input schemas (validated on the server for every payload)

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(20, "Keep it to 20 characters.")
  .regex(/^[\p{L}\p{N} ._'-]+$/u, "Use letters, numbers, spaces, and . _ ' - only.");

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Usernames need at least 3 characters.")
  .max(20, "Keep your username to 20 characters.")
  .regex(/^[A-Za-z0-9_.-]+$/, "Use letters, numbers, and . _ - only (no spaces).");

export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters for your password.")
  .max(128, "That password is too long.");

export const roomSettingsSchema = z
  .object({
    smallBlind: z.number().int().min(1).max(100_000),
    bigBlind: z.number().int().min(2).max(200_000),
    startingStack: z.number().int().min(20).max(10_000_000),
    maxSeats: z.number().int().min(MIN_SEATS).max(MAX_SEATS),
    turnSeconds: z.union(TURN_CLOCK_OPTIONS.map((n) => z.literal(n)) as [z.ZodLiteral<0>, ...z.ZodLiteral<number>[]]),
    /** Busted players may take another starting stack. */
    rebuys: z.boolean(),
    /** Match length in rounds (one round = one hand dealt). Players may vote to extend it. */
    rounds: z.number().int().min(1).max(MAX_ROUNDS),
  })
  .refine((s) => s.bigBlind >= s.smallBlind, { message: "Big blind must be at least the small blind." })
  .refine((s) => s.startingStack >= s.bigBlind * 10, { message: "Starting stack must be at least 10 big blinds." });

export type RoomSettings = z.infer<typeof roomSettingsSchema>;

export const DEFAULT_SETTINGS: RoomSettings = {
  smallBlind: 10,
  bigBlind: 20,
  startingStack: 2000,
  maxSeats: 6,
  turnSeconds: 30,
  rebuys: true,
  rounds: 20,
};

export const CHAT_MAX_LENGTH = 160;

/** Invite codes: 8 characters from an unambiguous alphabet. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-HJ-NP-Z2-9]{8}$/, "That doesn't look like a room code.");

export const engineActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fold") }),
  z.object({ type: z.literal("check") }),
  z.object({ type: z.literal("call") }),
  z.object({ type: z.literal("bet"), amount: z.number().int().positive() }),
  z.object({ type: z.literal("raise"), amount: z.number().int().positive() }),
  z.object({ type: z.literal("allin") }),
]);

export const clientEvents = {
  "room:join": z.object({ code: roomCodeSchema }),
  "room:leave": z.object({}),
  "room:sit": z.object({ seat: z.number().int().min(0).max(MAX_SEATS - 1) }),
  "room:ready": z.object({ ready: z.boolean() }),
  "room:settings": z.object({ settings: roomSettingsSchema }),
  "room:end": z.object({}),
  "room:rebuy": z.object({}),
  "room:sitout": z.object({ sitOut: z.boolean() }),
  "room:chat": z.object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(CHAT_MAX_LENGTH)
      .transform((t) => t.replace(/\s+/g, " ")),
  }),
  /** Propose playing more rounds; passes only if every player at the table agrees. */
  "room:vote-start": z.object({ add: z.number().int().min(1).max(100) }),
  "room:vote": z.object({ id: z.number().int().positive(), yes: z.boolean() }),
  /** Reveal your hole cards after a hand you were in has ended. */
  "game:show": z.object({ handNo: z.number().int().positive() }),
  "game:start": z.object({}),
  "game:action": z.object({
    actionId: z.string().uuid(),
    handNo: z.number().int().positive(),
    /** The hand's action sequence number the client was looking at. */
    seq: z.number().int().min(0),
    action: engineActionSchema,
  }),
} as const;

export type ClientEventName = keyof typeof clientEvents;
export type ClientPayload<E extends ClientEventName> = z.infer<(typeof clientEvents)[E]>;

export type ErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "rate_limited"
  | "room_not_found"
  | "room_full"
  | "room_finished"
  | "not_member"
  | "not_seated"
  | "not_host"
  | "seat_taken"
  | "cannot_start"
  | "wrong_state"
  | "stale"
  | "not_your_turn"
  | "illegal_action"
  | "invalid_amount"
  | "persistence_failed"
  | "internal";

export type Ack<T = object> = ({ ok: true } & T) | { ok: false; code: ErrorCode; message: string };

// ---------------------------------------------------------------------------
// Server → client views (always built per recipient)

export interface SeatPlayerView {
  playerId: string;
  name: string;
  seat: number;
  /** Chips behind (excluding chips committed in the current hand). */
  stack: number;
  /** Total chips received from the table (starting stack). */
  buyIn: number;
  connected: boolean;
  /** Disconnected past the grace period; skipped for new hands. */
  away: boolean;
  ready: boolean;
  isHost: boolean;
  left: boolean;
  /** Not being dealt in by choice (or after timing out). */
  sittingOut: boolean;
  /** Will post a big blind to be dealt into the next hand (joined late or came back). */
  willPost: boolean;
}

export interface HandPlayerView {
  playerId: string;
  seat: number;
  status: PlayerStatus;
  stack: number;
  streetBet: number;
  totalBet: number;
  /** Hole cards: only the recipient's own, or cards revealed at showdown or by choice. Null when hidden. */
  cards: Card[] | null;
  /** The player chose to show their cards after the hand. */
  showedByChoice: boolean;
}

export type PublicHandEvent =
  | { kind: "blind"; playerId: string; blind: "small" | "big" | "post"; amount: number; allIn: boolean }
  | { kind: "deal"; street: "flop" | "turn" | "river"; cards: Card[] }
  | { kind: "action"; playerId: string; street: Street; action: ActionType; amount: number; to: number; allIn: boolean };

export interface PublicHandResult {
  endedBy: "fold" | "showdown";
  refund: { playerId: string; amount: number } | null;
  pots: {
    amount: number;
    eligible: string[];
    winners: { playerId: string; amount: number }[];
    winningHand: string | null;
  }[];
  shown: { playerId: string; hole: Card[]; category: HandCategory; name: string; cards: Card[] }[];
  mucked: string[];
  equity: EquityStage[];
  payouts: Record<string, number>;
  stacks: Record<string, number>;
}

export interface GameView {
  handNo: number;
  seq: number;
  street: Street;
  board: Card[];
  /** May be an empty seat (dead button). */
  buttonSeat: number;
  /** Null when the small blind is dead this hand. */
  sbSeat: number | null;
  bbSeat: number;
  smallBlind: number;
  bigBlind: number;
  currentBet: number;
  minRaise: number;
  /** All chips committed this hand. */
  potTotal: number;
  toActSeat: number | null;
  /** Epoch ms when the current turn auto-acts, or null if there is no clock. */
  turnDeadline: number | null;
  players: HandPlayerView[];
  events: PublicHandEvent[];
  result: PublicHandResult | null;
  /** Present only for the recipient, only when it is their turn. */
  legal: LegalActions | null;
}

export type RoomStatus = "lobby" | "playing" | "finished";

export interface VoteView {
  id: number;
  proposerId: string;
  /** Rounds to add if everyone agrees. */
  add: number;
  /** Everyone who must say yes. */
  voters: string[];
  yes: string[];
  /** Epoch ms when the vote lapses (counts as "no"). */
  deadline: number;
}

export interface RoomView {
  roomId: string;
  code: string;
  status: RoomStatus;
  hostId: string;
  settings: RoomSettings;
  players: SeatPlayerView[];
  you: { playerId: string; seat: number | null; isHost: boolean };
  game: GameView | null;
  /** Epoch ms when the next hand will be dealt, if scheduled. */
  nextHandAt: number | null;
  endRequested: boolean;
  /** Human-readable reason the table is paused, if any. */
  waitingFor: string | null;
  handsPlayed: number;
  /** Rounds in this match including agreed extensions (null for legacy matches without a limit). */
  roundsTotal: number | null;
  /** An extension vote in progress. */
  vote: VoteView | null;
  /** After the final round: epoch ms until which an extension can still be proposed. */
  finalWindowUntil: number | null;
  serverTime: number;
}

export interface Notice {
  kind: "info" | "warn";
  text: string;
}

export interface ChatMessage {
  id: number;
  playerId: string;
  name: string;
  text: string;
  at: number;
}

export interface ServerToClient {
  "room:state": (view: RoomView) => void;
  "room:chat": (message: ChatMessage) => void;
  "room:chat-history": (messages: ChatMessage[]) => void;
  "room:notice": (notice: Notice) => void;
  "room:superseded": () => void;
}

// ---------------------------------------------------------------------------
// HTTP API shapes

export interface SessionSummary {
  roomId: string;
  roundsTotal: number | null;
  code: string;
  status: RoomStatus;
  createdAt: string;
  endedAt: string | null;
  handsPlayed: number;
  players: { playerId: string; name: string; buyIn: number; stack: number; net: number }[];
}

export interface HandSummary {
  handNo: number;
  endedAt: string | null;
  board: Card[];
  potTotal: number;
  winners: { playerId: string; amount: number }[];
  winningHand: string | null;
}

export interface HandDetail {
  handNo: number;
  roomId: string;
  startedAt: string;
  endedAt: string | null;
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  players: { playerId: string; name: string; seat: number; startStack: number; endStack: number | null; shown: Card[] | null }[];
  events: PublicHandEvent[];
  result: PublicHandResult | null;
}

export interface Me {
  id: string;
  /** Name shown at the table. */
  name: string;
  /** Login name when the player has an account; null for guests. */
  username: string | null;
}

export interface StatsResponse {
  /** Biggest single pot share won (play-money rupees). */
  biggestPot: number;
  /** Best hand category shown down (engine HandCategory), or null. */
  bestHand: number | null;
  handsPlayed: number;
  handsWon: number;
  showdownsReached: number;
  showdownsWon: number;
  sessions: number;
  /** Net virtual chips across all sessions. Not money. */
  netChips: number;
  recent: { roomId: string; code: string; endedAt: string | null; createdAt: string; net: number; handsPlayed: number }[];
}
