import type { Card, HandState } from "@riverroom/engine";
import type { RoomSettings, RoomStatus } from "@riverroom/protocol";

export interface Member {
  playerId: string;
  name: string;
  seat: number | null;
  /** Chips behind outside of a hand (authoritative stack between hands). */
  stack: number;
  /** Chips granted by the table (starting stack). Net = stack - buyIn. */
  buyIn: number;
  ready: boolean;
  /** Left a running game; finishes the current hand folded and is no longer dealt in. */
  left: boolean;
  /** Skipped for new hands until they come back (by choice or after timing out). */
  sittingOut?: boolean;
  /** Hands played when they sat out, to know whether they missed any. */
  sitOutAt?: number;
  /** Posts a big blind to be dealt into their next hand (joined late or came back). */
  needsPost?: boolean;
}

/**
 * Everything needed to restore a room after a restart. Persisted (encrypted) as one
 * snapshot in the same transaction as every state change, so it never diverges from
 * the hand log.
 */
export interface RoomData {
  id: string;
  code: string;
  hostId: string;
  settings: RoomSettings;
  status: RoomStatus;
  members: Member[];
  handsPlayed: number;
  buttonSeat: number | null;
  /** The current or most recently completed hand. Contains the deck: never sent to clients as-is. */
  hand: HandState | null;
  /** How many of `hand.events` are already written to `hand_events`. */
  persistedEvents: number;
  endRequested: boolean;
  /** Cards players chose to reveal after the current/last hand ended. */
  shows?: Record<string, Card[]>;
  /** Rounds added by unanimous extension votes. */
  extraRounds?: number;
  /** Extension vote in progress (deadline is epoch ms). */
  vote?: Vote | null;
  /** Monotonic snapshot version used for optimistic concurrency on writes. */
  version: number;
}

export interface Vote {
  id: number;
  proposerId: string;
  add: number;
  voters: string[];
  yes: string[];
  deadline: number;
}

/** Rounds in the match including extensions, or null for legacy matches without a limit. */
export function roundsTotal(d: Pick<RoomData, "settings" | "extraRounds">): number | null {
  const base = (d.settings as { rounds?: number }).rounds;
  return base ? base + (d.extraRounds ?? 0) : null;
}
