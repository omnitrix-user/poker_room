import {
  ActionError,
  applyAction,
  findInvariantViolations,
  freshDeck,
  legalActions,
  nextBlinds,
  secureRandomInt,
  shuffle,
  startHand,
  type Action,
  type HandState,
} from "@riverroom/engine";
import { DEFAULT_SETTINGS, type Ack, type ChatMessage, type ClientPayload, type ErrorCode, type RoomSettings, type ServerToClient } from "@riverroom/protocol";
import type { Config } from "./config.ts";
import { errInfo, log } from "./log.ts";
import { roundsTotal, type Member, type RoomData } from "./model.ts";
import { Store } from "./store.ts";
import { buildRoomView } from "./views.ts";

/** A connected client (one browser tab). Abstracts the socket for testability. */
export interface Client {
  id: string;
  send<E extends keyof ServerToClient>(event: E, ...args: Parameters<ServerToClient[E]>): void;
}

export interface Presence {
  connected: boolean;
  since: number;
  /** Disconnected for longer than the grace period. */
  away: boolean;
  graceTimer?: NodeJS.Timeout;
}

const fail = (code: ErrorCode, message: string): Ack<never> => ({ ok: false, code, message });

/** Error raised inside a room operation that should be returned to the caller as-is. */
class RoomError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const AUTO_ACT_DELAY_MS = 1200;
const RECENT_ACTION_LIMIT = 256;
const CHAT_HISTORY = 50;

export class Room {
  data: RoomData;
  readonly presence = new Map<string, Presence>();
  turnDeadline: number | null = null;
  nextHandAt: number | null = null;
  waitingFor: string | null = null;
  /** After the final round, until when players can still call an extension vote. */
  finalWindowUntil: number | null = null;

  private readonly clients = new Map<string, Client>();
  private queue: Promise<unknown> = Promise.resolve();
  private turnKey: string | null = null;
  private turnTimer: NodeJS.Timeout | undefined;
  private voteTimer: NodeJS.Timeout | undefined;
  /** The round limit for which the final window has already been offered. */
  private finalWindowFor: number | null = null;
  private nextHandTimer: NodeJS.Timeout | undefined;
  private readonly recentActions = new Map<string, Ack>();
  /** Recent table chat. Kept in memory only (not part of the game record). */
  private readonly chatLog: ChatMessage[] = [];
  private chatId = 0;
  private disposed = false;

  constructor(
    data: RoomData,
    private readonly store: Store,
    private readonly config: Config,
    private readonly onFinished: (room: Room) => void = () => {},
  ) {
    this.data = data;
  }

  get id() {
    return this.data.id;
  }

  /** Restores timers and presence after loading from a snapshot (server restart). */
  resume(): void {
    for (const m of this.data.members) if (m.seat !== null) this.markDisconnected(m.playerId);
    this.armVoteTimer();
    this.afterChange();
  }

