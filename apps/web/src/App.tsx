import { HistoryPage, SessionPage } from "./pages/HistoryPage.tsx";
import { LinkPage } from "./pages/LinkPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { CenteredMessage, RoomPage } from "./pages/RoomPage.tsx";
import { linkTo, usePath } from "./lib/router.ts";

export function App() {
  const path = usePath();
  let m: RegExpMatchArray | null;
  if (path === "/") return <HomePage />;
  if ((m = path.match(/^\/r\/([A-Za-z0-9]{8})\/?$/))) return <RoomPage key={m[1]!.toUpperCase()} code={m[1]!.toUpperCase()} />;
  if (path === "/history") return <HistoryPage />;
  // The link page removes the token from the address bar right away; "/link" keeps rendering it.
  if ((m = path.match(/^\/link(?:\/([A-Za-z0-9_-]{43}))?\/?$/))) return <LinkPage token={m[1] ?? null} />;
  if ((m = path.match(/^\/history\/([0-9a-f-]{36})(?:\/(\d+))?\/?$/))) return <SessionPage roomId={m[1]!} handNo={m[2] ? Number(m[2]) : null} />;
  return (
    <CenteredMessage title="Nothing here" detail="That page doesn't exist.">
      <a className="btn" {...linkTo("/")}>
        Home
      </a>
    </CenteredMessage>
  );
}
