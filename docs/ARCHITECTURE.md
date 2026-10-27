# RiverRoom architecture

## Shape of the system

```
browser (React)  ──HTTP──▶  Express  ──▶  Store ──▶ Postgres (pg)  or  embedded Postgres (PGlite)
       │                       │
       └──Socket.IO (cookie)──▶ RoomManager ──▶ Room actor (one per live room)
                                                   │  serialized queue
                                                   ▼
                                           @riverroom/engine (pure)
```

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `packages/engine` | Cards, CSPRNG shuffle, 7-card evaluator, betting state machine, side pots, settlement, invariants. Pure functions, no I/O. | nothing |
| `packages/protocol` | Zod schemas for every client payload, typed server views, shared constants. | engine (types), zod |
| `apps/server` | Identity, rooms, the per-room actor, persistence, per-player views, HTTP + Socket.IO. | engine, protocol |
| `apps/web` | Presentation and input. Renders server views; never decides game outcomes. | engine (hand description only), protocol |

One process owns every live room. That is deliberate: a friends' poker app has tiny load, and a single authoritative process removes whole classes of distributed-state bugs.

## The authoritative write path

Every mutation of a room — a player action, a timer firing, a join, a seat change — runs through that room's **serialized queue** (a promise chain). Within the queue:

1. Validate the request against the current state (membership, seat, turn, `handNo`/`seq` freshness).
2. Compute the next state with the pure engine on a *copy* (`structuredClone`); the live state is untouched.
3. Check the engine's invariants on the result (chip conservation, no duplicate cards, valid actor, …). A violation refuses the action instead of persisting a corrupt state.
4. **Commit in one database transaction**: new hand events, hand result rows (if the hand ended), membership/stack rows, and the encrypted room snapshot, guarded by `UPDATE … WHERE version = prev`.
5. Only after the commit succeeds: swap in the new state, re-arm timers, and push a fresh per-player view to every connected client.

Consequences:

- Two simultaneous actions can't interleave; the second sees the first's result and is rejected as stale.
- A failed write leaves the live state exactly as it was; the player sees "Something went wrong saving that" and can retry.
- A transition can't be applied twice: re-committing from an old version fails the version check and the whole transaction rolls back (tested — no duplicate `hand_players` rows, no double settlement).
- After a crash, the snapshot and the hand log agree because they were written together. On boot every unfinished room is restored from its snapshot and play resumes; everyone starts "disconnected" with a fresh grace period.

## Idempotency and staleness

