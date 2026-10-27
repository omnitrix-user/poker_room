import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, type Ack, type RoomSettings, type RoomView } from "@riverroom/protocol";
import { SettingsFields, settingsSummary } from "./Settings.tsx";
import { InviteBox } from "./InviteBox.tsx";

interface Props {
  view: RoomView;
  request: (event: "room:ready" | "room:settings" | "game:start" | "room:leave", payload?: object) => Promise<Ack>;
  onLeft: () => void;
}

export function LobbyPanel({ view, request, onLeft }: Props) {
  const isHost = view.you.isHost;
  const me = view.players.find((p) => p.playerId === view.you.playerId);
  // Tables created before a setting existed get its default.
  const current: RoomSettings = { ...DEFAULT_SETTINGS, ...view.settings };
  const [draft, setDraft] = useState<RoomSettings>(current);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);

  useEffect(() => setDraft({ ...DEFAULT_SETTINGS, ...view.settings }), [view.settings]);

  async function run(label: string, event: Parameters<Props["request"]>[0], payload?: object) {
    setBusy(label);
    setError(null);
    const ack = await request(event, payload);
    setBusy(null);
    if (!ack.ok) setError(ack.message);
    return ack.ok;
  }

  const seated = view.players.length;
  const waitingOn = view.players.filter((p) => !p.isHost && !p.ready).map((p) => p.name);
  const startBlocker = seated < 2 ? "Waiting for at least one more player." : waitingOn.length ? `Waiting for ${waitingOn.join(", ")}.` : null;

  return (
    <div className="side-panel lobby-panel">
      <section>
        <h2 className="panel-title">Invite friends</h2>
        <InviteBox code={view.code} />
      </section>
      <hr className="divider" />
      <section>
        <div className="panel-title-row">
          <h2 className="panel-title">Table</h2>
          {isHost ? <span className="faint">You're the host</span> : <span className="faint">Set by the host</span>}
        </div>
        {isHost ? (
          <>
            <SettingsFields value={draft} onChange={setDraft} disabled={!!busy} />
            {dirty && (
              <div className="row-end">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(current)}>
                  Reset
                </button>
                <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => run("save", "room:settings", { settings: draft })}>
                  {busy === "save" ? "Saving…" : "Save settings"}
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="muted num">{settingsSummary(view.settings)}</p>
        )}
      </section>
      <hr className="divider" />
      <section className="lobby-actions">
        {isHost ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={!!busy || !!startBlocker || dirty}
              onClick={() => run("start", "game:start")}
            >
              {busy === "start" ? "Shuffling…" : "Start game"}
            </button>
            <p className="faint small">{dirty ? "Save or reset your settings first." : (startBlocker ?? "Everyone's ready.")}</p>
          </>
        ) : me ? (
          <>
            <button
              type="button"
              className={`btn btn-block ${me.ready ? "" : "btn-primary"}`}
              disabled={!!busy}
              aria-pressed={me.ready}
              onClick={() => run("ready", "room:ready", { ready: !me.ready })}
            >
              {me.ready ? "Not ready" : "I'm ready"}
            </button>
            <p className="faint small">{me.ready ? "Waiting for the host to start." : "Let the host know you're set."}</p>
          </>
        ) : null}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm leave"
          disabled={!!busy}
          onClick={async () => {
            if (await run("leave", "room:leave")) onLeft();
          }}
        >
          Leave table
        </button>
      </section>
    </div>
  );
}
