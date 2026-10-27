import type { Card } from "@riverroom/engine";
import type {
  ChatMessage,
  HandDetail,
  HandSummary,
  PublicHandEvent,
  PublicHandResult,
  RoomStatus,
  SessionSummary,
  StatsResponse,
} from "@riverroom/protocol";
import type { Db, Queryable } from "./db.ts";
import { roundsTotal, type RoomData } from "./model.ts";
import { decrypt, encrypt, hashToken, newId, newToken } from "./secrets.ts";

export class ConflictError extends Error {}

export class Store {
  constructor(
    readonly db: Db,
    private readonly key: Buffer,
  ) {}

  // -------------------------------------------------------------------------
  // Identity

  async createGuest(name: string): Promise<{ playerId: string; token: string }> {
    const playerId = newId();
    const token = newToken();
    await this.db.tx(async (q) => {
      await q.query(`INSERT INTO players (id, display_name) VALUES ($1, $2)`, [playerId, name]);
      await q.query(`INSERT INTO auth_sessions (token_hash, player_id) VALUES ($1, $2)`, [hashToken(token), playerId]);
    });
    return { playerId, token };
  }

  async renamePlayer(playerId: string, name: string): Promise<void> {
    await this.db.query(`UPDATE players SET display_name = $2 WHERE id = $1`, [playerId, name]);
  }

