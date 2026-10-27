import { useEffect, useRef, useState, type FormEvent } from "react";
import { CHAT_MAX_LENGTH, type Ack, type ChatMessage, type GameView, type PublicHandEvent, type RoomView } from "@riverroom/protocol";
import { ACTION_VERBS, chips, signed, toneFor, initials } from "../lib/format.ts";
import { linkTo } from "../lib/router.ts";
import { PlayingCard } from "./PlayingCard.tsx";
import { SoundToggle } from "./SoundToggle.tsx";

export interface PastHand {
  handNo: number;
  summary: string;
}

const STREET_NAMES: Record<string, string> = { preflop: "Pre-flop", flop: "Flop", turn: "Turn", river: "River" };
const QUICK = ["Nice hand", "GG", "Wow", "Unlucky", "Ship it", "Thinking…"];

export function describeEvent(e: PublicHandEvent, name: (id: string) => string): string {
  if (e.kind === "blind")
    return e.blind === "post"
      ? `${name(e.playerId)} posts ${chips(e.amount)} to come in${e.allIn ? " (all-in)" : ""}`
      : `${name(e.playerId)} posts ${e.blind} blind ${chips(e.amount)}${e.allIn ? " (all-in)" : ""}`;
  if (e.kind === "deal") return STREET_NAMES[e.street]!;
  const verb = ACTION_VERBS[e.action] ?? e.action;
  const amount = e.action === "raise" || e.action === "bet" ? ` ${chips(e.to)}` : e.action === "call" ? ` ${chips(e.amount)}` : "";
  return `${name(e.playerId)} ${e.action === "raise" && e.allIn ? "raises all-in to" : verb}${amount}${e.allIn && e.action === "call" ? " (all-in)" : ""}`;
}

export function resultLines(game: Pick<GameView, "result">, name: (id: string) => string): string[] {
  const r = game.result;
  if (!r) return [];
  const lines: string[] = [];
  if (r.refund) lines.push(`${chips(r.refund.amount)} uncalled returned to ${name(r.refund.playerId)}`);
  const first = r.pots.length ? r.equity[0] : undefined;
  if (first) {
    const parts = Object.entries(first.equity).map(([id, e]) => `${name(id)} ${Math.round(e * 100)}%`);
    lines.push(`All-in ${first.board === 0 ? "pre-flop" : `on the ${first.board === 3 ? "flop" : "turn"}`}: ${parts.join(" vs ")}`);
  }
  for (const s of r.shown) if (s.name) lines.push(`${name(s.playerId)} shows ${s.name}`);
  for (const id of r.mucked ?? []) lines.push(`${name(id)} mucks`);
  r.pots.forEach((pot, i) => {
    const label = r.pots.length > 1 ? (i === 0 ? "Main pot" : `Side pot ${i}`) : "Pot";
    lines.push(`${label} ${chips(pot.amount)} → ${pot.winners.map((w) => `${name(w.playerId)} ${chips(w.amount)}`).join(", ")}`);
  });
  return lines;
}

type Tab = "log" | "chat" | "standings";

export function SidePanel({
  view,
  past,
  chat,
  onChat,
  onClose,
  tab,
  setTab,
}: {
  view: RoomView;
  past: PastHand[];
  chat: ChatMessage[];
  onChat: (text: string) => Promise<Ack>;
  onClose: () => void;
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  return (
    <div className="side-panel tabbed" role="complementary" aria-label="Table panel">
      <div className="tabs" role="tablist">
        {(["log", "chat", "standings"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
            {t === "log" ? "Hand log" : t === "chat" ? "Chat" : "Standings"}
          </button>
        ))}
        <SoundToggle className="show-sm" />
        <button type="button" className="btn btn-sm btn-ghost close" onClick={onClose} aria-label="Close panel">
          Close
        </button>
      </div>
      {tab === "log" && <HandLogBody view={view} past={past} />}
      {tab === "chat" && <ChatPanel view={view} chat={chat} onChat={onChat} />}
      {tab === "standings" && <LiveStandings view={view} />}
    </div>
  );
}

function HandLogBody({ view, past }: { view: RoomView; past: PastHand[] }) {
  const name = (id: string) => view.players.find((p) => p.playerId === id)?.name ?? "Player";
  const game = view.game;
  return (
    <div className="panel-body">
      <h2 className="panel-title">{game ? `Hand #${game.handNo}` : "Hand log"}</h2>
      {game ? (
        <ol className="timeline">
          {game.events.map((e, i) =>
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
          {resultLines(game, name).map((l, i) => (
            <li key={`r${i}`} className="result-line">
              {l}
            </li>
          ))}
        </ol>
      ) : (
        <p className="faint">No hand yet.</p>
      )}
      {past.length > 0 && (
        <>
          <h3 className="eyebrow past-title">Earlier this session</h3>
          <ul className="past-hands">
            {past.map((h) => (
              <li key={h.handNo}>
                <a {...linkTo(`/history/${view.roomId}/${h.handNo}`)}>#{h.handNo}</a> <span className="muted">{h.summary}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <a className="small" {...linkTo(`/history/${view.roomId}`)}>
        Full session history
      </a>
    </div>
  );
}

function ChatPanel({ view, chat, onChat }: { view: RoomView; chat: ChatMessage[]; onChat: (text: string) => Promise<Ack> }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat.length]);
  async function send(t: string) {
    const ack = await onChat(t);
    if (!ack.ok) setError(ack.message);
    else setError(null);
    return ack.ok;
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    if (await send(text)) setText("");
  }
  return (
    <div className="panel-body chat">
      <ol className="chat-list" ref={listRef} aria-live="polite">
        {chat.length === 0 && <li className="faint">Say hello to the table.</li>}
        {chat.map((m) => (
          <li key={m.id} className={m.playerId === view.you.playerId ? "mine" : ""}>
            <span className="mono sm" style={{ background: toneFor(m.playerId) }} aria-hidden="true">
              {initials(m.name)}
            </span>
            <span className="chat-body">
              <b>{m.name}</b> {m.text}
            </span>
          </li>
        ))}
      </ol>
      <div className="quick" role="group" aria-label="Quick messages">
        {QUICK.map((q) => (
          <button key={q} type="button" className="btn btn-sm btn-ghost" onClick={() => void send(q)}>
            {q}
          </button>
        ))}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="chat-input">
          Message
        </label>
        <input
          id="chat-input"
          className="input"
          value={text}
          maxLength={CHAT_MAX_LENGTH}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message the table"
          autoComplete="off"
        />
        <button className="btn btn-sm">Send</button>
      </form>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

function LiveStandings({ view }: { view: RoomView }) {
  const rows = view.players.map((p) => ({ ...p, net: p.stack - p.buyIn })).sort((a, b) => b.net - a.net);
  return (
    <div className="panel-body">
      <h2 className="panel-title">Standings</h2>
      <table className="data-table compact">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col" className="r">
              Stack
            </th>
            <th scope="col" className="r">
              Net
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.playerId} className={p.playerId === view.you.playerId ? "me" : ""}>
              <td>
                <span className="rank num">{i + 1}</span> {p.name}
                {p.buyIn > view.settings.startingStack && (
                  <span className="faint small"> · {Math.round(p.buyIn / view.settings.startingStack) - 1} rebuy</span>
                )}
              </td>
              <td className="r num">{chips(p.stack)}</td>
              <td className={`r num ${p.net > 0 ? "pos" : p.net < 0 ? "neg" : ""}`}>{signed(p.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="faint small">Stacks update when each pot is settled. Play-money rupees — no real money changes hands.</p>
    </div>
  );
}
