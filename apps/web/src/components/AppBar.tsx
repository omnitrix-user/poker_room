import type { ReactNode } from "react";
import { linkTo } from "../lib/router.ts";
import { useMe } from "../lib/session.ts";

export function Wordmark() {
  return (
    <a className="wordmark" {...linkTo("/")} aria-label="RiverRoom home">
      River<i>Room</i>
    </a>
  );
}

function AccountLink() {
  const s = useMe();
  const me = s.status === "ready" ? s.me : null;
  return (
    <a className="btn btn-ghost btn-sm" {...linkTo("/account")}>
      {me?.username ? `@${me.username}` : me ? "Account" : "Log in"}
    </a>
  );
}

export function AppBar({ children }: { children?: ReactNode }) {
  return (
    <header className="appbar">
      <Wordmark />
      <nav>
        {children}
        <a className="btn btn-ghost btn-sm" {...linkTo("/history")}>
          History
        </a>
        <AccountLink />
      </nav>
    </header>
  );
}
