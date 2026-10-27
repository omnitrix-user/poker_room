import { ROUND_OPTIONS, TURN_CLOCK_OPTIONS, type RoomSettings } from "@riverroom/protocol";
import { chips } from "../lib/format.ts";

export const BLIND_LEVELS: [number, number][] = [
  [1, 2],
  [5, 10],
  [10, 20],
  [25, 50],
  [50, 100],
  [100, 200],
  [500, 1000],
];
const DEPTHS = [50, 100, 200];

/** Compact table-settings fields; validation is repeated on the server. */
export function SettingsFields({ value, onChange, disabled }: { value: RoomSettings; onChange: (s: RoomSettings) => void; disabled?: boolean }) {
  const depth = Math.round(value.startingStack / value.bigBlind);
  const blindKey = `${value.smallBlind}/${value.bigBlind}`;
  const knownBlinds = BLIND_LEVELS.some(([s, b]) => `${s}/${b}` === blindKey);
  return (
    <div className="settings-grid">
      <label className="field">
        <span>Blinds</span>
        <select
          className="select num"
          disabled={disabled}
          value={blindKey}
          onChange={(e) => {
            const [sb, bb] = e.target.value.split("/").map(Number) as [number, number];
            onChange({ ...value, smallBlind: sb, bigBlind: bb, startingStack: bb * depth });
          }}
        >
          {!knownBlinds && <option value={blindKey}>{blindKey}</option>}
          {BLIND_LEVELS.map(([s, b]) => (
            <option key={b} value={`${s}/${b}`}>
              {chips(s)} / {chips(b)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Buy-in</span>
        <select
          className="select num"
          disabled={disabled}
          value={DEPTHS.includes(depth) ? depth : ""}
          onChange={(e) => onChange({ ...value, startingStack: value.bigBlind * Number(e.target.value) })}
        >
          {!DEPTHS.includes(depth) && <option value="">{chips(value.startingStack)}</option>}
          {DEPTHS.map((d) => (
            <option key={d} value={d}>
              {chips(value.bigBlind * d)} · {d}bb
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Seats</span>
        <select className="select" disabled={disabled} value={value.maxSeats} onChange={(e) => onChange({ ...value, maxSeats: Number(e.target.value) })}>
          {[2, 3, 4, 5, 6, 7, 8].map((n) => (
            <option key={n} value={n}>
              {n === 2 ? "2 (heads-up)" : n}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Turn clock</span>
        <select
          className="select"
          disabled={disabled}
          value={value.turnSeconds}
          onChange={(e) => onChange({ ...value, turnSeconds: Number(e.target.value) as RoomSettings["turnSeconds"] })}
        >
          {TURN_CLOCK_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === 0 ? "No clock" : `${s} seconds`}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Rounds</span>
        <select
          className="select"
          disabled={disabled}
          value={value.rounds}
          onChange={(e) => onChange({ ...value, rounds: Number(e.target.value) })}
        >
          {!(ROUND_OPTIONS as readonly number[]).includes(value.rounds) && <option value={value.rounds}>{value.rounds} rounds</option>}
          {ROUND_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} rounds
            </option>
          ))}
        </select>
      </label>
      <p className="field-note faint">One round is one hand dealt. Everyone can vote to play more rounds later.</p>
      <label className="check-toggle span-2">
        <input type="checkbox" disabled={disabled} checked={Boolean(value.rebuys)} onChange={(e) => onChange({ ...value, rebuys: e.target.checked })} />
        Allow rebuys — busted players can take another starting stack
      </label>
    </div>
  );
}

export function settingsSummary(s: RoomSettings): string {
  return `${chips(s.smallBlind)}/${chips(s.bigBlind)} blinds · ${chips(s.startingStack)} buy-in · ${s.rounds ? `${s.rounds} rounds · ` : ""}${s.maxSeats} seats · ${
    s.turnSeconds ? `${s.turnSeconds}s clock` : "no clock"
  } · ${s.rebuys ? "rebuys on" : "no rebuys"}`;
}
