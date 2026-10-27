import { useState, type FormEvent } from "react";
import { passwordSchema } from "@riverroom/protocol";
import { IdentityPanel, RegisterForm } from "../components/AccountForms.tsx";
import { AppBar } from "../components/AppBar.tsx";
import { NameForm } from "../components/NameForm.tsx";
import { linkTo, navigate } from "../lib/router.ts";
import { changePassword, logout, useMe } from "../lib/session.ts";
import { DeviceLink } from "./HomePage.tsx";

export function AccountPage() {
  const session = useMe();
  const me = session.status === "ready" ? session.me : null;
  return (
    <>
      <AppBar />
      <main className="page account-page">
        <h1>Account</h1>
        {session.status === "loading" ? (
          <p className="muted">Loading…</p>
        ) : !me ? (
          <div className="panel pad">
            <IdentityPanel defaultMode="login" onDone={() => navigate("/")} />
          </div>
        ) : (
          <>
            <section className="panel pad">
              <h2 className="panel-title">Name at the table</h2>
              <NameForm initial={me.name} submitLabel="Save name" />
            </section>

            {me.username ? (
              <>
                <section className="panel pad">
                  <h2 className="panel-title">Signed in</h2>
                  <p className="muted">
                    Username <strong className="num">@{me.username}</strong>. Log in with it on any device to get your games, history and stats.
                  </p>
                  <div className="row-start">
                    <a className="btn btn-sm" {...linkTo("/history")}>
                      Your history &amp; stats
                    </a>
                    <LogoutButton />
                  </div>
                </section>
                <PasswordSection />
              </>
            ) : (
              <section className="panel pad">
                <h2 className="panel-title">Create an account</h2>
                <p className="muted small">
                  You're a guest right now. Pick a username and password to keep everything you've played so far and see it on any device.
                </p>
                <RegisterForm />
              </section>
            )}

            <section className="panel pad">
              <h2 className="panel-title">Quick sign-in on another device</h2>
              <p className="muted small">A one-time link that signs another phone or laptop in as you — no password needed.</p>
              <p>
                <DeviceLink />
              </p>
            </section>

            {!me.username && (
              <p className="faint small">
                <LogoutButton subtle /> — as a guest, signing out loses access to this identity unless you create an account first.
              </p>
            )}
          </>
        )}
      </main>
    </>
  );
}

function LogoutButton({ subtle }: { subtle?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={subtle ? "link-btn" : "btn btn-sm btn-ghost"}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await logout().catch(() => {});
        navigate("/");
      }}
    >
      {busy ? "Signing out…" : "Log out"}
    </button>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = passwordSchema.safeParse(next);
    if (!p.success) return setMsg({ ok: false, text: p.error.issues[0]?.message ?? "Check your new password." });
    setBusy(true);
    setMsg(null);
    try {
      const others = await changePassword(current, next);
      setMsg({ ok: true, text: others ? `Password changed. ${others} other device${others > 1 ? "s were" : " was"} signed out.` : "Password changed." });
      setCurrent("");
      setNext("");
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel pad">
      <h2 className="panel-title">Change password</h2>
      <form className="name-form" onSubmit={submit} noValidate>
        <label className="field">
          <span>Current password</span>
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="field">
          <span>New password (8+ characters)</span>
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        {msg && (
          <p className={msg.ok ? "small pos" : "error-text"} role={msg.ok ? "status" : "alert"}>
            {msg.text}
          </p>
        )}
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
    </section>
  );
}
