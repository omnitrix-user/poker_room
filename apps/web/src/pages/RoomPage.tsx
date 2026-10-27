import { useEffect, useRef, useState } from "react";
import type { RoomView } from "@riverroom/protocol";
import { ActionBar } from "../components/ActionBar.tsx";
import { Wordmark } from "../components/AppBar.tsx";
import { SidePanel, type PastHand } from "../components/HandLog.tsx";
import { InviteBox } from "../components/InviteBox.tsx";
import { LobbyPanel } from "../components/LobbyPanel.tsx";
import { IdentityPanel } from "../components/AccountForms.tsx";
import { Standings } from "../components/Standings.tsx";
import { ExtendMenu, MatchVote, RoundCounter } from "../components/MatchVote.tsx";
import { Table } from "../components/Table.tsx";
import { chips } from "../lib/format.ts";
import { useMediaQuery } from "../lib/media.ts";
import { type ConnectionState, type RoomClient, type RoomSnapshot, useRoomClient } from "../lib/roomClient.ts";
import { linkTo, navigate } from "../lib/router.ts";
import { useMe } from "../lib/session.ts";
import { useGameFeedback } from "../lib/gameFeedback.ts";
import { useRunoutDirector } from "../lib/runout.ts";
import { play } from "../lib/sound.ts";
import { SoundToggle } from "../components/SoundToggle.tsx";

export function RoomPage({ code }: { code: string }) {
  const session = useMe();
  if (session.status === "loading") return <CenteredMessage title="Loading…" />;
  if (!session.me) {
    return (
      <div className="gate">
        <Wordmark />
        <div className="gate-card panel">
          <span className="eyebrow">You're invited</span>
          <h1>
            Table <span className="num">{code}</span>
          </h1>
          <p className="muted">Play as a guest, or log in so this game counts towards your history everywhere.</p>
          <IdentityPanel guestLabel="Join table" />
        </div>
      </div>
    );
  }
  return <RoomScreen code={code} />;
}

function RoomScreen({ code }: { code: string }) {
  const [client, snap] = useRoomClient(code, true);
  const portrait = useMediaQuery("(max-width: 700px) and (orientation: portrait)");
  const [logOpen, setLogOpen] = useState(() => matchMedia("(min-width: 1280px)").matches);
  const [tab, setTab] = useState<"log" | "chat" | "standings">("log");
  // What the player sees: the server view, with all-in runouts revealed street by street.
  const { view: shown, revealing } = useRunoutDirector(snap?.view ?? null);
  const past = usePastHands(shown);
  useGameFeedback(shown);
  const unread = useUnreadChat(snap, logOpen && tab === "chat");

  if (!client || !snap) return <CenteredMessage title="Joining table…" />;
  if (snap.joinError && !snap.view) return <JoinError code={snap.joinError.code} message={snap.joinError.message} />;
  if (!snap.view) return <CenteredMessage title="Joining table…" detail={snap.conn === "reconnecting" ? "Trying to reach the server…" : undefined} />;

  const view = shown ?? snap.view;
  const lobby = view.status === "lobby";
  const showLog = !lobby && logOpen;

  return (
    <div className={`room ${lobby ? "is-lobby" : "is-playing"}`}>
      <RoomBar
        view={view}
        conn={snap.conn}
        client={client}
        logOpen={logOpen}
        unread={unread}
        onToggleLog={() => setLogOpen((o) => !o)}
        onOpenChat={() => {
          setTab("chat");
          setLogOpen(true);
        }}
      />
      <div className="room-body">
        <main className="stage" aria-label="Poker table">
          <Table
            view={view}
            clockOffset={snap.clockOffset}
            portrait={portrait}
            chat={snap.chat}
            revealing={revealing}
            onSit={lobby ? (seat) => void client.request("room:sit", { seat }) : undefined}
          />
        </main>
        {lobby && (
          <aside className="side">
            <LobbyPanel view={view} request={(e, p) => client.request(e, p)} onLeft={() => navigate("/")} />
          </aside>
        )}
        {showLog && (
          <aside className={`side ${portrait ? "sheet" : ""}`}>
            <SidePanel
              view={view}
              past={past}
              chat={snap.chat}
              onChat={(text) => client.request("room:chat", { text })}
              onClose={() => setLogOpen(false)}
              tab={tab}
              setTab={setTab}
            />
          </aside>
        )}
      </div>
      <ActionBar view={view} onAction={(a) => client.act(a)} onRequest={(e, p) => client.request(e, p)} clockOffset={snap.clockOffset} />
      <MatchVote view={view} request={(e, p) => client.request(e, p)} clockOffset={snap.clockOffset} />
      {view.status === "finished" && <Standings view={view} />}
      {snap.superseded && <Superseded onReclaim={() => client.reclaim()} />}
      <Toasts snap={snap} client={client} />
      <Announcer view={view} />
    </div>
  );
}