  async playerForToken(token: string): Promise<{ id: string; name: string } | null> {
    const rows = await this.db.query<{ id: string; name: string }>(
      `UPDATE auth_sessions s SET last_seen_at = now()
         FROM players p
        WHERE s.token_hash = $1 AND p.id = s.player_id
       RETURNING p.id, p.display_name AS name`,
      [hashToken(token)],
    );
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Rooms

  async createRoom(data: RoomData): Promise<void> {
    await this.db.tx(async (q) => {
      await q.query(`INSERT INTO rooms (id, code, host_id, settings, status) VALUES ($1, $2, $3, $4, $5)`, [
        data.id,
        data.code,
        data.hostId,
        JSON.stringify(data.settings),
        data.status,
      ]);
      await this.writeRoom(q, data, null);
    });
  }

  async findRoomByCode(code: string): Promise<{ id: string; status: RoomStatus } | null> {
    const rows = await this.db.query<{ id: string; status: RoomStatus }>(`SELECT id, status FROM rooms WHERE code = $1`, [code]);
    return rows[0] ?? null;
  }

  async loadSnapshot(roomId: string): Promise<RoomData | null> {
    const rows = await this.db.query<{ data: string }>(`SELECT data FROM room_snapshots WHERE room_id = $1`, [roomId]);
    if (!rows[0]) return null;
    return JSON.parse(decrypt(this.key, rows[0].data)) as RoomData;
  }

  async liveRoomIds(): Promise<string[]> {
    const rows = await this.db.query<{ room_id: string }>(
      `SELECT s.room_id FROM room_snapshots s JOIN rooms r ON r.id = s.room_id WHERE r.status <> 'finished'`,
    );
    return rows.map((r) => r.room_id);
  }

  /**
   * Atomically persists a room transition: new hand rows/events/results, membership,
   * and the encrypted snapshot. Fails with ConflictError if the stored snapshot is not
   * at `prev.version`, so a transition can never be applied twice.
   */
  async commit(
    prev: RoomData,
    next: RoomData,
    clientActionId: string | null,
    extra?: (q: Queryable) => Promise<void>,
  ): Promise<void> {
    await this.db.tx(async (q) => {
      await this.writeHand(q, prev, next, clientActionId);
      if (extra) await extra(q);
      await q.query(
        `UPDATE rooms SET host_id = $2, settings = $3, status = $4, hands_played = $5, rounds_total = $6,
                started_at = CASE WHEN $4 <> 'lobby' THEN coalesce(started_at, now()) END,
                ended_at = CASE WHEN $4 = 'finished' THEN coalesce(ended_at, now()) END
          WHERE id = $1`,
        [next.id, next.hostId, JSON.stringify(next.settings), next.status, next.handsPlayed, roundsTotal(next)],
      );
      await this.writeRoom(q, next, prev.version);
    });
  }

  private async writeRoom(q: Queryable, data: RoomData, prevVersion: number | null): Promise<void> {
    const ids = data.members.map((m) => m.playerId);
    await q.query(`DELETE FROM room_members WHERE room_id = $1 AND NOT (player_id = ANY($2::text[]))`, [data.id, ids]);
    for (const m of data.members) {
      await q.query(
        `INSERT INTO room_members (room_id, player_id, seat, buy_in, stack) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (room_id, player_id) DO UPDATE SET seat = $3, buy_in = $4, stack = $5`,
        [data.id, m.playerId, m.seat, m.buyIn, m.stack],
      );
    }
    if (data.status === "finished") {
      await q.query(`DELETE FROM room_snapshots WHERE room_id = $1`, [data.id]);
      return;
    }
    const blob = encrypt(this.key, JSON.stringify(data));
    const rows =
      prevVersion === null
        ? await q.query(`INSERT INTO room_snapshots (room_id, version, data) VALUES ($1, $2, $3) RETURNING room_id`, [
            data.id,
            data.version,
            blob,
          ])
        : await q.query(
            `UPDATE room_snapshots SET version = $2, data = $3, updated_at = now() WHERE room_id = $1 AND version = $4 RETURNING room_id`,
            [data.id, data.version, blob, prevVersion],
          );
    if (rows.length !== 1) throw new ConflictError(`snapshot version conflict for room ${data.id}`);
  }

  private async writeHand(q: Queryable, prev: RoomData, next: RoomData, clientActionId: string | null): Promise<void> {
    const hand = next.hand;
    if (!hand) return;
    const handId = `${next.id}:${hand.handNo}`;
    const isNewHand = prev.hand?.handNo !== hand.handNo;
    if (isNewHand) {
      await q.query(
        `INSERT INTO hands (id, room_id, hand_no, button_seat, small_blind, big_blind) VALUES ($1, $2, $3, $4, $5, $6)`,
        [handId, next.id, hand.handNo, hand.buttonSeat, hand.config.smallBlind, hand.config.bigBlind],
      );
    }
    const from = isNewHand ? 0 : prev.persistedEvents;
    let tagged = false;
    for (let i = from; i < hand.events.length; i++) {
      const ev = hand.events[i]!;
      const tag = !tagged && clientActionId && ev.kind === "action" ? clientActionId : null;
      if (tag) tagged = true;
      await q.query(`INSERT INTO hand_events (hand_id, seq, payload, client_action_id) VALUES ($1, $2, $3, $4)`, [
        handId,
        i,
        JSON.stringify(ev),
        tag,
      ]);
    }
    const justCompleted = hand.result && (isNewHand || prev.hand?.street !== "complete");
    if (justCompleted) {
      const r = hand.result!;
      const potTotal = hand.players.reduce((s, p) => s + p.totalBet, 0) - (r.refund?.amount ?? 0);
      await q.query(`UPDATE hands SET board = $2, pot_total = $3, result = $4, ended_at = now() WHERE id = $1`, [
        handId,
        JSON.stringify(hand.board),
        potTotal,
        JSON.stringify(r),
      ]);
      for (const p of hand.players) {
        const shown = r.shown.find((s) => s.playerId === p.playerId);
        const won = r.pots.reduce((s, pot) => s + (pot.winners.find((w) => w.playerId === p.playerId)?.amount ?? 0), 0);
        await q.query(
          `INSERT INTO hand_players (hand_id, player_id, seat, start_stack, end_stack, won, shown, reached_showdown, hole_enc)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            handId,
            p.playerId,
            p.seat,
            p.startStack,
            p.stack,
            won,
            shown ? JSON.stringify(shown.hole) : null,
            r.endedBy === "showdown" && p.status !== "folded",
            encrypt(this.key, JSON.stringify(p.hole)),
          ],
        );
      }
    }
  }

  async saveChat(roomId: string, m: ChatMessage): Promise<void> {
    await this.db.query(`INSERT INTO chat_messages (room_id, id, player_id, name, text, at) VALUES ($1, $2, $3, $4, $5, $6)`, [
      roomId,
      m.id,
      m.playerId,
      m.name,
      m.text,
      new Date(m.at),
    ]);
  }

  async recentChat(roomId: string, limit: number): Promise<ChatMessage[]> {
    const rows = await this.db.query<{ id: number; player_id: string; name: string; text: string; at: Date }>(
      `SELECT id, player_id, name, text, at FROM chat_messages WHERE room_id = $1 ORDER BY id DESC LIMIT $2`,
      [roomId, limit],
    );
    return rows.reverse().map((r) => ({ id: r.id, playerId: r.player_id, name: r.name, text: r.text, at: new Date(r.at).getTime() }));
  }

  /** Whether an action with this client id was already applied (survives restarts). */
  async actionRecorded(actionId: string): Promise<boolean> {
    const rows = await this.db.query(`SELECT 1 FROM hand_events WHERE client_action_id = $1`, [actionId]);
    return rows.length > 0;
  }

  /** Writes cards a player chose to reveal after the hand into its history. */
  static async recordShow(q: Queryable, roomId: string, handNo: number, playerId: string, cards: Card[]): Promise<void> {
    await q.query(`UPDATE hand_players SET shown = $3 WHERE hand_id = $1 AND player_id = $2`, [
      `${roomId}:${handNo}`,
      playerId,
      JSON.stringify(cards),
    ]);
  }

  /** Creates a single-use, 15-minute link token that signs another device in as this player. */
  async createLoginLink(playerId: string): Promise<string> {
    const token = newToken();
    await this.db.query(`INSERT INTO login_links (token_hash, player_id, expires_at) VALUES ($1, $2, now() + interval '15 minutes')`, [
      hashToken(token),
      playerId,
    ]);
    return token;
  }

  /** Consumes a link token and opens a new session for its player. */
  async claimLoginLink(token: string): Promise<{ player: { id: string; name: string }; token: string } | null> {
    return this.db.tx(async (q) => {
      const rows = await q.query<{ player_id: string; name: string }>(
        `UPDATE login_links l SET used_at = now()
           FROM players p
          WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.expires_at > now() AND p.id = l.player_id
         RETURNING l.player_id, p.display_name AS name`,
        [hashToken(token)],
      );
      const row = rows[0];
      if (!row) return null;
      const session = newToken();
      await q.query(`INSERT INTO auth_sessions (token_hash, player_id) VALUES ($1, $2)`, [hashToken(session), row.player_id]);
      return { player: { id: row.player_id, name: row.name }, token: session };
    });
  }

  // -------------------------------------------------------------------------
  // History and statistics (only public or viewer-owned information)

  async isMember(roomId: string, playerId: string): Promise<boolean> {
    const rows = await this.db.query(`SELECT 1 FROM room_members WHERE room_id = $1 AND player_id = $2`, [roomId, playerId]);
    return rows.length > 0;
  }

  async sessionsFor(playerId: string): Promise<SessionSummary[]> {
    const rooms = await this.db.query<{
      id: string;
      code: string;
      status: RoomStatus;
      created_at: Date;
      ended_at: Date | null;
      hands_played: number;
      rounds_total: number | null;
    }>(
      `SELECT r.id, r.code, r.status, r.created_at, r.ended_at, r.hands_played, r.rounds_total
         FROM rooms r JOIN room_members m ON m.room_id = r.id
        WHERE m.player_id = $1
        ORDER BY r.created_at DESC
        LIMIT 50`,
      [playerId],
    );
    if (rooms.length === 0) return [];
    const members = await this.db.query<{ room_id: string; player_id: string; name: string; buy_in: number; stack: number }>(
      `SELECT m.room_id, m.player_id, p.display_name AS name, m.buy_in, m.stack
         FROM room_members m JOIN players p ON p.id = m.player_id
        WHERE m.room_id = ANY($1::text[])`,
      [rooms.map((r) => r.id)],
    );
    return rooms.map((r) => ({
      roomId: r.id,
      code: r.code,
      status: r.status,
      createdAt: iso(r.created_at)!,
      endedAt: iso(r.ended_at),
      handsPlayed: r.hands_played,
      roundsTotal: r.rounds_total,
      players: members
        .filter((m) => m.room_id === r.id)
        .map((m) => ({ playerId: m.player_id, name: m.name, buyIn: m.buy_in, stack: m.stack, net: m.stack - m.buy_in }))
        .sort((a, b) => b.net - a.net),
    }));
  }

  async handsFor(roomId: string): Promise<HandSummary[]> {
    const rows = await this.db.query<{ hand_no: number; ended_at: Date | null; board: Card[]; pot_total: number; result: PublicHandResult | null }>(
      `SELECT hand_no, ended_at, board, pot_total, result FROM hands WHERE room_id = $1 AND ended_at IS NOT NULL ORDER BY hand_no DESC`,
      [roomId],
    );
    return rows.map((h) => {
      const winners = new Map<string, number>();
      for (const pot of h.result?.pots ?? []) for (const w of pot.winners) winners.set(w.playerId, (winners.get(w.playerId) ?? 0) + w.amount);
      return {
        handNo: h.hand_no,
        endedAt: iso(h.ended_at),
        board: h.board,
        potTotal: h.pot_total,
        winners: [...winners].map(([playerId, amount]) => ({ playerId, amount })),
        winningHand: h.result?.pots[0]?.winningHand ?? null,
      };
    });
  }

  async handDetail(roomId: string, handNo: number, viewerId: string): Promise<HandDetail | null> {
    const hands = await this.db.query<{
      id: string;
      started_at: Date;
      ended_at: Date | null;
      button_seat: number;
      small_blind: number;
      big_blind: number;
      result: PublicHandResult | null;
    }>(`SELECT id, started_at, ended_at, button_seat, small_blind, big_blind, result FROM hands WHERE room_id = $1 AND hand_no = $2`, [
      roomId,
      handNo,
    ]);
    const h = hands[0];
    // Only completed hands are exposed through history.
    if (!h || !h.ended_at) return null;
    const players = await this.db.query<{
      player_id: string;
      name: string;
      seat: number;
      start_stack: number;
      end_stack: number | null;
      shown: Card[] | null;
      hole_enc: string | null;
    }>(
      `SELECT hp.player_id, p.display_name AS name, hp.seat, hp.start_stack, hp.end_stack, hp.shown, hp.hole_enc
         FROM hand_players hp JOIN players p ON p.id = hp.player_id
        WHERE hp.hand_id = $1 ORDER BY hp.seat`,
      [h.id],
    );
    const events = await this.db.query<{ payload: PublicHandEvent }>(`SELECT payload FROM hand_events WHERE hand_id = $1 ORDER BY seq`, [h.id]);
    return {
      handNo,
      roomId,
      startedAt: iso(h.started_at)!,
      endedAt: iso(h.ended_at),
      buttonSeat: h.button_seat,
      smallBlind: h.small_blind,
      bigBlind: h.big_blind,
      players: players.map((p) => ({
        playerId: p.player_id,
        name: p.name,
        seat: p.seat,
        startStack: p.start_stack,
        endStack: p.end_stack,
        shown:
          p.shown ??
          (p.player_id === viewerId && p.hole_enc ? (JSON.parse(decrypt(this.key, p.hole_enc)) as Card[]) : null),
      })),
      events: events.map((e) => e.payload),
      result: h.result,
    };
  }

  async statsFor(playerId: string): Promise<StatsResponse> {
    const [hands] = await this.db.query<{ played: number; won: number; sd: number; sd_won: number }>(
      `SELECT count(*)::int AS played,
              count(*) FILTER (WHERE won > 0)::int AS won,
              count(*) FILTER (WHERE reached_showdown)::int AS sd,
              count(*) FILTER (WHERE reached_showdown AND won > 0)::int AS sd_won
         FROM hand_players WHERE player_id = $1`,
      [playerId],
    );
    const sessions = await this.db.query<{ room_id: string; code: string; created_at: Date; ended_at: Date | null; net: number; hands: number }>(
      `SELECT r.id AS room_id, r.code, r.created_at, r.ended_at, (m.stack - m.buy_in) AS net,
              (SELECT count(*)::int FROM hand_players hp JOIN hands h ON h.id = hp.hand_id
                WHERE h.room_id = r.id AND hp.player_id = $1) AS hands
         FROM room_members m JOIN rooms r ON r.id = m.room_id
        WHERE m.player_id = $1 AND r.status <> 'lobby'
        ORDER BY r.created_at DESC`,
      [playerId],
    );
    const played = sessions.filter((s) => s.hands > 0);
    return {
      handsPlayed: hands?.played ?? 0,
      handsWon: hands?.won ?? 0,
      showdownsReached: hands?.sd ?? 0,
      showdownsWon: hands?.sd_won ?? 0,
      sessions: played.length,
      netChips: played.reduce((s, r) => s + r.net, 0),
      recent: played.slice(0, 10).map((s) => ({
        roomId: s.room_id,
        code: s.code,
        createdAt: iso(s.created_at)!,
        endedAt: iso(s.ended_at),
        net: s.net,
        handsPlayed: s.hands,
      })),
    };
  }
}

function iso(d: Date | string | null): string | null {
  if (d === null) return null;
  return typeof d === "string" ? new Date(d).toISOString() : d.toISOString();
}
