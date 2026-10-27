import { rankOf, suitOf, type Card } from "@riverroom/engine";
import type { CSSProperties } from "react";

/** Suit symbols on a 100×100 grid: classic proportions, symmetric, built from simple curves. */
const SUIT_PATHS: Record<string, string> = {
  h: "M50 92C47 88 6 60 6 34 6 18 18 8 31 8c9 0 16 5 19 13 3-8 10-13 19-13 13 0 25 10 25 26 0 26-41 54-44 58z",
  s: "M50 6c3 6 44 32 44 55 0 14-10 23-23 23-9 0-16-5-19-12 1 10 5 17 14 22H34c9-5 13-12 14-22-3 7-10 12-19 12C16 84 6 75 6 61 6 38 47 12 50 6z",
  d: "M50 4c10 16 24 34 38 46-14 12-28 30-38 46-10-16-24-34-38-46C26 38 40 20 50 4z",
  c: "M31 29a19 19 0 1 0 38 0 19 19 0 1 0-38 0zM9 58a19 19 0 1 0 38 0 19 19 0 1 0-38 0zm44 0a19 19 0 1 0 38 0 19 19 0 1 0-38 0zM38 56a12 12 0 1 0 24 0 12 12 0 1 0-24 0zm6 0c0 19-5 30-14 38h40c-9-8-14-19-14-38z",
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
      <span className="idx">
        <b className={rank === "10" ? "ten" : undefined}>{rank}</b>
        <SuitIcon suit={suit} />
      </span>
      <SuitIcon suit={suit} className="pip" />
    </div>
  );
}

export function CardSlot({ size = "md" }: { size?: Props["size"] }) {
  return <div className={`pcard slot ${size}`} aria-hidden="true" />;
}
