import { chips } from "../lib/format.ts";

/** Denominations and their (muted, casino-standard-inspired) colours. */
const DENOMS: { value: number; body: string; edge: string }[] = [
  { value: 5000, body: "#3f5873", edge: "#d9dfe6" },
  { value: 1000, body: "#a8823f", edge: "#2a2116" },
  { value: 500, body: "#5d4670", edge: "#efe7d6" },
  { value: 100, body: "#232625", edge: "#e8e2d4" },
  { value: 25, body: "#2f6b4c", edge: "#efe7d6" },
  { value: 5, body: "#9b3a35", edge: "#efe7d6" },
  { value: 1, body: "#e9e3d5", edge: "#4f6b8a" },
];

/** Greedy breakdown into at most `max` chips; purely illustrative. */
function breakdown(amount: number, max: number) {
  const out: (typeof DENOMS)[number][] = [];
  let left = amount;
  for (const d of DENOMS) {
    while (left >= d.value && out.length < max) {
      out.push(d);
      left -= d.value;
    }
  }
  if (out.length === 0 && amount > 0) out.push(DENOMS[DENOMS.length - 1]!);
  // Largest at the bottom of the stack.
  return out.reverse();
}

export function Chip({ body, edge }: { body: string; edge: string }) {
  return (
    <svg viewBox="0 0 40 40" className="chip" aria-hidden="true">
      <circle cx="20" cy="20" r="19" fill={body} />
      <circle cx="20" cy="20" r="17" fill="none" stroke={edge} strokeWidth="4" strokeDasharray="5.2 7.15" />
      <circle cx="20" cy="20" r="11.5" fill="none" stroke={edge} strokeOpacity="0.5" strokeWidth="1" />
      <circle cx="20" cy="20" r="19" fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="1" />
    </svg>
  );
}

/** A small stack of chips with the exact amount beside it. */
export function ChipStack({ amount, label, max = 5, className = "" }: { amount: number; label?: string; max?: number; className?: string }) {
  if (amount <= 0) return null;
  const stack = breakdown(amount, max);
  return (
    <div className={`chipstack ${className}`} aria-label={label ?? chips(amount)}>
      <div className="chips" style={{ height: `calc(var(--chip) * 0.62 + ${(stack.length - 1) * 3}px)` }}>
        {stack.map((d, i) => (
          <div key={i} className="chip-wrap" style={{ bottom: i * 3 }}>
            <Chip body={d.body} edge={d.edge} />
          </div>
        ))}
      </div>
      <span className="amt num">{chips(amount)}</span>
    </div>
  );
}
