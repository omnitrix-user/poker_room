/** Indian digit grouping: 1,00,000. */
const nf = new Intl.NumberFormat("en-IN");

/** A table amount in (play-money) rupees, e.g. ₹1,00,000. */
export const chips = (n: number) => `₹${nf.format(n)}`;

/** A plain count (hands, sessions) with Indian grouping. */
export const count = (n: number) => nf.format(n);

/** Profit or loss in rupees, e.g. +₹760 / −₹260. */
export function signed(n: number): string {
  if (n === 0) return "₹0";
  return `${n > 0 ? "+" : "−"}₹${nf.format(Math.abs(n))}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const s = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2);
  return s.toUpperCase();
}

/** A stable, muted tone per player for their monogram. */
const TONES = ["#6F8F7A", "#8C7A5B", "#7B6F8F", "#5F7F8F", "#8F6F6F", "#7F8F5F", "#6F7B8F", "#8F7F6A"];
export function toneFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length]!;
}

export function relativeDate(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return `Today, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export const ACTION_VERBS: Record<string, string> = {
  fold: "folds",
  check: "checks",
  call: "calls",
  bet: "bets",
  raise: "raises to",
  allin: "goes all-in",
};
