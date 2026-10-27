import { rankOf, suitOf, type Card } from "@riverroom/engine";
import type { CSSProperties } from "react";

const SUIT_PATHS: Record<string, string> = {
  s: "M50 6c9 17 37 31 38 55 1 15-12 24-25 19-4-2-7-4-9-8 1 9 5 16 12 21H34c7-5 11-12 12-21-2 4-5 6-9 8-13 5-26-4-25-19 1-24 29-38 38-55z",
  h: "M50 90C24 68 8 54 8 33 8 19 18 9 31 9c9 0 16 5 19 13 3-8 10-13 19-13 13 0 23 10 23 24 0 21-16 35-42 57z",
  d: "M50 4c10 17 22 31 38 46-16 15-28 29-38 46-10-17-22-31-38-46C28 35 40 21 50 4z",
  c: "M50 8a19 19 0 0 1 16 29 19 19 0 1 1-8 33c1 9 5 16 12 21H30c7-5 11-12 12-21a19 19 0 1 1-8-33A19 19 0 0 1 50 8z",
};

const SUIT_NAMES: Record<string, string> = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };
const RANK_NAMES: Record<string, string> = { T: "10", J: "jack", Q: "queen", K: "king", A: "ace" };

export function SuitIcon({ suit, className }: { suit: string; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <path d={SUIT_PATHS[suit]} fill="currentColor" />
    </svg>
  );
}

export function cardLabel(card: Card): string {
  const r = card[0]!;
  return `${RANK_NAMES[r] ?? r} of ${SUIT_NAMES[card[1]!]}`;
}

interface Props {
  card?: Card | null;
  size?: "xs" | "sm" | "md" | "lg";
  /** Highlight as part of the winning five. */
  highlight?: boolean;
  dim?: boolean;
  /** Stagger for the deal animation (ms). */
  delay?: number;
  className?: string;
  animate?: "deal" | "flip" | false;
}

/** A physical-looking playing card. `card` null/undefined renders the back. */
export function PlayingCard({ card, size = "md", highlight, dim, delay = 0, className = "", animate = false }: Props) {
  const style = { "--delay": `${delay}ms` } as CSSProperties;
  const anim = animate ? `anim-${animate}` : "";
  if (!card) {
    return <div className={`pcard back ${size} ${anim} ${className}`} style={style} role="img" aria-label="Face-down card" />;
  }
  const suit = suitOf(card);
  const rank = card[0] === "T" ? "10" : card[0]!;
  const red = suit === "h" || suit === "d";
  return (
    <div
      className={`pcard face ${size} ${red ? "red" : "black"} ${highlight ? "hl" : ""} ${dim ? "dim" : ""} ${anim} ${className}`}
      style={style}
      role="img"
      aria-label={cardLabel(card)}
      data-card={card}
      data-rank={rankOf(card)}
    >
      <span className="idx tl">
        <b>{rank}</b>
        <SuitIcon suit={suit} />
      </span>
      <SuitIcon suit={suit} className="pip" />
      <span className="idx br">
        <b>{rank}</b>
        <SuitIcon suit={suit} />
      </span>
    </div>
  );
}

export function CardSlot({ size = "md" }: { size?: Props["size"] }) {
  return <div className={`pcard slot ${size}`} aria-hidden="true" />;
}