- Each `game:action` carries a client-generated UUID `actionId` plus the `handNo` and `seq` (the hand's action counter) the client was looking at.
- The room keeps the last 256 acknowledgements by `actionId`: a duplicate (e.g. a retry after a lost ack — the client does retry once with the same id) returns the original answer without re-applying.
- `handNo`/`seq` mismatch → `stale`. Staleness is keyed to the hand's own action counter rather than a room-wide version so presence changes (someone reconnecting) never invalidate an in-flight action.

## Hidden information

- The deck and all hole cards live only in server memory and in the **AES-256-GCM-encrypted** snapshot. Each player's own hole cards are also stored encrypted in `hand_players.hole_enc` so the history API can show you *your* cards.
- Views are built per recipient, field by field, from an allowlist (`apps/server/src/views.ts`). The hand state is never serialized wholesale. Other players' hole cards appear only after they are shown at showdown.
- The history API returns only public events, shown cards, and the viewer's own decrypted cards — never the snapshot.
- Tests assert that no payload received by a client contains the opponent's exact holding or the word `deck`; the E2E test asserts the host's cards don't exist anywhere in the guest's DOM.

## Identity

Guest identities backed by a server-issued session: `POST /api/session` creates a player and a 256-bit random token, stores only its SHA-256 hash, and sets an `HttpOnly; SameSite=Lax` (and `Secure` in production) cookie. Sockets authenticate from that cookie during the handshake; the payload never carries a player id. If the same player opens a second tab, the newer tab takes over and the older one is refused for further actions.

This is honest guest identity, not account authentication: clearing cookies loses the identity, and there is no recovery. Swapping in an auth provider would replace `auth.ts` and the session table; nothing else depends on how the player was identified.

## Disconnects and timers

- Grace period: `RECONNECT_GRACE_SECONDS` (default 30). Seat, stack, and cards are preserved; the same session can rejoin and gets the latest view.
- If a disconnected player must act, they keep their turn until the grace period (or the turn clock, whichever is first) runs out, then are **checked if free, otherwise folded**. A player who owes no decision is never folded.
- After the grace period a player is *away*: they're not dealt into new hands until they return. If fewer than two players can be dealt in, the table waits.
- A player who leaves mid-hand is folded when the action reaches them (never checked through), and their stack becomes final.
- Turn clock: 15/30/60 seconds or off, per table. Timers aren't persisted; they're re-armed from scratch on restart.

## Poker rules and house policies

Standard no-limit Texas Hold'em, 2–8 players (the engine supports up to 10).

- Heads-up: the button posts the small blind and acts first pre-flop, last after.
- Minimum bet is the big blind; minimum raise is the size of the last full bet/raise on the street.
- **Short all-in raises** don't reopen betting for players who already acted, unless the total raised since they last acted adds up to a full raise (several short all-ins can combine).
- A big blind posted all-in for less still requires others to call the full big blind; the unmatched part comes back as an uncalled bet.
- Uncalled excess is returned before pots are built. Pots are built from contribution levels of live players; folded chips stay in the pots they entered but folded players are never eligible.
- **Odd chips** in split pots go one at a time to winners in clockwise order starting left of the button.
- Burn cards are dealt.
- **Showdown order:** the last river bettor/raiser (who was called) shows first; with no river bet, the first live player left of the button. Every pot winner and every all-in player is shown; other beaten hands are **mucked** and their cards are never sent to anyone. After an all-in runout every live hand is tabled.
- Players may voluntarily show their cards after a hand (e.g. after winning uncontested); shown cards go into the hand history.
- **Moving big blind** (`packages/engine/src/blinds.ts`): each hand the big blind goes to the next player dealt in after last hand's big blind. Last hand's big blind posts the small blind if still dealt in, otherwise the small blind is dead (not posted). The button moves to last hand's small-blind seat even if it's now empty (dead button; post-flop action starts left of that seat). Heads-up, the button posts the small blind and the big blind alternates, including when a game drops to two players. Covered by unit tests, a 5,000-hand randomized arrival/departure test, and the engine fuzzer.
- **Posting to enter:** a player who joins a running match, or comes back after sitting out for at least one hand, posts a live big blind on their first hand back (unless they're already in a blind). Like any big blind it plays as their bet and keeps the option.
- **Rebuys** (host setting, default on): a busted player at the table can take another starting stack between hands; their buy-in grows accordingly so net results stay honest. With rebuys on, the session stays open while a busted player could still rebuy.
- **Sitting out:** players can sit out and come back; a *connected* player who lets the turn clock expire is checked/folded and sat out automatically.
- The session ends when the host ends it (after the current hand), or when only one player has chips and no one can rebuy.

## Matches, rounds and extension votes

- `settings.rounds` (required for new tables) is the match length; one round is one hand. `roundsTotal = rounds + extraRounds`, stored in the snapshot and on the `rooms` row.
- When the last round completes, the room opens a **final window** (`FINAL_VOTE_SECONDS`) instead of finishing at once; then the match ends and the leaderboard is final.
- An **extension vote** (`room:vote-start` → `room:vote`) lists its voters when it opens: every seated player who hasn't left and isn't away. It passes only when all of them have said yes; one "no", or the deadline (`VOTE_SECONDS`), ends it. Voters who leave are removed (which can complete the vote). The vote lives in the snapshot, so it survives a restart, and its deadline timer is re-armed on boot. While a vote is open at the round limit, no new hand is dealt.
- Leaderboards (end-of-match overlay and History) sort by profit (final stack − total buy-in), highest first.

## Currency

All amounts are integers of play-money rupees. The client renders them as `₹` with Indian digit grouping (`Intl.NumberFormat("en-IN")`); the server and engine only see integers. There is no payment, deposit or cash-out code path anywhere.

## All-in equity and the staged runout

When betting closes with two or more players and cards still to come, the engine records where the runout began and computes each hand's equity at every remaining street: exactly (enumerating all boards) when there are few, otherwise by seeded Monte Carlo (deterministic per hand) using a fast, allocation-free 7-card ranker. The ranker is cross-checked against the readable evaluator on 30,000 random hand pairs.

The server settles the hand instantly — the authoritative state never waits for animation. The client's *runout director* (`apps/web/src/lib/runout.ts`) then **presents** a masked copy of the view: board truncated to the cards revealed so far, later streets removed from the log, payouts and the result withheld. It reveals the flop, turn and river ~1.5 s apart with equity updating on every seat, then shows the real result. Every component (table, log, action bar, announcer, sounds) reads the same presented view, so nothing can leak the outcome early. The server waits `RUNOUT_PAUSE_MS` before dealing the next hand.

## Table extras

- **Chat**: `room:chat` (1–160 chars, whitespace-collapsed, 6 per 10 s per player) is broadcast to members, stored in `chat_messages`, and the last 50 are reloaded after a restart; new connections get `room:chat-history`. React renders it as text, never HTML.
- **Device links**: `POST /api/session/link` creates a 256-bit single-use token (stored hashed, 15-minute expiry); `/link/<token>` claims it, creates a new session for the same player, and removes the token from the address bar.
- **Action dedupe across restarts**: besides the in-memory acknowledgement cache, every action's client id is stored on its `hand_events` row (unique), so a retry that arrives after a restart is recognised as already applied instead of being reported as stale.
- **Same-origin writes**: every non-GET `/api` request with a foreign `Origin` is refused (403), and Socket.IO handshakes from foreign origins are rejected.

## Persistence model

| Table | Purpose |
| --- | --- |
| `players`, `auth_sessions` | Guest identity; session tokens stored hashed. |
| `rooms` | Code, host, settings, status, timestamps, hands played. |
| `room_members` | Seat, buy-in, and stack at the end of the last completed hand → standings and net results. |
| `room_snapshots` | Encrypted authoritative state of unfinished rooms (deleted when a room finishes). |
| `hands` | One row per hand: button, blinds, board, pot, public result. Unique `(room_id, hand_no)`. |
| `hand_events` | Ordered public events (blinds, actions with amounts, board deals). `client_action_id` is unique. |
| `hand_players` | Per-player start/end stack, winnings, shown cards, encrypted own hole cards. |

Statistics are computed from these rows with clear denominators: *hands won* = hands where you took any part of a pot ÷ hands you were dealt; *showdowns won* = showdowns where you won chips ÷ showdowns you reached; net = Σ(stack − buy-in) over sessions where you played.

## Deviations from the original proposal

**1. Database: Postgres in production, embedded Postgres (PGlite) everywhere else.**
Proposed: PostgreSQL. Changed: the same SQL runs on `pg` when `DATABASE_URL` is set and on PGlite (Postgres compiled to WASM, persisted to `DATA_DIR`) otherwise. Why: `npm install && npm run dev` works with zero infrastructure, and tests exercise real Postgres semantics (transactions, `ON CONFLICT`, partial unique indexes) instead of a mock. The `pg` code path is tested over the actual Postgres wire protocol using PGlite's socket server. Trade-off: PGlite is single-connection, so it serializes all queries; that's fine for development and small self-hosted tables, while production should use real Postgres.

**2. Crash-safe snapshot-per-transition instead of "active game snapshots" written separately.**
Proposed: separate entities for snapshots, actions, and results. Kept the entities but bound them together: every transition writes events, results, and the snapshot in one transaction with an optimistic version check. Why: separate writes can diverge after a crash (an action logged but not in the snapshot, or a hand settled twice). Trade-off: each action rewrites the snapshot (a few KB) — negligible at this scale.

**3. One personalized state message instead of many granular events.**
Proposed: `game:state`, `game:hand-complete`, `game:action-rejected`, etc. Changed: clients get `room:state` (the full view for *them*) after every change, plus `room:notice` for human-readable events; every request is acknowledged with `{ ok }` or `{ ok: false, code, message }`. Why: one code path for first load, updates, and reconnection; a client can never apply events out of order or miss one; views are tiny with ≤8 players. Trade-off: slightly more bytes per update than deltas.

**4. Same-origin deployment: the server also serves the built web app.**
Proposed: deploy the frontend and backend separately where suitable. Changed: one deployable. Why: HttpOnly session cookies, SameSite protection, and the Socket.IO handshake all work without CORS or third-party-cookie problems; one URL to share. Trade-off: no CDN for static assets by default (they're fingerprinted and cacheable, so a CDN can sit in front). Split hosting is possible with `ALLOWED_ORIGINS` but needs both on the same site for cookies.

**5. Plain CSS with custom properties instead of Tailwind.**
Proposed: Tailwind plus custom components. Changed: a small set of hand-written stylesheets driven by design tokens. Why: nearly all the UI is bespoke geometry (an oval table, seat positions in table-relative percentages, card proportions from a single width variable, container-query sizing). Utility classes would add a dependency and indirection without helping that. Trade-off: no utility vocabulary for quick one-off layout.

**6. A tiny router and `useSyncExternalStore` stores instead of router/state libraries.**
Four routes and two stores (session, room connection) don't justify extra dependencies.

**7. Separate portrait layout instead of a shrunken landscape table.**
A tall oval leaves no space beside the board, so in portrait opponents sit on the upper and lower parts of the long sides and across the top, keeping the board's row clear. Landscape spaces seats evenly by angle. During play, only occupied seats are laid out, so heads-up players face each other across the table.

## Testing

- Engine (77 tests): every hand category and tie-break; blinds and order including heads-up; min-bet/min-raise; short calls; short all-in raises that don't reopen action and cumulative ones that do; side pots with folded contributors, ties, odd chips, uncalled bets; plus a seeded fuzzer that plays thousands of random hands (2–8 players, uneven stacks, non-contiguous seats) asserting invariants after every action and chip conservation after each hand. Mutating the reopen rule or the pot-eligibility rule makes the suite fail. Showdown/muck rules and equity have their own tests (including known values like a one-outer on the turn = 1/44), and the invariant checker enforces "every live player is shown or mucked, and every winner is shown" across the fuzzer.
- Server (36 tests): real Socket.IO clients with separate identities against an in-process server and an in-memory database: rooms, seats, host rights, privacy, out-of-turn/stale/illegal/duplicate/concurrent actions, reconnection, grace-period auto-fold, superseded tabs, foreign origins, restart recovery mid-hand, failed writes, double-settlement refusal, session end, rebuys, sit-out and clock-timeout sit-out, voluntary show (recorded in history), chat (broadcast, history, limits, membership), dedupe after the ack cache is lost, device links (single use), cross-site write refusal, plus the `pg` driver over the wire protocol.
- Browser E2E (Playwright, 2 tests): two isolated browser contexts (one phone-sized) play a full hand; checks private cards, identical results, chip totals, reload/reconnect, no horizontal overflow, and persisted history.
