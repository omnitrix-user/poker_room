import { useEffect, useState } from "react";
import type { HandDetail, HandSummary, SessionSummary, StatsResponse } from "@riverroom/protocol";
import { AppBar } from "../components/AppBar.tsx";
import { describeEvent, resultLines } from "../components/HandLog.tsx";
import { NameForm } from "../components/NameForm.tsx";
import { PlayingCard } from "../components/PlayingCard.tsx";
import { api } from "../lib/api.ts";
import { chips, count, relativeDate, signed } from "../lib/format.ts";
import { linkTo } from "../lib/router.ts";
import { useMe } from "../lib/session.ts";

type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T };

function useApi<T>(path: string | null): Load<T> {
  const [res, setRes] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    if (!path) return;
    const ac = new AbortController();
    setRes({ state: "loading" });
    api<T>(path, { signal: ac.signal })
      .then((data) => setRes({ state: "ok", data }))
      .catch((e: Error) => e.name !== "AbortError" && setRes({ state: "error", message: e.message }));
    return () => ac.abort();
  }, [path]);
  return res;
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

function RequireMe({ children }: { children: (id: string) => React.ReactNode }) {
  const s = useMe();
  if (s.status === "loading") return <p className="muted">Loading…</p>;
  if (!s.me)
    return (
      <div className="panel pad narrow">
        <p className="muted">History belongs to a player identity. Choose a name to start one.</p>
        <NameForm />
      </div>
    );
  return <>{children(s.me.id)}</>;
}

export function HistoryPage() {
  return (
    <>
      <AppBar />
      <main className="page">
        <h1>History</h1>
        <RequireMe>{(id) => <HistoryBody playerId={id} />}</RequireMe>
      </main>
    </>
  );
}

