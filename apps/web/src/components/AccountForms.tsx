import { useState, type FormEvent } from "react";
import { displayNameSchema, passwordSchema, usernameSchema } from "@riverroom/protocol";
import { login, register } from "../lib/session.ts";
import { NameForm } from "./NameForm.tsx";

type Mode = "guest" | "login" | "register";

/** Sign in, create an account, or just play as a guest. */
export function IdentityPanel({
  defaultMode = "guest",
  guestLabel = "Continue",
  onDone,
  allowGuest = true,
}: {
  defaultMode?: Mode;
  guestLabel?: string;
  onDone?: () => void;
  allowGuest?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(allowGuest ? defaultMode : "login");
  const tabs: [Mode, string][] = [...(allowGuest ? ([["guest", "Play as guest"]] as [Mode, string][]) : []), ["login", "Log in"], ["register", "Create account"]];
  return (
    <div className="identity">
      <div className="seg" role="tablist">
        {tabs.map(([m, label]) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>
      {mode === "guest" && (
        <>
          <p className="muted small">No sign-up. This browser remembers you. Create an account any time to keep your history on every device.</p>
          <NameForm submitLabel={guestLabel} onDone={onDone} />
        </>
      )}
      {mode === "login" && <LoginForm onDone={onDone} />}
      {mode === "register" && <RegisterForm onDone={onDone} askName />}
    </div>
  );
}

export function LoginForm({ onDone }: { onDone?: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return setError("Enter your username and password.");
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="name-form" onSubmit={submit} noValidate>
      <label className="field">
        <span>Username</span>
        <input className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="field">
        <span>Password</span>
        <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? "Signing in…" : "Log in"}
      </button>
    </form>
  );
}

/** Creates an account. Signed in as a guest, this keeps that guest's history. */
export function RegisterForm({ onDone, askName = false }: { onDone?: () => void; askName?: boolean }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const u = usernameSchema.safeParse(username);
    if (!u.success) return setError(u.error.issues[0]?.message ?? "Check your username.");
    const p = passwordSchema.safeParse(password);
    if (!p.success) return setError(p.error.issues[0]?.message ?? "Check your password.");
    if (password !== confirm) return setError("The two passwords don't match.");
    let display: string | undefined;
    if (askName && name.trim()) {
      const n = displayNameSchema.safeParse(name);
      if (!n.success) return setError(n.error.issues[0]?.message ?? "Check your name.");
      display = n.data;
    }
    setBusy(true);
    setError(null);
    try {
      await register(u.data, password, display);
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="name-form" onSubmit={submit} noValidate>
      {askName && (
        <label className="field">
          <span>Name at the table (optional)</span>
          <input className="input" autoComplete="nickname" maxLength={20} value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to your username" />
        </label>
      )}
      <label className="field">
        <span>Username (for logging in)</span>
        <input className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={20} value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="field">
        <span>Password (8+ characters)</span>
        <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="field">
        <span>Confirm password</span>
        <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? "Creating account…" : "Create account"}
      </button>
      <p className="faint small">There's no email or password recovery, so keep your password somewhere safe. Play-money only.</p>
    </form>
  );
}
