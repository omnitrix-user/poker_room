import { useState, type FormEvent } from "react";
import { displayNameSchema } from "@riverroom/protocol";
import { establishIdentity } from "../lib/session.ts";

export function NameForm({ initial = "", submitLabel = "Continue", onDone }: { initial?: string; submitLabel?: string; onDone?: () => void }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = displayNameSchema.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Invalid name.");
    setBusy(true);
    setError(null);
    try {
      await establishIdentity(parsed.data);
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
        <span>Your name at the table</span>
        <input
          className="input"
          autoFocus
          autoComplete="nickname"
          maxLength={20}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? "name-error" : undefined}
          placeholder="e.g. Sam"
        />
      </label>
      {error && (
        <p id="name-error" className="error-text" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? "One moment…" : submitLabel}
      </button>
    </form>
  );
}