  /** Loads recent chat after a restart. */
  async loadChat(): Promise<void> {
    const recent = await this.store.recentChat(this.id, CHAT_HISTORY);
    this.chatLog.splice(0, this.chatLog.length, ...recent);
    this.chatId = recent[recent.length - 1]?.id ?? 0;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.turnTimer);
    clearTimeout(this.voteTimer);
    clearTimeout(this.nextHandTimer);
    for (const p of this.presence.values()) clearTimeout(p.graceTimer);
  }

  // -------------------------------------------------------------------------
  // Serialization: every mutation runs through this queue, one at a time.

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Runs a timer- or event-triggered operation; failures are logged, never thrown. */
  private background(op: string, fn: () => Promise<void>): void {
    this.run(fn).catch((err) => log.error("background room operation failed", { op, roomId: this.id, ...errInfo(err) }));
  }

  /** Runs a client request, converting RoomErrors and unexpected failures into acks. */
  private request<T extends object>(op: string, playerId: string, fn: () => Promise<Ack<T>>): Promise<Ack<T>> {
    return this.run(async () => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof RoomError) return fail(err.code, err.message);
        log.error("room operation failed", { op, roomId: this.id, playerId, ...errInfo(err) });
        return fail("persistence_failed", "Something went wrong saving that. Please try again.");
      }
    });
  }

  private draft(): RoomData {
    return structuredClone(this.data);
  }

  /** Persists `next` atomically, then makes it the live state. */
  private async commit(next: RoomData, clientActionId: string | null = null, extra?: Parameters<Store["commit"]>[3]): Promise<void> {
    next.version = this.data.version + 1;
    next.persistedEvents = next.hand ? next.hand.events.length : 0;
    await this.store.commit(this.data, next, clientActionId, extra);
    this.data = next;
  }

  // -------------------------------------------------------------------------
  // Membership

  /** Only the most recently joined tab of a player may act for them. */
  isCurrentClient(playerId: string, clientId: string): boolean {
    return this.clients.get(playerId)?.id === clientId;
  }

  member(playerId: string): Member | undefined {
    return this.data.members.find((m) => m.playerId === playerId);
  }

  isAway(playerId: string): boolean {
    return this.presence.get(playerId)?.away ?? false;
  }

  join(player: { id: string; name: string }, client: Client): Promise<Ack> {
    return this.request("join", player.id, async () => {
      const d = this.draft();
      if (d.status === "finished") throw new RoomError("room_finished", "This session has ended. You can review it in History.");
      let m = d.members.find((x) => x.playerId === player.id);
      let changed = false;
      if (!m) {
        const seat = this.freeSeat(d);
        if (seat === null) throw new RoomError("room_full", "This table is full.");
        const stack = d.status === "playing" ? d.settings.startingStack : 0;
        m = { playerId: player.id, name: player.name, seat, stack, buyIn: stack, ready: false, left: false, needsPost: d.status === "playing" };
        d.members.push(m);
        changed = true;
      } else if (m.seat === null || m.left) {
        // Returning after leaving: retake a seat with the chips they left with (no new buy-in).
        const seat = m.seat ?? this.freeSeat(d);
        if (seat === null) throw new RoomError("room_full", "This table is full.");
        m.seat = seat;
        m.left = false;
        changed = true;
      }
      if (m.name !== player.name) {
        m.name = player.name;
        changed = true;
      }
      if (changed) await this.commit(d);

      const previous = this.clients.get(player.id);
      if (previous && previous.id !== client.id) previous.send("room:superseded");
      this.clients.set(player.id, client);
      client.send("room:chat-history", this.chatLog.slice());
      this.markConnected(player.id);
      this.afterChange();
      this.maybeResume();
      return { ok: true };
    });
  }

  /** Called when a client's socket disconnects. */
  detach(playerId: string, clientId: string): void {
    if (this.clients.get(playerId)?.id !== clientId) return;
    this.clients.delete(playerId);
    this.background("detach", async () => {
      if (this.clients.has(playerId)) return; // reconnected in the meantime
      this.markDisconnected(playerId);
      this.afterChange();
    });
  }

  private markConnected(playerId: string): void {
    const p = this.presence.get(playerId);
    clearTimeout(p?.graceTimer);
    const wasAway = p?.away ?? false;
    this.presence.set(playerId, { connected: true, since: Date.now(), away: false });
    const name = this.member(playerId)?.name;
    if (p && !p.connected && name) this.notifyOthers(playerId, { kind: "info", text: wasAway ? `${name} is back.` : `${name} reconnected.` });
  }

  private markDisconnected(playerId: string): void {
    const prev = this.presence.get(playerId);
    clearTimeout(prev?.graceTimer);
    const presence: Presence = { connected: false, since: Date.now(), away: false };
    presence.graceTimer = setTimeout(() => {
      this.background("grace-expired", async () => {
        if (this.presence.get(playerId) !== presence) return;
        presence.away = true;
        this.afterChange();
      });
    }, this.config.reconnectGraceMs);
    this.presence.set(playerId, presence);
    const name = this.member(playerId)?.name;
    if (name && prev?.connected) this.notifyOthers(playerId, { kind: "warn", text: `${name} disconnected.` });
  }

  private freeSeat(d: RoomData): number | null {
    const taken = new Set(d.members.filter((m) => m.seat !== null).map((m) => m.seat));
    for (let s = 0; s < d.settings.maxSeats; s++) if (!taken.has(s)) return s;
    return null;
  }

  leave(playerId: string): Promise<Ack> {
    return this.request("leave", playerId, async () => {
      const d = this.draft();
      const m = d.members.find((x) => x.playerId === playerId);
      if (!m) throw new RoomError("not_member", "You are not in this room.");
      if (d.status === "lobby") {
        d.members = d.members.filter((x) => x !== m);
      } else if (d.status === "playing") {
        m.left = true;
        m.ready = false;
        const inHand = d.hand && d.hand.street !== "complete" && d.hand.players.some((p) => p.playerId === playerId);
        if (!inHand) m.seat = null;
        else if (d.hand!.toAct === m.seat) {
          d.hand = this.applyChecked(d.hand!, playerId, { type: "fold" });
          this.onHandProgress(d);
        }
      }
      this.transferHostIfNeeded(d);
      const voteOutcome = d.vote ? this.dropVoter(d, playerId) : null;
      await this.commit(d);
      if (voteOutcome) this.announceVote(voteOutcome, d);
      this.clients.delete(playerId);
      this.presence.delete(playerId);
      this.afterChange();
      if (d.status === "playing") this.background("session-end-check", async () => void (await this.checkSessionEnd()));
      return { ok: true };
    });
  }

  private transferHostIfNeeded(d: RoomData): void {
    const host = d.members.find((m) => m.playerId === d.hostId);
    if (host && !host.left) return;
    const next = d.members.find((m) => !m.left && m.seat !== null && this.presence.get(m.playerId)?.connected) ?? d.members.find((m) => !m.left);
    if (next) d.hostId = next.playerId;
  }

  // -------------------------------------------------------------------------
  // Lobby

  sit(playerId: string, { seat }: ClientPayload<"room:sit">): Promise<Ack> {
    return this.request("sit", playerId, async () => {
      const d = this.draft();
      if (d.status !== "lobby") throw new RoomError("wrong_state", "Seats can only be changed before the game starts.");
      const m = d.members.find((x) => x.playerId === playerId);
      if (!m) throw new RoomError("not_member", "You are not in this room.");
      if (seat >= d.settings.maxSeats) throw new RoomError("bad_request", "That seat does not exist.");
      if (d.members.some((x) => x.seat === seat && x !== m)) throw new RoomError("seat_taken", "That seat is taken.");
      m.seat = seat;
      await this.commit(d);
      this.afterChange();
      return { ok: true };
    });
  }

  setReady(playerId: string, { ready }: ClientPayload<"room:ready">): Promise<Ack> {
    return this.request("ready", playerId, async () => {
      const d = this.draft();
      if (d.status !== "lobby") throw new RoomError("wrong_state", "The game has already started.");
      const m = d.members.find((x) => x.playerId === playerId);
      if (!m || m.seat === null) throw new RoomError("not_seated", "Take a seat first.");
      m.ready = ready;
      await this.commit(d);
      this.afterChange();
      return { ok: true };
    });
  }

  updateSettings(playerId: string, { settings }: { settings: RoomSettings }): Promise<Ack> {
    return this.request("settings", playerId, async () => {
      const d = this.draft();
      if (d.hostId !== playerId) throw new RoomError("not_host", "Only the host can change table settings.");
      if (d.status !== "lobby") throw new RoomError("wrong_state", "Settings are locked once the game starts.");
      const occupied = d.members.filter((m) => m.seat !== null && m.seat >= settings.maxSeats);
      if (occupied.length) throw new RoomError("bad_request", `Seat ${occupied[0]!.seat! + 1} is occupied; it can't be removed.`);
      d.settings = settings;
      // Changing the stakes invalidates readiness.
      for (const m of d.members) if (m.playerId !== playerId) m.ready = false;
      await this.commit(d);
      this.afterChange();
      return { ok: true };
    });
  }

  start(playerId: string): Promise<Ack> {
    return this.request("start", playerId, async () => {
      const d = this.draft();
      if (d.hostId !== playerId) throw new RoomError("not_host", "Only the host can start the game.");
      if (d.status !== "lobby") throw new RoomError("wrong_state", "The game has already started.");
      const seated = d.members.filter((m) => m.seat !== null);
      if (seated.length < 2) throw new RoomError("cannot_start", "At least two seated players are needed.");
      const notReady = seated.filter((m) => m.playerId !== d.hostId && !m.ready);
      if (notReady.length) throw new RoomError("cannot_start", `Waiting for ${notReady.map((m) => m.name).join(", ")} to be ready.`);
      d.status = "playing";
      // Tables created before a setting existed start with its default (e.g. a round limit).
      d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
      for (const m of seated) {
        m.stack = d.settings.startingStack;
        m.buyIn = d.settings.startingStack;
      }
      await this.commit(d);
      await this.startNextHand();
      return { ok: true };
    });
  }

  requestEnd(playerId: string): Promise<Ack> {
    return this.request("end", playerId, async () => {
      const d = this.draft();
      if (d.hostId !== playerId) throw new RoomError("not_host", "Only the host can end the session.");
      if (d.status === "finished") return { ok: true };
      const handLive = d.hand && d.hand.street !== "complete";
      if (d.status === "lobby" || !handLive) {
        await this.finish(d);
      } else {
        d.endRequested = true;
        await this.commit(d);
        this.broadcastNotice({ kind: "info", text: "The host ended the session. This is the last hand." });
      }
      this.afterChange();
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------
  // Game actions

  act(playerId: string, payload: ClientPayload<"game:action">): Promise<Ack> {
    const cached = this.recentActions.get(payload.actionId);
    if (cached) return Promise.resolve(cached);
    return this.request("action", playerId, async () => {
      // Re-check inside the queue: the same id may have been processed while waiting.
      const dup = this.recentActions.get(payload.actionId);
      if (dup) return dup;
      const ack = await this.processAction(playerId, payload);
      this.recentActions.set(payload.actionId, ack);
      if (this.recentActions.size > RECENT_ACTION_LIMIT) this.recentActions.delete(this.recentActions.keys().next().value!);
      return ack;
    });
  }

  private async processAction(playerId: string, payload: ClientPayload<"game:action">): Promise<Ack> {
    // Survives restarts: an action that was committed but whose acknowledgement was lost.
    if (await this.store.actionRecorded(payload.actionId)) return { ok: true };
    const d = this.draft();
    const m = d.members.find((x) => x.playerId === playerId);
    if (!m || m.seat === null) return fail("not_seated", "You are not seated at this table.");
    const hand = d.hand;
    if (d.status !== "playing" || !hand || hand.street === "complete") return fail("wrong_state", "There is no hand in progress.");
    if (payload.handNo !== hand.handNo || payload.seq !== hand.seq) return fail("stale", "The table moved on before your action arrived.");
    try {
      d.hand = this.applyChecked(hand, playerId, payload.action);
    } catch (err) {
      if (err instanceof ActionError) {
        const code: ErrorCode = err.code === "not_your_turn" || err.code === "invalid_amount" ? err.code : err.code === "not_in_hand" ? "not_seated" : "illegal_action";
        return fail(code, err.message);
      }
      throw err;
    }
    this.onHandProgress(d);
    await this.commit(d, payload.actionId);
    this.afterChange();
    return { ok: true };
  }

  /** Applies an engine action and refuses to continue from a state that breaks an invariant. */
  private applyChecked(hand: HandState, playerId: string, action: Action): HandState {
    const next = applyAction(hand, playerId, action);
    const violations = findInvariantViolations(next);
    if (violations.length) {
      log.error("invariant violation; action refused", { roomId: this.id, handNo: hand.handNo, violations });
      throw new Error("invariant violation");
    }
    return next;
  }

  /** Bookkeeping when a hand may have completed. Mutates the draft. */
  private onHandProgress(d: RoomData): void {
    const hand = d.hand!;
    if (hand.street !== "complete") return;
    for (const m of d.members) {
      const stack = hand.result!.stacks[m.playerId];
      if (stack !== undefined) m.stack = stack;
      if (m.left) m.seat = null;
    }
    d.handsPlayed = hand.handNo;
  }

  private async autoAct(handNo: number, seq: number): Promise<void> {
    const hand = this.data.hand;
    if (!hand || hand.handNo !== handNo || hand.seq !== seq || hand.toAct === null) return;
    const actor = hand.players.find((p) => p.seat === hand.toAct)!;
    const legal = legalActions(hand, actor.seat)!;
    // Timed-out or disconnected players check when it's free; players who left always fold.
    const left = this.member(actor.playerId)?.left ?? false;
    const action: Action = legal.canCheck && !left ? { type: "check" } : { type: "fold" };
    const presence = this.presence.get(actor.playerId);
    // A connected player who let the clock run out is sat out so the table isn't held up again.
    const timedOut = !left && presence?.connected === true;
    const d = this.draft();
    d.hand = this.applyChecked(hand, actor.playerId, action);
    const dm = d.members.find((m) => m.playerId === actor.playerId);
    if (timedOut && dm) {
      dm.sittingOut = true;
      dm.sitOutAt = d.handsPlayed;
    }
    this.onHandProgress(d);
    try {
      await this.commit(d);
    } catch (err) {
      log.error("auto-action persist failed; will retry", { roomId: this.id, ...errInfo(err) });
      this.turnKey = null;
      this.turnTimer = setTimeout(() => this.background("auto-act", () => this.autoAct(handNo, seq)), 2000);
      return;
    }
    const name = this.member(actor.playerId)?.name ?? "A player";
    if (timedOut)
      this.broadcastNotice({ kind: "info", text: `${name} ran out of time, ${action.type === "check" ? "checked" : "folded"}, and is sitting out.` });
    else if (!left) this.broadcastNotice({ kind: "info", text: `${name} is away and ${action.type === "check" ? "checked" : "folded"}.` });
    this.afterChange();
  }

  // -------------------------------------------------------------------------
  // Hand lifecycle

  private async startNextHand(): Promise<void> {
    clearTimeout(this.nextHandTimer);
    this.nextHandTimer = undefined;
    this.nextHandAt = null;
    if (this.data.status !== "playing") return;
    if (this.data.hand && this.data.hand.street !== "complete") return;
    if (await this.checkSessionEnd()) return;
    if (await this.checkRoundsLimit()) return;

    const d = this.draft();
    const withChips = d.members.filter((m) => !m.left && m.seat !== null && m.stack > 0);
    const eligible = withChips.filter((m) => !m.sittingOut && !this.isAway(m.playerId));
    if (eligible.length < 2) {
      this.waitingFor =
        withChips.length < 2
          ? "Waiting for someone to rebuy…"
          : withChips.some((m) => m.sittingOut)
            ? "Waiting for players to come back…"
            : "Waiting for players to reconnect…";
      this.afterChange();
      return;
    }
    this.waitingFor = null;
    // Moving big blind: positions follow from last hand's (dead small blind / button if needed).
    const last = d.hand;
    const positions = nextBlinds(
      eligible.map((m) => m.seat!),
      last ? { buttonSeat: last.buttonSeat, sbSeat: last.sbSeat, bbSeat: last.bbSeat } : null,
      (seats) => seats[secureRandomInt(seats.length)]!,
    );
    d.buttonSeat = positions.buttonSeat;
    d.shows = {};
    d.hand = startHand({
      handNo: d.handsPlayed + 1,
      config: { smallBlind: d.settings.smallBlind, bigBlind: d.settings.bigBlind },
      buttonSeat: positions.buttonSeat,
      blinds: { sbSeat: positions.sbSeat, bbSeat: positions.bbSeat },
      seats: eligible.map((m) => ({ playerId: m.playerId, seat: m.seat!, stack: m.stack })),
      deck: shuffle(freshDeck()),
      posting: eligible.filter((m) => m.needsPost).map((m) => m.playerId),
    });
    for (const m of eligible) m.needsPost = false;
    this.onHandProgress(d);
    try {
      await this.commit(d);
    } catch (err) {
      log.error("failed to start hand; retrying", { roomId: this.id, ...errInfo(err) });
      this.scheduleNextHand(3000);
      return;
    }
    this.afterChange();
  }

  /** Ends the session if it can no longer continue. Returns true if it ended. */
  private async checkSessionEnd(): Promise<boolean> {
    if (this.data.status !== "playing") return false;
    if (this.data.hand && this.data.hand.street !== "complete") return false;
    const withChips = this.data.members.filter((m) => !m.left && m.seat !== null && m.stack > 0);
    if (!this.data.endRequested && withChips.length >= 2) return false;
    // With rebuys on, a busted player still at the table can buy back in; the host can end it.
    const canRebuy = this.data.settings.rebuys && this.data.members.some((m) => !m.left && m.seat !== null && m.stack === 0);
    if (!this.data.endRequested && canRebuy) return false;
    const d = this.draft();
    await this.finish(d);
    this.afterChange();
    return true;
  }

  /**
   * Handles the end of the agreed number of rounds. After the final round there is a short
   * window to call an extension vote; while a vote is open the table waits for it.
   * Returns true when no new hand should be dealt now.
   */
  private async checkRoundsLimit(): Promise<boolean> {
    const limit = roundsTotal(this.data);
    if (limit === null || this.data.handsPlayed < limit) {
      this.finalWindowUntil = null;
      return false;
    }
    if (this.data.vote) {
      this.waitingFor = "Waiting for the extension vote…";
      this.afterChange();
      return true;
    }
    if (this.finalWindowFor !== limit) {
      this.finalWindowFor = limit;
      this.finalWindowUntil = Date.now() + this.config.finalVoteWindowMs;
      this.waitingFor = "That was the final round.";
      this.scheduleNextHand(this.config.finalVoteWindowMs);
      this.afterChange();
      return true;
    }
    this.finalWindowUntil = null;
    await this.finish(this.draft());
    this.afterChange();
    return true;
  }

  private async finish(d: RoomData): Promise<void> {
    d.status = "finished";
    d.endRequested = false;
    d.vote = null;
    clearTimeout(this.voteTimer);
    this.finalWindowUntil = null;
    await this.commit(d);
    clearTimeout(this.turnTimer);
    clearTimeout(this.nextHandTimer);
    this.nextHandAt = null;
    this.turnDeadline = null;
    this.waitingFor = null;
    this.onFinished(this);
  }

  private scheduleNextHand(delay: number): void {
    clearTimeout(this.nextHandTimer);
    this.nextHandAt = Date.now() + delay;
    this.nextHandTimer = setTimeout(() => this.background("next-hand", () => this.startNextHand()), delay);
  }

  /** If play is paused waiting for players, try again (e.g. after a reconnect or rebuy). */
  private maybeResume(): void {
    if (this.data.status === "playing" && this.waitingFor && !this.nextHandTimer) this.scheduleNextHand(1500);
  }

  // -------------------------------------------------------------------------
  // Table extras: rebuys, sitting out, showing cards, chat

  rebuy(playerId: string): Promise<Ack> {
    return this.request("rebuy", playerId, async () => {
      const d = this.draft();
      const m = d.members.find((x) => x.playerId === playerId);
      if (!m || m.seat === null || m.left) throw new RoomError("not_seated", "Take a seat first.");
      if (d.status !== "playing") throw new RoomError("wrong_state", "Rebuys are available once the game is running.");
      if (!d.settings.rebuys) throw new RoomError("bad_request", "Rebuys are turned off at this table.");
      if (m.stack > 0) throw new RoomError("bad_request", "You can rebuy once you're out of chips.");
      const inLiveHand = d.hand && d.hand.street !== "complete" && d.hand.players.some((p) => p.playerId === playerId);
      if (inLiveHand) throw new RoomError("wrong_state", "Wait for this hand to finish.");
      m.stack = d.settings.startingStack;
      m.buyIn += d.settings.startingStack;
      m.sittingOut = false;
      await this.commit(d);
      this.broadcastNotice({ kind: "info", text: `${m.name} rebought for ${d.settings.startingStack.toLocaleString("en-US")}.` });
      this.afterChange();
      this.maybeResume();
      return { ok: true };
    });
  }

  setSitOut(playerId: string, { sitOut }: ClientPayload<"room:sitout">): Promise<Ack> {
    return this.request("sitout", playerId, async () => {
      const d = this.draft();
      const m = d.members.find((x) => x.playerId === playerId);
      if (!m || m.seat === null || m.left) throw new RoomError("not_seated", "Take a seat first.");
      if (d.status !== "playing") throw new RoomError("wrong_state", "The game hasn't started.");
      if (Boolean(m.sittingOut) === sitOut) return { ok: true };
      m.sittingOut = sitOut;
      if (sitOut) m.sitOutAt = d.handsPlayed;
      // Coming back after missing hands costs a big blind, like a late arrival.
      else if (d.handsPlayed > (m.sitOutAt ?? d.handsPlayed)) m.needsPost = true;
      await this.commit(d);
      this.afterChange();
      if (!sitOut) this.maybeResume();
      return { ok: true };
    });
  }

  show(playerId: string, { handNo }: ClientPayload<"game:show">): Promise<Ack> {
    return this.request("show", playerId, async () => {
      const d = this.draft();
      const hand = d.hand;
      if (!hand || hand.handNo !== handNo || hand.street !== "complete") throw new RoomError("wrong_state", "That hand is no longer on the table.");
      const p = hand.players.find((x) => x.playerId === playerId);
      if (!p) throw new RoomError("not_seated", "You weren't dealt into that hand.");
      if (hand.result!.shown.some((x) => x.playerId === playerId) || d.shows?.[playerId]) return { ok: true };
      d.shows = { ...d.shows, [playerId]: p.hole.slice() };
      await this.commit(d, null, (q) => Store.recordShow(q, d.id, handNo, playerId, p.hole));
      const name = d.members.find((x) => x.playerId === playerId)?.name ?? "A player";
      this.notifyOthers(playerId, { kind: "info", text: `${name} shows their cards.` });
      this.afterChange();
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------
  // Extension votes: every player at the table must agree

  startVote(playerId: string, { add }: ClientPayload<"room:vote-start">): Promise<Ack> {
    return this.request("vote-start", playerId, async () => {
      const d = this.draft();
      const m = d.members.find((x) => x.playerId === playerId);
      if (!m || m.seat === null || m.left) throw new RoomError("not_seated", "Only players at the table can vote.");
      if (d.status !== "playing") throw new RoomError("wrong_state", "The match isn't running.");
      if (roundsTotal(d) === null) throw new RoomError("bad_request", "This match has no round limit.");
      if (d.vote) throw new RoomError("wrong_state", "A vote is already open.");
      if (d.endRequested) throw new RoomError("wrong_state", "The host has ended the match.");
      const voters = d.members.filter((x) => x.seat !== null && !x.left && !this.isAway(x.playerId)).map((x) => x.playerId);
      d.vote = { id: Date.now(), proposerId: playerId, add, voters, yes: [playerId], deadline: Date.now() + this.config.voteMs };
      const outcome = this.voteOutcome(d);
      if (outcome === "passed") this.applyExtension(d);
      await this.commit(d);
      if (outcome === "passed") this.announceVote("passed", d, add);
      else this.notifyOthers(playerId, { kind: "info", text: `${m.name} wants to play ${add} more rounds. Everyone has to agree.` });
      this.armVoteTimer();
      this.afterChange();
      if (outcome === "passed") this.resumeAfterVote();
      return { ok: true };
    });
  }

  castVote(playerId: string, { id, yes }: ClientPayload<"room:vote">): Promise<Ack> {
    return this.request("vote", playerId, async () => {
      const d = this.draft();
      const vote = d.vote;
      if (!vote || vote.id !== id) throw new RoomError("stale", "That vote is over.");
      if (!vote.voters.includes(playerId)) throw new RoomError("not_member", "You're not part of this vote.");
      const add = vote.add;
      let outcome: "passed" | "failed" | null;
      if (!yes) {
        d.vote = null;
        outcome = "failed";
      } else {
        if (!vote.yes.includes(playerId)) vote.yes.push(playerId);
        outcome = this.voteOutcome(d);
        if (outcome === "passed") this.applyExtension(d);
      }
      await this.commit(d);
      if (outcome) this.announceVote(outcome, d, add, yes ? undefined : playerId);
      this.armVoteTimer();
      this.afterChange();
      if (outcome) this.resumeAfterVote();
      return { ok: true };
    });
  }

  private voteOutcome(d: RoomData): "passed" | null {
    const v = d.vote!;
    return v.voters.every((id) => v.yes.includes(id)) ? "passed" : null;
  }

  private applyExtension(d: RoomData): void {
    d.extraRounds = (d.extraRounds ?? 0) + d.vote!.add;
    d.vote = null;
  }

  /** Removes a voter who left; the vote may now be complete. */
  private dropVoter(d: RoomData, playerId: string): "passed" | null {
    const v = d.vote!;
    v.voters = v.voters.filter((id) => id !== playerId);
    v.yes = v.yes.filter((id) => id !== playerId);
    if (v.voters.length === 0) {
      d.vote = null;
      return null;
    }
    const outcome = this.voteOutcome(d);
    if (outcome === "passed") this.applyExtension(d);
    return outcome;
  }

  private announceVote(outcome: "passed" | "failed", d: RoomData, add?: number, noVoter?: string) {
    if (outcome === "passed") {
      this.broadcastNotice({ kind: "info", text: `Everyone agreed — ${add ?? ""} more rounds. Now playing to ${roundsTotal(d)}.` });
    } else {
      const who = noVoter ? (d.members.find((m) => m.playerId === noVoter)?.name ?? "Someone") : null;
      this.broadcastNotice({ kind: "info", text: who ? `${who} voted no — the match length stays at ${roundsTotal(d)}.` : "The vote ran out of time — no extension." });
    }
  }

  private armVoteTimer(): void {
    clearTimeout(this.voteTimer);
    const vote = this.data.vote;
    if (!vote) return;
    this.voteTimer = setTimeout(
      () =>
        this.background("vote-expired", async () => {
          if (this.data.vote?.id !== vote.id) return;
          const d = this.draft();
          d.vote = null;
          await this.commit(d);
          this.announceVote("failed", d);
          this.afterChange();
          this.resumeAfterVote();
        }),
      Math.max(0, vote.deadline - Date.now()),
    );
  }

  /** After a vote resolves, continue: deal on if rounds were added, or wrap up the match. */
  private resumeAfterVote(): void {
    if (this.data.status !== "playing") return;
    const hand = this.data.hand;
    if (hand && hand.street !== "complete") return;
    const limit = roundsTotal(this.data);
    const atEnd = limit !== null && this.data.handsPlayed >= limit;
    if (atEnd) {
      // The vote failed at (or after) the final round: finish now.
      this.finalWindowFor = limit;
      this.scheduleNextHand(1500);
    } else if (this.waitingFor || this.finalWindowUntil) {
      this.waitingFor = null;
      this.finalWindowUntil = null;
      this.scheduleNextHand(1500);
    }
  }

  chat(playerId: string, text: string): Ack {
    const m = this.member(playerId);
    if (!m) return fail("not_member", "Join the table to chat.");
    const message: ChatMessage = { id: ++this.chatId, playerId, name: m.name, text, at: Date.now() };
    this.chatLog.push(message);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
    for (const client of this.clients.values()) client.send("room:chat", message);
    this.store.saveChat(this.id, message).catch((err) => log.warn("chat not saved", { roomId: this.id, ...errInfo(err) }));
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Timers and broadcasting

  /** Re-arms timers for the current state and pushes fresh views to every client. */
  private afterChange(): void {
    if (this.disposed) return;
    this.armTurnTimer();
    const hand = this.data.hand;
    if (this.data.status === "playing" && hand?.street === "complete" && !this.nextHandTimer && !this.waitingFor) {
      // Leave time for clients to reveal an all-in runout street by street, or read a showdown.
      const runout = hand.result?.equity?.length ? this.config.runoutPauseMs : hand.result?.endedBy === "showdown" ? this.config.showdownPauseMs : 0;
      this.scheduleNextHand(this.config.handPauseMs + runout);
    }
    this.broadcast();
  }

  private armTurnTimer(): void {
    const hand = this.data.hand;
    if (this.data.status !== "playing" || !hand || hand.toAct === null) {
      clearTimeout(this.turnTimer);
      this.turnKey = null;
      this.turnDeadline = null;
      return;
    }
    const key = `${hand.handNo}:${hand.seq}`;
    const actor = hand.players.find((p) => p.seat === hand.toAct)!;
    const member = this.member(actor.playerId);
    const presence = this.presence.get(actor.playerId);
    const now = Date.now();
    if (key !== this.turnKey) {
      this.turnKey = key;
      this.turnDeadline = this.data.settings.turnSeconds > 0 ? now + this.data.settings.turnSeconds * 1000 : null;
    }
    // Disconnected players keep their clock until the grace period expires; players who are
    // away or have left are checked/folded almost immediately.
    let fireAt = this.turnDeadline ?? Infinity;
    if (member?.left || presence?.away) fireAt = Math.min(fireAt, now + AUTO_ACT_DELAY_MS);
    else if (presence && !presence.connected) fireAt = Math.min(fireAt, Math.max(now, presence.since + this.config.reconnectGraceMs));
    clearTimeout(this.turnTimer);
    if (fireAt === Infinity) return;
    const { handNo, seq } = hand;
    this.turnTimer = setTimeout(() => this.background("auto-act", () => this.autoAct(handNo, seq)), Math.max(0, fireAt - now));
  }

  private broadcast(): void {
    for (const [playerId, client] of this.clients) client.send("room:state", buildRoomView(this, playerId));
  }

  private broadcastNotice(notice: { kind: "info" | "warn"; text: string }): void {
    for (const client of this.clients.values()) client.send("room:notice", notice);
  }

  private notifyOthers(playerId: string, notice: { kind: "info" | "warn"; text: string }): void {
    for (const [id, client] of this.clients) if (id !== playerId) client.send("room:notice", notice);
  }

  /** Waits for all queued operations (used by tests and shutdown). */
  idle(): Promise<void> {
    return this.queue.then(() => {});
  }
}
