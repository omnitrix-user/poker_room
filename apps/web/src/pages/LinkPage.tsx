import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api.ts";
import { linkTo } from "../lib/router.ts";
import { CenteredMessage } from "./RoomPage.tsx";

/** Claims a one-time device link, then continues as that player. */
export function LinkPage({ token: fromUrl }: { token: string | null }) {
  // Captured once: the URL no longer contains the token after the first render.
  const [token] = useState(fromUrl);
  const [error, setError] = useState<string | null>(fromUrl ? null : "This link is incomplete. Make a new one on your other device.");
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;
    // Remove the token from the address bar and history right away.
    history.replaceState(null, "", "/link");
    api<{ player: { name: string } }>("/api/session/claim", { method: "POST", body: { token } })
      .then(() => {
        // Full reload so every part of the app picks up the new session.
        location.replace("/");
      })
      .catch((e: ApiError) => setError(e.message));
  }, [token]);
  if (error)
    return (
      <CenteredMessage title="Link didn't work" detail={error}>
        <a className="btn" {...linkTo("/")}>
          Home
        </a>
      </CenteredMessage>
    );
  return <CenteredMessage title="Signing you in…" />;
}
