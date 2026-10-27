import type { RoomView } from "@riverroom/protocol";
import { chips, count, signed } from "../lib/format.ts";
import { linkTo } from "../lib/router.ts";

/** End-of-match leaderboard, ordered from the biggest profit to the biggest loss. */
export function Standings({ view }: { view: RoomView }) {
  const rows = view.players
    .map((p) => ({ ...p, net: p.stack - p.buyIn }))
    .sort((a, b) => b.net - a.net || b.stack - a.stack || a.name.localeCompare(b.name));
  const leader = rows[0];
  const rounds = view.roundsTotal ? `${count(view.handsPlayed)} of ${count(view.roundsTotal)} rounds` : `${count(view.handsPlayed)} rounds`;
  return (
    <div className="standings-overlay" role="dialog" aria-labelledby="standings-title">
      <div className="standings panel">
        <span className="eyebrow">Match over · {rounds}</span>
        <h2 id="standings-title">Leaderboard</h2>
        {leader && leader.net > 0 && (
          <p className="champion">
            <span className="champion-name">{leader.playerId === view.you.playerId ? "You" : leader.name}</span> finished on top with{" "}
            <span className="pos num">{signed(leader.net)}</span>
          </p>
        )}
        <table className="data-table leaderboard">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Player</th>
              <th scope="col" className="r">
                Bought in
              </th>
              <th scope="col" className="r">
                Final
              </th>
              <th scope="col" className="r">
                Profit / loss
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={p.playerId} className={`${p.playerId === view.you.playerId ? "me" : ""} ${i === 0 && p.net > 0 ? "top" : ""}`}>
                <td className="num rank">{i + 1}</td>
                <td>
                  {p.name}
                  {p.playerId === view.you.playerId && <span className="faint"> (you)</span>}
                </td>
                <td className="r num">{chips(p.buyIn)}</td>
                <td className="r num">{chips(p.stack)}</td>
                <td className={`r num pl ${p.net > 0 ? "pos" : p.net < 0 ? "neg" : ""}`}>
                  {signed(p.net)}
                  <span className="sr-only">{p.net > 0 ? " profit" : p.net < 0 ? " loss" : " even"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="faint small">Play-money rupees — no real money changes hands.</p>
        <div className="row-end">
          <a className="btn btn-ghost" {...linkTo(`/history/${view.roomId}`)}>
            Hand history
          </a>
          <a className="btn btn-primary" {...linkTo("/")}>
            New table
          </a>
        </div>
      </div>
    </div>
  );
}