function RoomBar({
  view,
  conn,
  client,
  logOpen,
  unread,
  onToggleLog,
  onOpenChat,
}: {
  view: RoomView;
  conn: ConnectionState;
  client: RoomClient;
  logOpen: boolean;
  unread: number;
  onToggleLog: () => void;
  onOpenChat: () => void;
}) {
  const [confirm, setConfirm] = useState<"leave" | "end" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playing = view.status === "playing";
  const meInHand = view.game?.players.some((p) => p.playerId === view.you.playerId && p.status !== "folded") && view.game?.street !== "complete";

  async function doConfirm() {
    const ack = confirm === "leave" ? await client.request("room:leave") : await client.request("room:end");
    if (!ack.ok) return setError(ack.message);
    if (confirm === "leave") navigate("/");
    setConfirm(null);
  }

  return (
    <header className="appbar roombar">
      <Wordmark />
      <InviteBox code={view.code} compact />
      <span className="bar-info num">
        <span className="hide-sm">Blinds </span>
        {chips(view.settings.smallBlind)}/{chips(view.settings.bigBlind)}
      </span>
      <RoundCounter view={view} />
      <span className={`conn ${conn}`} role="status">
        <span className="dot" aria-hidden="true" />
        {conn === "live" ? "Live" : conn === "connecting" ? "Connecting…" : "Reconnecting…"}
      </span>
      <nav>
        {view.endRequested && <span className="pill">Last hand</span>}
        <ExtendMenu view={view} request={(e, p) => client.request(e, p)} />
        <SoundToggle className="hide-sm" />
        {playing && (
          <button
            type="button"
            className={`btn btn-ghost btn-sm ${logOpen ? "on" : ""}`}
            aria-pressed={logOpen}
            onClick={unread > 0 && !logOpen ? onOpenChat : onToggleLog}
          >
            <span className="hide-sm">Chat &amp; log</span>
            <span className="show-sm">Chat</span>
            {unread > 0 && !logOpen && <span className="badge num">{unread}</span>}
          </button>
        )}
        {playing && view.you.isHost && !view.endRequested && (
          <button type="button" className="btn btn-ghost btn-sm hide-sm" onClick={() => setConfirm("end")}>
            End session
          </button>
        )}
        {playing && view.you.seat !== null && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm("leave")}>
            Leave
          </button>
        )}
        {view.status === "finished" && (
          <a className="btn btn-ghost btn-sm" {...linkTo("/history")}>
            History
          </a>
        )}
      </nav>
      {confirm && (
        <div className="confirm panel" role="alertdialog" aria-labelledby="confirm-text">
          <p id="confirm-text">
            {confirm === "leave"
              ? meInHand
                ? "Leave the table? Your current hand will be folded and your stack becomes final."
                : "Leave the table? Your stack becomes final."
              : "End the session after the current hand? Final standings will be recorded."}
          </p>
          {error && <p className="error-text">{error}</p>}
          <div className="row-end">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)} autoFocus>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={doConfirm}>
              {confirm === "leave" ? "Leave table" : "End session"}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}