function HistoryBody({ playerId }: { playerId: string }) {
  const stats = useApi<StatsResponse>("/api/stats");
  const sessions = useApi<{ sessions: SessionSummary[] }>("/api/history");
  if (stats.state === "error" || sessions.state === "error")
    return <p className="error-text">{stats.state === "error" ? stats.message : (sessions as { message: string }).message}</p>;
  if (stats.state === "loading" || sessions.state === "loading") return <p className="muted">Loading…</p>;
  const s = stats.data;
  const list = sessions.data.sessions;
  if (s.handsPlayed === 0 && list.length === 0) {
    return (
      <div className="empty panel pad">
        <h2 className="panel-title">No hands yet</h2>
        <p className="muted">Once you've played at a table, your sessions and hands show up here.</p>
        <a className="btn btn-primary" {...linkTo("/")}>
          Open a table
        </a>
      </div>
    );
  }
  return (
    <>
      <dl className="stats">
        <div>
          <dt>Hands played</dt>
          <dd className="num">{count(s.handsPlayed)}</dd>
        </div>
        <div>
          <dt>Hands won</dt>
          <dd className="num">
            {pct(s.handsWon, s.handsPlayed)} <small className="faint">{count(s.handsWon)} of {count(s.handsPlayed)}</small>
          </dd>
        </div>
        <div>
          <dt>Showdowns won</dt>
          <dd className="num">
            {pct(s.showdownsWon, s.showdownsReached)} <small className="faint">{count(s.showdownsWon)} of {count(s.showdownsReached)}</small>
          </dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd className="num">{s.sessions}</dd>
        </div>
        <div>
          <dt>Net profit / loss</dt>
          <dd className={`num ${s.netChips > 0 ? "pos" : s.netChips < 0 ? "neg" : ""}`}>{signed(s.netChips)}</dd>
        </div>
      </dl>
      <p className="faint small">
        "Hands won" counts hands where you took at least part of a pot, out of hands you were dealt. Amounts are play-money rupees — no real money changes hands.
      </p>

      <h2 className="section-title">Sessions</h2>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Table</th>
              <th scope="col">Players</th>
              <th scope="col" className="r">
                Hands
              </th>
              <th scope="col" className="r">
                Your net
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((x) => {
              const mine = x.players.find((p) => p.playerId === playerId);
              return (
                <tr key={x.roomId}>
                  <td>{relativeDate(x.createdAt)}</td>
                  <td>
                    <a {...linkTo(`/history/${x.roomId}`)} className="num">
                      {x.code}
                    </a>{" "}
                    {x.status !== "finished" && <span className="pill">{x.status === "playing" ? "Live" : "Lobby"}</span>}
                  </td>
                  <td className="muted">{x.players.map((p) => p.name).join(", ")}</td>
                  <td className="r num">{x.handsPlayed}</td>
                  <td className={`r num ${mine && mine.net > 0 ? "pos" : mine && mine.net < 0 ? "neg" : ""}`}>{mine && x.status !== "lobby" ? signed(mine.net) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function SessionPage({ roomId, handNo }: { roomId: string; handNo: number | null }) {
  return (
    <>
      <AppBar />
      <main className="page">
        <a className="small back" {...linkTo("/history")}>
          ← History
        </a>
        <RequireMe>{(id) => <SessionBody roomId={roomId} handNo={handNo} playerId={id} />}</RequireMe>
      </main>
    </>
  );
}

function SessionBody({ roomId, handNo, playerId }: { roomId: string; handNo: number | null; playerId: string }) {
  const res = useApi<{ session: SessionSummary; hands: HandSummary[] }>(`/api/history/${roomId}`);
  if (res.state === "loading") return <p className="muted">Loading…</p>;
  if (res.state === "error") return <p className="error-text">{res.message}</p>;
  const { session, hands } = res.data;
  const name = (id: string) => session.players.find((p) => p.playerId === id)?.name ?? "Player";
  const selected = handNo ?? hands[0]?.handNo ?? null;
  return (
    <>
      <header className="session-head">
        <h1>
          Table <span className="num">{session.code}</span>
        </h1>
        <p className="muted">
          {relativeDate(session.createdAt)} · {session.handsPlayed}
          {session.roundsTotal ? ` of ${session.roundsTotal}` : ""} rounds · {session.status === "finished" ? "Finished" : "In progress"}
          {session.status !== "finished" && (
            <>
              {" · "}
              <a {...linkTo(`/r/${session.code}`)}>Return to table</a>
            </>
          )}
        </p>
      </header>
      <h2 className="section-title">Leaderboard</h2>
      <table className="data-table standings-table">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col" className="r">
              Bought in
            </th>
            <th scope="col" className="r">
              {session.status === "finished" ? "Final stack" : "Stack"}
            </th>
            <th scope="col" className="r">
              Profit / loss
            </th>
          </tr>
        </thead>
        <tbody>
          {session.players.map((p) => (
            <tr key={p.playerId} className={p.playerId === playerId ? "me" : ""}>
              <td>{p.name}</td>
              <td className="r num">{chips(p.buyIn)}</td>
              <td className="r num">{chips(p.stack)}</td>
              <td className={`r num ${p.net > 0 ? "pos" : p.net < 0 ? "neg" : ""}`}>{signed(p.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {hands.length === 0 ? (
        <p className="muted">No completed hands in this session.</p>
      ) : (
        <div className="hands-layout">
          <ol className="hand-list" aria-label="Hands">
            {hands.map((h) => (
              <li key={h.handNo}>
                <a {...linkTo(`/history/${roomId}/${h.handNo}`)} className={h.handNo === selected ? "on" : ""} aria-current={h.handNo === selected ? "true" : undefined}>
                  <span className="num">#{h.handNo}</span>
                  <span className="muted">{h.winners.map((w) => name(w.playerId)).join(", ")}</span>
                  <span className="num faint">{chips(h.potTotal)}</span>
                </a>
              </li>
            ))}
          </ol>
          {selected !== null && <HandView roomId={roomId} handNo={selected} playerId={playerId} />}
        </div>
      )}
    </>
  );
}

function HandView({ roomId, handNo, playerId }: { roomId: string; handNo: number; playerId: string }) {
  const res = useApi<HandDetail>(`/api/history/${roomId}/hands/${handNo}`);
  if (res.state === "loading") return <div className="hand-detail panel pad muted">Loading hand…</div>;
  if (res.state === "error") return <div className="hand-detail panel pad error-text">{res.message}</div>;
  const h = res.data;
  const name = (id: string) => h.players.find((p) => p.playerId === id)?.name ?? "Player";
  const board = h.events.flatMap((e) => (e.kind === "deal" ? e.cards : []));
  return (
    <article className="hand-detail panel pad" aria-label={`Hand ${handNo}`}>
      <div className="panel-title-row">
        <h2 className="panel-title">Hand #{h.handNo}</h2>
        <span className="faint num">
          Blinds {chips(h.smallBlind)}/{chips(h.bigBlind)}
        </span>
      </div>
      <div className="detail-board">
        {board.length ? board.map((c) => <PlayingCard key={c} card={c} size="sm" />) : <span className="faint">No board — won before the flop.</span>}
      </div>
      <table className="data-table compact">
        <tbody>
          {h.players.map((p) => (
            <tr key={p.playerId} className={p.playerId === playerId ? "me" : ""}>
              <td>
                {p.name}
                {p.seat === h.buttonSeat && <span className="dealer-btn inline">D</span>}
              </td>
              <td>
                <span className="mini-cards">{p.shown ? p.shown.map((c) => <PlayingCard key={c} card={c} size="xs" />) : <span className="faint small">Not shown</span>}</span>
              </td>
              <td className="r num">{chips(p.startStack)}</td>
              <td className={`r num ${(p.endStack ?? 0) - p.startStack > 0 ? "pos" : (p.endStack ?? 0) - p.startStack < 0 ? "neg" : ""}`}>
                {p.endStack === null ? "—" : signed(p.endStack - p.startStack)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ol className="timeline">
        {h.events.map((e, i) =>
          e.kind === "deal" ? (
            <li key={i} className="street">
              <span>{describeEvent(e, name)}</span>
              <span className="mini-cards">
                {e.cards.map((c) => (
                  <PlayingCard key={c} card={c} size="xs" />
                ))}
              </span>
            </li>
          ) : (
            <li key={i}>{describeEvent(e, name)}</li>
          ),
        )}
        {resultLines(h, name).map((l, i) => (
          <li key={`r${i}`} className="result-line">
            {l}
          </li>
        ))}
      </ol>
      <p className="faint small">Your own hole cards are visible to you; others' cards appear only if shown at showdown.</p>
    </article>
  );
}
