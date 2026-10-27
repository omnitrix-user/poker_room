/** Ordered, append-only schema migrations. Never edit a migration that has shipped. */
export const MIGRATIONS: string[] = [
  `
CREATE TABLE players (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  host_id text NOT NULL REFERENCES players(id),
  settings jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('lobby', 'playing', 'finished')),
  hands_played integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz
);

CREATE TABLE room_members (
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id),
  seat integer,
  buy_in integer NOT NULL DEFAULT 0,
  stack integer NOT NULL DEFAULT 0 CHECK (stack >= 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, player_id)
);

CREATE INDEX room_members_player ON room_members (player_id);

-- Encrypted authoritative state of a live room (includes the undealt deck).
CREATE TABLE room_snapshots (
  room_id text PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  version bigint NOT NULL,
  data text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hands (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  hand_no integer NOT NULL,
  button_seat integer NOT NULL,
  small_blind integer NOT NULL,
  big_blind integer NOT NULL,
  board jsonb NOT NULL DEFAULT '[]',
  pot_total integer NOT NULL DEFAULT 0,
  result jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (room_id, hand_no)
);

-- Ordered public events of a hand: blinds, actions, and board deals.
CREATE TABLE hand_events (
  hand_id text NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  payload jsonb NOT NULL,
  client_action_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hand_id, seq)
);

CREATE UNIQUE INDEX hand_events_client_action ON hand_events (client_action_id) WHERE client_action_id IS NOT NULL;

CREATE TABLE hand_players (
  hand_id text NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES players(id),
  seat integer NOT NULL,
  start_stack integer NOT NULL,
  end_stack integer,
  won integer NOT NULL DEFAULT 0,
  -- Hole cards only when shown at showdown; never the unrevealed cards.
  shown jsonb,
  -- The player's own hole cards, encrypted with the server secret; returned only to that player.
  hole_enc text,
  reached_showdown boolean NOT NULL DEFAULT false,
  PRIMARY KEY (hand_id, player_id)
);

CREATE INDEX hand_players_player ON hand_players (player_id);
`,
  `
-- One-time links that let a player continue their identity on another device.
CREATE TABLE login_links (
  token_hash text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
`,
  `
-- Table chat, so it survives restarts and shows up in history.
CREATE TABLE chat_messages (
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  id integer NOT NULL,
  player_id text NOT NULL REFERENCES players(id),
  name text NOT NULL,
  text text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, id)
);

-- Match length including agreed extensions (NULL for matches without a limit).
ALTER TABLE rooms ADD COLUMN rounds_total integer;
`,
];
