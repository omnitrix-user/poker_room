import { useState } from "react";

export function InviteBox({ code, compact }: { code: string; compact?: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const link = `${location.origin}/r/${code}`;
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied("Copy failed — select the code instead");
    }
  }
  if (compact) {
    return (
      <button type="button" className="code-chip" onClick={() => copy(link, "link")} title="Copy invite link">
        <span className="num">{code}</span>
        <span className="faint">{copied === "link" ? "Copied" : "Copy link"}</span>
      </button>
    );
  }
  return (
    <div className="invite">
      <div className="invite-code" aria-label={`Room code ${code.split("").join(" ")}`}>
        {code.slice(0, 4)}
        <span className="gap" />
        {code.slice(4)}
      </div>
      <div className="invite-actions">
        <button type="button" className="btn btn-sm" onClick={() => copy(link, "link")}>
          {copied === "link" ? "Link copied" : "Copy invite link"}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => copy(code, "code")}>
          {copied === "code" ? "Code copied" : "Copy code"}
        </button>
      </div>
      {copied && copied !== "link" && copied !== "code" && <p className="faint small">{copied}</p>}
    </div>
  );
}
