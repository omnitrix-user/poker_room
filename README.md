# RiverRoom

DEMO VIDEO LINK : https://drive.google.com/drive/folders/1Te4_5L3nDgTQ4HjpSTNB8FbDw5OE6viP?q=sharedwith:public%20parent:1Te4_5L3nDgTQ4HjpSTNB8FbDw5OE6viP

**Your friends. Your table. Your game.**

A private, browser-based Texas Hold'em club. Open a table, send friends the link or 8-character code, and play no-limit hold'em in real time. Stakes are shown in **play-money rupees (₹, Indian digit grouping)** — RiverRoom never takes deposits, makes payments or cash-outs, or awards prizes; nothing in the app has real monetary value.

## What's in it

- **Accounts or guests**: play instantly as a guest, or create an account (username + password) so your games, history and stats follow you to any device. A guest who creates an account keeps everything they've played. Passwords are stored only as salted scrypt hashes; logins are rate-limited; changing your password signs out your other devices.
- **Personal stats** from recorded hands: hands played, hands and showdowns won, net profit/loss, sessions, biggest pot won, and best hand shown.
- **Private rooms** with unguessable invite codes, 2–8 seats, a waiting room with seat choice and ready states, host-only settings and start.
- **Matches with a set length**: the host picks the number of rounds (one round = one hand dealt; 10–100). The top bar shows "Round 7 / 20". Anyone can propose playing more rounds (+5/+10/+20); it happens **only if every player at the table votes yes** — a single "no" or a 45-second timeout cancels it. After the final round there's a 20-second window to call that vote before the match ends.
- **Final leaderboard** at the end of every match, ordered from biggest profit to biggest loss, with buy-ins, final stacks and profit/loss in ₹. The same leaderboard is kept in History.
- **Complete no-limit hold'em**: correct blinds and heads-up order, min-bet/min-raise, short all-ins that do or don't reopen betting, side pots, uncalled bets, split pots with a documented odd-chip rule, all-in runouts.
- **Server-authoritative real-time play** over Socket.IO: per-player views (no one ever receives another player's hidden cards), serialized per-room processing, idempotent and stale-safe actions, turn clock, 30-second reconnection grace.
- **Persistence**: hands, ordered actions, results, and standings in Postgres; live games survive a server restart.
- **History and stats** from recorded data: sessions, standings, hand-by-hand timelines, hands/showdowns won, net virtual chips.
- **A 2D table that works on desktop and phones**: real card and chip components, a dedicated portrait layout, keyboard shortcuts (F fold, C check/call, R raise amount), reduced-motion support, screen-reader announcements.
- **Made to be fun with friends**:
  - All-in runouts are dealt street by street with live **equity percentages** on each player (exact on the flop/turn, seeded Monte Carlo pre-flop) — nothing is spoiled before the river lands.
  - **Action tags** on every seat ("Raise 120", "Call 40", "All-in 2,000"), hand names at showdown, chips that **slide into the pot** and out to the winner.
  - **Table chat** with speech bubbles over seats and one-tap reactions, plus an unread badge.
  - **Show your cards** after winning uncontested (or after folding) to prove the bluff.
  - **Pre-action buttons**: Check/Fold, Check, Call X, Call any — sent automatically when your turn arrives if still valid.
  - **Rebuys** (host setting), **sit out / I'm back**, and automatic sit-out after letting the clock run out so nobody holds up the table.
  - Optional synthesized **sounds** (off by default) and a "● Your turn" tab-title alert.
  - Live **standings** tab with net results and rebuy counts.
- **Proper blind rotation** ("moving big blind"): the big blind always moves to the next player, so nobody skips it or pays it twice when people bust or leave — with a dead small blind or dead button when needed. New and returning players post a big blind to come in.
- **Real showdown etiquette**: the called aggressor shows first, winners and all-in players are shown, beaten hands are mucked — and mucked cards never leave the server.
- **Move to another device** with a single-use, 15-minute link.

## Requirements

- Node.js **22.12+** (developed on 24.8) and npm 10+.
- Nothing else for local development — an embedded Postgres (PGlite) is used when `DATABASE_URL` isn't set.
- For production: a Postgres database (recommended) or a persistent volume for the embedded one.

## Open it in your IDE

Open this folder in VS Code (or any editor). It's an npm workspaces monorepo: `packages/engine` (poker rules), `packages/protocol` (shared types), `apps/server` (game server), `apps/web` (React app). Use Node 22+ (`.nvmrc` is included for nvm users).

## Quick start

```bash
npm install
```

```bash
npm run dev
```

This starts the game server on `:3001` and the web app on `:5173` (override with `API_PORT` / `PORT`). Open http://localhost:5173, pick a name, open a table, and open the invite link in a **different browser or a private window** to join as a second player (tabs in the same browser share one identity).

Local data lives in `.data/` (git-ignored). Delete it to start fresh.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Server (watch mode) + Vite dev server with proxying. |
| `npm test` | Engine + server test suites (Vitest). |
| `npm run test:e2e` | Browser end-to-end tests (Playwright) against the production build. Run `npm run build` first. |
| `npm run test:postgres` | The server suite against a real Postgres server: set `TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres` (a fresh database is created per test). |
| `npm run typecheck` | Strict TypeScript across all packages. |
| `npm run build` | Typecheck, build the web app (`apps/web/dist`) and bundle the server (`apps/server/dist/server.js`). |
| `npm start` | Run the production build (`NODE_ENV=production`; requires `APP_SECRET`). |
| `npm run serve` | Run the production build in development mode (no secret required) — handy for a quick local check. |

Playwright needs a Chromium: `npx playwright install chromium`, or point at an existing one with `CHROMIUM_PATH=/path/to/chrome npm run test:e2e`.

## Configuration

See [`.env.example`](.env.example). The important ones:

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_SECRET` | — | **Required in production.** ≥32 characters. Encrypts live-game snapshots and stored hole cards. Changing it makes in-progress games unrecoverable. |
| `DATABASE_URL` | unset | Postgres connection string. Unset → embedded Postgres in `DATA_DIR`. Add `?sslmode=require` for TLS. |
| `DATA_DIR` | `.data/pglite` | Embedded database directory (only without `DATABASE_URL`). Must be on persistent storage. |
| `PORT` | `3001` | HTTP + WebSocket port. |
| `RECONNECT_GRACE_SECONDS` | `30` | How long a disconnected player keeps their turn. |
| `HAND_PAUSE_MS` | `5000` | Pause between hands. |
| `RUNOUT_PAUSE_MS` | `6000` | Extra pause after an all-in runout so clients can reveal it street by street. |
| `SHOWDOWN_PAUSE_MS` | `2500` | Extra pause after a regular showdown. |
| `FINAL_VOTE_SECONDS` | `20` | After the final round, how long players have to propose an extension. |
| `VOTE_SECONDS` | `45` | How long an extension vote stays open. |
| `TRUST_PROXY` | `0` | Set `1` behind a reverse proxy so rate limits see client IPs. |
| `ALLOWED_ORIGINS` | — | Extra origins allowed to open sockets; only for split hosting. |
| `PG_POOL_MAX` | `10` | Postgres pool size. |

## Database

Migrations live in `apps/server/src/migrations.ts` and run automatically at startup (append-only, tracked in `schema_migrations`). There is no separate migrate step. To use Postgres:

```bash
DATABASE_URL=postgres://user:pass@host:5432/riverroom APP_SECRET=... npm start
```

## Deploying

RiverRoom is one long-running Node process that serves the API, the WebSocket endpoint, and the built web app from the same origin. It needs a host that supports persistent processes and WebSockets (Render, Railway, Fly.io, a VPS…), not a serverless function platform.

1. `npm ci && npm run build`
2. Set `NODE_ENV=production`, `APP_SECRET`, and `DATABASE_URL` (or a volume-backed `DATA_DIR`).
3. `npm start` (or `node apps/server/dist/server.js`). Health check: `GET /api/health`.
4. Serve it over HTTPS (the session cookie is `Secure` in production). Set `TRUST_PROXY=1` behind a proxy.

Run **one instance**. Room state lives in that process; multiple instances would each think they own a room.

A `Dockerfile` is included (build → slim runtime, data volume at `/data`). It has been built and run: the image served the app in production mode against a PostgreSQL 15 container, and the full browser E2E suite passed against it:

```bash
docker build -t riverroom .
```

```bash
docker run -p 3001:3001 -e APP_SECRET=... -e DATABASE_URL=postgres://... riverroom
```

To run the browser tests against any running deployment: `E2E_BASE_URL=http://localhost:3001 npm run test:e2e`.

**Deployment status:** not deployed. No hosting credentials or infrastructure were provided, so there is no public URL.

## Project layout

```
packages/engine     pure poker engine (no I/O) + tests
packages/protocol   zod schemas for client payloads, view types
apps/server         Express + Socket.IO, room actors, persistence + tests
apps/web            React + Vite client
tests/e2e           Playwright browser tests
docs/               ARCHITECTURE.md (decisions and rationale), BUILD_PLAN.md
```

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the write path, hidden-information model, house rules, and where/why this deviates from the original proposal.

## Testing evidence

At the time of writing, on macOS with Node 24.8:

- `npm test` — 11 files, **120 tests passing** (77 engine, 43 server). The 43 server tests also pass against a real PostgreSQL 15 server (`npm run test:postgres`). Includes a seeded fuzzer playing thousands of random 2–8 player hands with invariant checks after every action, and server tests using real Socket.IO clients with separate identities.
- `npm run test:e2e` — **3 tests passing** (also against the Docker container + Postgres): a full 10-round match where an extension vote is refused and both players see a zero-sum leaderboard ordered by profit, plus in headless Chromium: two isolated browser contexts (one phone-sized) create/join/ready/start, play a full hand, compare results, send a chat reaction that appears as a bubble on the other screen, reload and reconnect, inspect persisted history, and move an identity to a third browser with a one-time link (which then refuses reuse).
- `npm run build` — passes (strict typecheck, web build, server bundle).
- Production mode checked by hand: refuses to start without `APP_SECRET`; serves the SPA and assets; cookie is `HttpOnly; Secure; SameSite=Lax`.

## Known limitations

- **No password recovery by email.** Accounts use a username and password only (no email is collected), so a forgotten password can't be reset. Guests who never create an account lose their identity if their browser's cookies are cleared.
- **Single process, in-memory room actors and rate limits.** No horizontal scaling (not needed for friends' tables).
- **Not included:** straddles, run-it-twice, time banks.
- **Extension votes** need every seated player who is present; a player whose connection has been gone past the grace period isn't asked (and so can't block it).
- **Postgres verification:** the default suite uses PGlite (Postgres 18 in WASM); the full server suite has also been run against a real **PostgreSQL 15** server (`npm run test:postgres`, all passing).
- **E2E browser:** run here with a locally cached Chromium (via `CHROMIUM_PATH`) rather than Playwright's pinned build.
- **Not included:** animated full-hand replay in history, friend lists, tournaments, richer analytics.
- Client bundle is ~126 KB gzipped JS (React + Socket.IO + Zod for shared validation).
