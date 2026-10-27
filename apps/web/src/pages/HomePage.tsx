import { useEffect, useState, type FormEvent } from "react";
import { DEFAULT_SETTINGS, roomCodeSchema, type RoomSettings, type SessionSummary } from "@riverroom/protocol";
import { AppBar } from "../components/AppBar.tsx";
import { IdentityPanel } from "../components/AccountForms.tsx";
import { NameForm } from "../components/NameForm.tsx";
import { PlayingCard } from "../components/PlayingCard.tsx";
import { SettingsFields } from "../components/Settings.tsx";
import { api } from "../lib/api.ts";
import { relativeDate, signed } from "../lib/format.ts";
import { linkTo, navigate } from "../lib/router.ts";
import { useMe } from "../lib/session.ts";

export function HomePage() {
  const session = useMe();
  const me = session.status === "ready" ? session.me : null;
  const [renaming, setRenaming] = useState(false);

  return (
    <>
      <AppBar />
      <main className="home">
        <section className="home-intro">
          <div className="fan" aria-hidden="true">
            <PlayingCard card="As" size="lg" />
            <PlayingCard card="Kh" size="lg" />
            <PlayingCard size="lg" />
          </div>
          <h1>Your friends. Your table. Your game.</h1>
          <p className="muted lede">
            A private Texas Hold'em room. Open a table, send the code to your friends, and deal. Stakes are in play-money rupees — nothing is ever paid in or out.
          </p>
        </section>

        <section className="home-actions">
          {session.status === "loading" ? (
            <div className="panel pad">Loading…</div>
          ) : !me ? (
            <div className="panel pad">
              <h2 className="panel-title">Pull up a chair</h2>
              <IdentityPanel />
            </div>
          ) : renaming ? (
            <div className="panel pad">
              <h2 className="panel-title">Change your name</h2>
              <NameForm initial={me.name} submitLabel="Save" onDone={() => setRenaming(false)} />
            </div>
          ) : (
            <>
              <p className="playing-as">
                {me.username ? (
                  <>
                    Signed in as <strong>{me.name}</strong> <span className="faint">@{me.username}</span>
                  </>
                ) : (
                  <>
                    Playing as <strong>{me.name}</strong> <span className="faint">(guest)</span>
                  </>
                )}{" "}
                <button type="button" className="link-btn" onClick={() => setRenaming(true)}>
                  change name
                </button>
                {" · "}
                <a className="link-btn" {...linkTo("/account")}>
                  {me.username ? "account" : "create account"}
                </a>
              </p>
              {!me.username && (
                <p className="guest-note small">
                  Guest history stays on this browser only. <a {...linkTo("/account")}>Create an account</a> to keep your games and stats on every device.
                </p>
              )}
              <HostPanel />
              <JoinPanel />
            </>
          )}
        </section>

        {me && !renaming && <RecentSessions playerId={me.id} />}
      </main>
    </>
  );
}

function HostPanel() {
  const [settings, setSettings] = useState<RoomSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { code } = await api<{ code: string }>("/api/rooms", { method: "POST", body: { settings } });
      navigate(`/r/${code}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="panel pad">
      <h2 className="panel-title">Host a table</h2>
      <SettingsFields value={settings} onChange={setSettings} disabled={busy} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn-primary btn-block" onClick={create} disabled={busy}>
        {busy ? "Opening table…" : "Open table"}
      </button>
    </div>
  );
}

function JoinPanel() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  function join(e: FormEvent) {
    e.preventDefault();
    // Accept a pasted invite link as well as a bare code.
    const raw = code.trim().split("/").pop() ?? "";
    const parsed = roomCodeSchema.safeParse(raw.replace(/[\s-]/g, ""));
    if (!parsed.success) return setError("Room codes are 8 letters and numbers.");
    navigate(`/r/${parsed.data}`);
  }
  return (
    <form className="panel pad join" onSubmit={join} noValidate>
      <h2 className="panel-title">Join with a code</h2>
      <div className="join-row">
        <label className="field grow">
          <span className="sr-only">Room code</span>
          <input
            className="input input-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setError(null);
            }}
            placeholder="ABCD 2345"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!error}
          />
        </label>
        <button className="btn">Join</button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function RecentSessions({ playerId }: { playerId: string }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    api<{ sessions: SessionSummary[] }>("/api/history", { signal: ac.signal })
      .then((r) => setSessions(r.sessions.slice(0, 5)))
      .catch((e) => (e as Error).name !== "AbortError" && setError(true));
    return () => ac.abort();
  }, [playerId]);
  if (error || !sessions || sessions.length === 0) return null;
  return (
    <section className="recent">
      <div className="panel-title-row">
        <h2 className="panel-title">Your tables</h2>
        <a className="small" {...linkTo("/history")}>
          All history
        </a>
      </div>
      <ul className="recent-list">
        {sessions.map((s) => {
          const mine = s.players.find((p) => p.playerId === playerId);
          const href = s.status === "finished" ? `/history/${s.roomId}` : `/r/${s.code}`;
          return (
            <li key={s.roomId}>
              <a {...linkTo(href)} className="recent-item">
                <span className="num code">{s.code}</span>
                <span className="muted">{s.players.map((p) => p.name).join(", ")}</span>
                <span className="faint">{s.status === "finished" ? relativeDate(s.endedAt ?? s.createdAt) : s.status === "playing" ? "In progress" : "Waiting room"}</span>
                {mine && s.handsPlayed > 0 && <span className={`num net ${mine.net > 0 ? "pos" : mine.net < 0 ? "neg" : ""}`}>{signed(mine.net)}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Creates a one-time link that signs another device in as this player. */
export function DeviceLink() {
  const [state, setState] = useState<{ url: string; copied: boolean } | { error: string } | null>(null);
  async function make() {
    try {
      const { token } = await api<{ token: string }>("/api/session/link", { method: "POST", body: {} });
      const url = `${location.origin}/link/${token}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        /* show the link for manual copy */
      }
      setState({ url, copied });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  }
  if (!state)
    return (
      <button type="button" className="link-btn" onClick={make}>
        use on another device
      </button>
    );
  if ("error" in state) return <span className="error-text">{state.error}</span>;
  return (
    <span className="device-link">
      {state.copied ? "Link copied — " : "Open this on your other device — "}
      <span className="faint">works once, for 15 minutes.</span>
      {!state.copied && <input className="input small" readOnly value={state.url} onFocus={(e) => e.target.select()} aria-label="Device link" />}
    </span>
  );
}
