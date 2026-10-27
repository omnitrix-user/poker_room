import type { ReactNode } from "react";
import { linkTo } from "../lib/router.ts";

export function Wordmark() {
  return (
    <a className="wordmark" {...linkTo("/")} aria-label="RiverRoom home">
      River<i>Room</i>
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
      </nav>
    </header>
  );
}
