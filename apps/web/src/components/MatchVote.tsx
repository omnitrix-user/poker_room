import { useEffect, useState } from "react";
import { EXTEND_OPTIONS, type Ack, type ClientEventName, type RoomView } from "@riverroom/protocol";

type Request = (event: ClientEventName, payload?: object) => Promise<Ack>;

function useSecondsLeft(until: number | null, offset: number): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!until) return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - Date.now() - offset) / 1000)) : null;
}

/** "Round 7 / 20" for the top bar. */
export function RoundCounter({ view }: { view: RoomView }) {
  const total = view.roundsTotal;
  const g = view.game;
  if (view.status !== "playing" || !g) return null;
  const final = total !== null && g.handNo >= total;
  return (
    <span className="round-counter num">
      Round {g.handNo}
      {total !== null && <span className="faint"> / {total}</span>}
      {final && <span className="pill final">Final round</span>}
    </span>
  );
}

/** Lets anyone at the table propose playing more rounds. */
export function ExtendMenu({ view, request }: { view: RoomView; request: Request }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seated = view.players.some((p) => p.playerId === view.you.playerId && !p.left);
  if (view.status !== "playing" || view.roundsTotal === null || view.vote || !seated || view.endRequested) return null;
  return (
    <span className="extend">
      <button type="button" className={`btn btn-ghost btn-sm ${open ? "on" : ""}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Extend
      </button>
      {open && (
        <div className="extend-menu panel" role="menu">
          <p className="small muted">Play more rounds? Everyone at the table has to agree.</p>
          <div className="row-start">
            {EXTEND_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                role="menuitem"
                className="btn btn-sm"
                onClick={async () => {
                  const ack = await request("room:vote-start", { add: n });
                  if (ack.ok) setOpen(false);
                  else setError(ack.message);
                }}
              >
                +{n} rounds
              </button>
            ))}
          </div>
          {error && <p className="error-text small">{error}</p>}
        </div>
      )}
    </span>
  );
}

/** The open vote, or the chance to call one right after the final round. */
export function MatchVote({ view, request, clockOffset }: { view: RoomView; request: Request; clockOffset: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vote = view.vote;
  const secs = useSecondsLeft(vote?.deadline ?? view.finalWindowUntil, clockOffset);
  const name = (id: string) => view.players.find((p) => p.playerId === id)?.name ?? "A player";
  const me = view.you.playerId;
  const seated = view.players.some((p) => p.playerId === me && !p.left);

  async function run(event: ClientEventName, payload: object) {
    setBusy(true);
    setError(null);
    const ack = await request(event, payload);
    setBusy(false);
    if (!ack.ok) setError(ack.message);
  }

  if (view.status !== "playing") return null;

  if (vote) {
    const pending = vote.voters.filter((id) => !vote.yes.includes(id));
    const mustAnswer = vote.voters.includes(me) && !vote.yes.includes(me);
    return (
      <div className="match-vote panel" role="dialog" aria-labelledby="vote-title">
        <div className="vote-head">
          <h2 id="vote-title" className="panel-title">
            {vote.proposerId === me ? "You" : name(vote.proposerId)} {vote.proposerId === me ? "want" : "wants"} {vote.add} more rounds
          </h2>
          {secs !== null && <span className="faint num">{secs}s</span>}
        </div>
        <p className="small muted">
          Playing to {(view.roundsTotal ?? 0) + vote.add} instead of {view.roundsTotal}. It only happens if everyone agrees.
        </p>
        <ul className="vote-tally">
          {vote.voters.map((id) => (
            <li key={id} className={vote.yes.includes(id) ? "yes" : ""}>
              <span className="tick" aria-hidden="true" />
              {id === me ? "You" : name(id)}
              <span className="faint small">{vote.yes.includes(id) ? "agreed" : "deciding"}</span>
            </li>
          ))}
        </ul>
        {mustAnswer ? (
          <div className="row-end">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run("room:vote", { id: vote.id, yes: false })}>
              No, finish on time
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run("room:vote", { id: vote.id, yes: true })}>
              Yes, keep playing
            </button>
          </div>
        ) : (
          <p className="small faint">Waiting for {pending.map((id) => (id === me ? "you" : name(id))).join(", ")}…</p>
        )}
        {error && <p className="error-text small">{error}</p>}
      </div>
    );
  }

  if (view.finalWindowUntil && seated) {
    return (
      <div className="match-vote panel" role="dialog" aria-labelledby="final-title">
        <div className="vote-head">
          <h2 id="final-title" className="panel-title">
            That was the final round
          </h2>
          {secs !== null && <span className="faint num">{secs}s</span>}
        </div>
        <p className="small muted">Want to keep playing? Propose more rounds — everyone has to agree. Otherwise the match ends and the leaderboard is final.</p>
        <div className="row-end">
          {EXTEND_OPTIONS.map((n) => (
            <button key={n} type="button" className="btn btn-sm" disabled={busy} onClick={() => run("room:vote-start", { add: n })}>
              +{n} rounds
            </button>
          ))}
        </div>
        {error && <p className="error-text small">{error}</p>}
      </div>
    );
  }
  return null;
}