/** Counts chat messages from others that arrived while the chat tab wasn't visible. */
function useUnreadChat(snap: RoomSnapshot | null, chatVisible: boolean): number {
  const [seen, setSeen] = useState(0);
  const msgs = snap?.chat ?? [];
  const me = snap?.view?.you.playerId;
  const lastId = msgs[msgs.length - 1]?.id ?? 0;
  useEffect(() => {
    if (chatVisible) setSeen(lastId);
  }, [chatVisible, lastId]);
  const prevLen = useRef(msgs.length);
  useEffect(() => {
    if (msgs.length > prevLen.current && msgs[msgs.length - 1]?.playerId !== me) play("chat");
    prevLen.current = msgs.length;
  }, [msgs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return chatVisible ? 0 : msgs.filter((m) => m.id > seen && m.playerId !== me).length;
}

/** Keeps a short list of the hands completed while this page has been open. */
function usePastHands(view: RoomView | null): PastHand[] {
  const [past, setPast] = useState<PastHand[]>([]);
  const g = view?.game;
  useEffect(() => {
    if (!view || !g?.result || g.street !== "complete" || g.result.pots.length === 0) return;
    if (past.some((p) => p.handNo === g.handNo)) return;
    const name = (id: string) => view.players.find((p) => p.playerId === id)?.name ?? "Player";
    const totals = new Map<string, number>();
    for (const pot of g.result.pots) for (const w of pot.winners) totals.set(w.playerId, (totals.get(w.playerId) ?? 0) + w.amount);
    const summary = [...totals].map(([id, a]) => `${name(id)} won ${chips(a)}`).join(", ") + (g.result.pots[0]?.winningHand ? ` · ${g.result.pots[0].winningHand}` : "");
    setPast((p) => [{ handNo: g.handNo, summary }, ...p].slice(0, 12));
  }, [g?.handNo, g?.street, g?.result?.pots.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return past;
}

/** Screen-reader announcements for turn changes and results. */
function Announcer({ view }: { view: RoomView }) {
  const [text, setText] = useState("");
  const last = useRef("");
  const g = view.game;
  useEffect(() => {
    if (!g) return;
    let msg = "";
    if (g.legal) msg = g.legal.canCheck ? "Your turn. You can check." : `Your turn. ${chips(g.legal.callAmount)} to call.`;
    else if (g.street === "complete" && g.result && g.result.pots.length > 0) {
      const name = (id: string) => view.players.find((p) => p.playerId === id)?.name ?? "Player";
      const w = g.result.pots.flatMap((p) => p.winners.map((x) => `${name(x.playerId)} wins ${chips(x.amount)}`));
      msg = `Hand ${g.handNo} over. ${w.join(". ")}.`;
    }
    const key = `${g.handNo}:${g.seq}:${g.street}:${msg}`;
    if (msg && key !== last.current) {
      last.current = key;
      setText(msg);
    }
  }, [g?.handNo, g?.seq, g?.street, g?.legal, g?.result?.pots.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="sr-only" aria-live="assertive" aria-atomic="true">
      {text}
    </div>
  );
}

function Toasts({ snap, client }: { snap: RoomSnapshot; client: RoomClient }) {
  return (
    <div className="toasts" aria-live="polite">
      {snap.notices.map((n) => (
        <div key={n.id} className={`toast ${n.kind}`} onClick={() => client.dismissNotice(n.id)}>
          {n.text}
        </div>
      ))}
    </div>
  );
}

function Superseded({ onReclaim }: { onReclaim: () => void }) {
  return (
    <div className="standings-overlay" role="dialog" aria-labelledby="sup-title">
      <div className="standings panel">
        <h2 id="sup-title">Open in another tab</h2>
        <p className="muted">This table is now being played from another tab or device with your identity.</p>
        <div className="row-end">
          <a className="btn btn-ghost" {...linkTo("/")}>
            Home
          </a>
          <button type="button" className="btn btn-primary" onClick={onReclaim}>
            Play here instead
          </button>
        </div>
      </div>
    </div>
  );
}

function JoinError({ code, message }: { code: string; message: string }) {
  if (code === "unauthenticated") {
    return (
      <div className="gate">
        <Wordmark />
        <div className="gate-card panel">
          <h1>Who's playing?</h1>
          <p className="muted">{message}</p>
          <IdentityPanel guestLabel="Join table" onDone={() => location.reload()} />
        </div>
      </div>
    );
  }
  const title =
    code === "room_full" ? "This table is full" : code === "room_finished" ? "This session has ended" : code === "room_not_found" ? "No table with that code" : "Couldn't join";
  return (
    <CenteredMessage title={title} detail={message}>
      <a className="btn" {...linkTo("/")}>
        Back to home
      </a>
      {code === "room_finished" && (
        <a className="btn btn-ghost" {...linkTo("/history")}>
          History
        </a>
      )}
    </CenteredMessage>
  );
}

export function CenteredMessage({ title, detail, children }: { title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <div className="gate">
      <Wordmark />
      <div className="gate-card panel" role="status">
        <h1>{title}</h1>
        {detail && <p className="muted">{detail}</p>}
        {children && <div className="row-start">{children}</div>}
      </div>
    </div>
  );
}
