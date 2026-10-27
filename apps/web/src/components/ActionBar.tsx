import { useEffect, useMemo, useRef, useState } from "react";
import { describeHand, evaluateBest, type Action, type Card } from "@riverroom/engine";
import type { Ack, ClientEventName, RoomView } from "@riverroom/protocol";
import { chips } from "../lib/format.ts";

interface Props {
  view: RoomView;
  onAction: (action: Action) => Promise<Ack>;
  onRequest: (event: ClientEventName, payload?: object) => Promise<Ack>;
  clockOffset: number;
}

type PreKind = "checkfold" | "check" | "call" | "callany";
interface PreAction {
  kind: PreKind;
  handNo: number;
  street: string;
  /** For check/call: the bet level it was chosen against; a new bet cancels it. */
  bet: number;
  amount: number;
}

export function ActionBar({ view, onAction, onRequest, clockOffset }: Props) {
  const game = view.game;
  const me = game?.players.find((p) => p.playerId === view.you.playerId);
  const legal = game?.legal ?? null;
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pre, setPre] = useState<PreAction | null>(null);
  const turnKey = game ? `${game.handNo}:${game.seq}` : "";

  useEffect(() => {
    setError(null);
    setPending(null);
  }, [turnKey]);

  async function send(action: Action, label: string) {
    if (pending) return;
    setPending(label);
    setError(null);
    const ack = await onAction(action);
    if (!ack.ok) {
      setError(ack.message);
      setPending(null);
    }
    // On success the next server state arrives and resets `pending` via turnKey.
  }

  // Pre-actions fire the moment the turn arrives, if they still make sense.
  const preValid =
    pre && game && pre.handNo === game.handNo && pre.street === game.street && (pre.kind === "checkfold" || pre.kind === "callany" || pre.bet === game.currentBet);
  useEffect(() => {
    if (!legal || !pre) return;
    const p = pre;
    setPre(null);
    if (!preValid) return;
    if (p.kind === "checkfold") void send(legal.canCheck ? { type: "check" } : { type: "fold" }, "pre");
    else if (p.kind === "callany") void send(legal.canCheck ? { type: "check" } : { type: "call" }, "pre");
    else if (p.kind === "check" && legal.canCheck) void send({ type: "check" }, "pre");
    else if (p.kind === "call" && !legal.canCheck && legal.callAmount === p.amount) void send({ type: "call" }, "pre");
  }, [legal]); // eslint-disable-line react-hooks/exhaustive-deps

  if (view.status !== "playing" || !game) return null;

  const handText = me?.cards && me.status !== "folded" ? strength(me.cards, game.board) : null;

  if (!legal || !me) {
    const canPre = me && me.status === "active" && game.street !== "complete";
    return (
      <div className="actionbar idle" aria-live="polite">
        <div className="idle-main">
          <WaitingLine view={view} clockOffset={clockOffset} />
          {handText && <span className="hand-strength">{handText}</span>}
        </div>
        {canPre && <PreActions view={view} pre={preValid ? pre : null} setPre={setPre} />}
        <TableControls view={view} onRequest={onRequest} />
      </div>
    );
  }

  return (
    <div className="actionbar live" role="region" aria-label="Your action">
      <div className="action-head">
        <span className="your-turn">Your turn</span>
        {handText && <span className="hand-strength">{handText}</span>}
        <span className="faint num behind">{chips(me.stack)} behind</span>
      </div>
      <BetControls key={turnKey} legal={legal} game={game} myStreetBet={me.streetBet} myStack={me.stack} pending={pending} send={send} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PreActions({ view, pre, setPre }: { view: RoomView; pre: PreAction | null; setPre: (p: PreAction | null) => void }) {
  const game = view.game!;
  const me = game.players.find((p) => p.playerId === view.you.playerId)!;
  const toCall = Math.min(game.currentBet - me.streetBet, me.stack);
  const base = { handNo: game.handNo, street: game.street, bet: game.currentBet, amount: toCall };
  const options: { kind: PreKind; label: string }[] =
    toCall > 0
      ? [
          { kind: "checkfold", label: "Fold" },
          { kind: "call", label: `Call ${chips(toCall)}` },
          { kind: "callany", label: "Call any" },
        ]
      : [
          { kind: "checkfold", label: "Check/Fold" },
          { kind: "check", label: "Check" },
          { kind: "callany", label: "Call any" },
        ];
  return (
    <div className="pre-actions" role="group" aria-label="Act in advance">
      {options.map((o) => {
        const on = pre?.kind === o.kind;
        return (
          <button
            key={o.kind}
            type="button"
            className={`btn btn-sm pre ${on ? "on" : ""}`}
            aria-pressed={on}
            onClick={() => setPre(on ? null : { ...base, kind: o.kind })}
          >
            <span className="box" aria-hidden="true" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Between-hand controls: show your cards, rebuy, sit out / come back. */
function TableControls({ view, onRequest }: { view: RoomView; onRequest: Props["onRequest"] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const game = view.game!;
  const meSeat = view.players.find((p) => p.playerId === view.you.playerId);
  const meHand = game.players.find((p) => p.playerId === view.you.playerId);
  if (!meSeat || meSeat.left) return null;
  const complete = game.street === "complete";
  // Nothing to decide while an all-in runout is still being revealed.
  if (complete && !game.result?.pots.length) return null;
  const shownAlready = Boolean(game.result?.shown.some((s) => s.playerId === view.you.playerId)) || Boolean(meHand?.showedByChoice);
  const canShow = complete && meHand && !shownAlready;
  const inLiveHand = Boolean(meHand) && !complete;
  const canRebuy = view.settings.rebuys && meSeat.stack === 0 && !inLiveHand;

  async function run(label: string, event: ClientEventName, payload?: object) {
    setBusy(label);
    setError(null);
    const ack = await onRequest(event, payload);
    setBusy(null);
    if (!ack.ok) setError(ack.message);
  }

  return (
    <div className="table-controls">
      {canShow && (
        <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => run("show", "game:show", { handNo: game.handNo })}>
          Show cards
        </button>
      )}
      {canRebuy && (
        <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => run("rebuy", "room:rebuy")}>
          Rebuy <span className="num">{chips(view.settings.startingStack)}</span>
        </button>
      )}
      {meSeat.stack > 0 &&
        (meSeat.sittingOut ? (
          <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => run("back", "room:sitout", { sitOut: false })}>
            I'm back
          </button>
        ) : (
          <label className="check-toggle">
            <input type="checkbox" checked={false} disabled={!!busy} onChange={() => run("out", "room:sitout", { sitOut: true })} />
            Sit out next hand
          </label>
        ))}
      {error && (
        <span className="error-text" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function strength(cards: Card[], board: Card[]): string | null {
  if (board.length >= 3) return describeHand(evaluateBest([...cards, ...board]));
  if (cards[0]?.[0] === cards[1]?.[0]) return "Pocket pair";
  return null;
}

function WaitingLine({ view, clockOffset }: { view: RoomView; clockOffset: number }) {
  const game = view.game!;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!view.nextHandAt) return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [view.nextHandAt]);
  const name = (seat: number | null) => view.players.find((p) => p.seat === seat)?.name;
  const me = game.players.find((p) => p.playerId === view.you.playerId);
  const meSeat = view.players.find((p) => p.playerId === view.you.playerId);
  let text: string;
  if (view.waitingFor) text = view.waitingFor;
  else if (game.street === "complete" && !game.result?.pots.length) text = "All-in — running it out…";
  else if (game.street === "complete") {
    const secs = view.nextHandAt ? Math.max(0, Math.ceil((view.nextHandAt - Date.now() - clockOffset) / 1000)) : null;
    text = view.endRequested ? "Final hand complete." : secs !== null ? `Next hand in ${secs}s` : "Hand complete";
  } else if (!me) text = view.you.seat === null ? "Watching" : meSeat?.sittingOut ? "You're sitting out" : meSeat?.stack === 0 ? "You're out of chips" : "You'll be dealt in next hand";
  else if (me.status === "folded") text = `You folded · ${name(game.toActSeat) ?? "Someone"} to act`;
  else if (me.status === "allin") text = "You're all-in";
  else text = `Waiting for ${name(game.toActSeat) ?? "the next player"}…`;
  return <span className="waiting">{text}</span>;
}

interface BetProps {
  legal: NonNullable<NonNullable<RoomView["game"]>["legal"]>;
  game: NonNullable<RoomView["game"]>;
  myStreetBet: number;
  myStack: number;
  pending: string | null;
  send: (a: Action, label: string) => void;
}

function BetControls({ legal, game, myStreetBet, myStack, pending, send }: BetProps) {
  const min = legal.minRaiseTo;
  const max = legal.maxRaiseTo;
  const [raw, setRaw] = useState(String(min));
  const inputRef = useRef<HTMLInputElement>(null);
  const amount = Number(raw);
  const valid = legal.raiseKind !== null && Number.isInteger(amount) && amount >= min && amount <= max;
  const kind = legal.raiseKind;
  const callIsAllIn = legal.callAmount > 0 && legal.callAmount >= myStack;

  const presets = useMemo(() => {
    if (!kind) return [];
    // Pot-sized raise: call first, then raise by the size of the pot.
    const potAfterCall = game.potTotal + legal.callAmount;
    const make = (label: string, fraction: number) => {
      const target = Math.round(game.currentBet + potAfterCall * fraction);
      return { label, value: Math.min(max, Math.max(min, target)) };
    };
    const list = [{ label: "Min", value: min }, make("½ pot", 0.5), make("¾ pot", 0.75), make("Pot", 1), { label: "All-in", value: max }];
    return list.filter((p, i) => i === 0 || i === list.length - 1 || (p.value > min && p.value < max));
  }, [kind, game.potTotal, game.currentBet, legal.callAmount, min, max]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (typing || e.metaKey || e.ctrlKey || e.altKey || pending) return;
      const k = e.key.toLowerCase();
      if (k === "f" && !legal.canCheck) send({ type: "fold" }, "fold");
      else if (k === "c") legal.canCheck ? send({ type: "check" }, "check") : send({ type: "call" }, "call");
      else if (k === "r" && kind) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [legal, kind, pending, send]);

  const raise = () => {
    if (!valid || !kind) return;
    send(amount === max ? { type: "allin" } : { type: kind, amount }, "raise");
  };
  const busy = (label: string) => (pending === label ? "…" : null);

  return (
    <div className="bet-controls">
      <div className="primary-actions">
        {!legal.canCheck && (
          <button type="button" className="btn act fold" disabled={!!pending} onClick={() => send({ type: "fold" }, "fold")} aria-keyshortcuts="F">
            {busy("fold") ?? "Fold"}
          </button>
        )}
        {legal.canCheck ? (
          <button type="button" className="btn act check" disabled={!!pending} onClick={() => send({ type: "check" }, "check")} aria-keyshortcuts="C">
            {busy("check") ?? "Check"}
          </button>
        ) : (
          <button type="button" className="btn act call" disabled={!!pending} onClick={() => send({ type: "call" }, "call")} aria-keyshortcuts="C">
            {busy("call") ?? (
              <>
                {callIsAllIn ? "Call all-in" : "Call"} <span className="num">{chips(legal.callAmount)}</span>
              </>
            )}
          </button>
        )}
        {kind && (
          <button type="button" className="btn act raise btn-primary" disabled={!!pending || !valid} onClick={raise} aria-keyshortcuts="R">
            {busy("raise") ??
              (valid && amount === max ? (
                <>
                  All-in <span className="num">{chips(max)}</span>
                </>
              ) : (
                <>
                  {kind === "bet" ? "Bet" : "Raise to"} <span className="num">{valid ? chips(amount) : "—"}</span>
                </>
              ))}
          </button>
        )}
      </div>

      {kind && min < max && (
        <div className="raise-row">
          <div className="presets" role="group" aria-label="Bet size presets">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`btn btn-sm preset ${amount === p.value ? "on" : ""}`}
                disabled={!!pending}
                onClick={() => setRaw(String(p.value))}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="range"
            className="slider"
            min={min}
            max={max}
            step={1}
            value={valid ? amount : min}
            onChange={(e) => setRaw(e.target.value)}
            aria-label={`${kind === "bet" ? "Bet" : "Raise to"} amount`}
            disabled={!!pending}
          />
          <label className="amount-field">
            <span className="sr-only">{kind === "bet" ? "Bet amount" : "Raise to amount"}</span>
            <input
              ref={inputRef}
              className="input num"
              inputMode="numeric"
              value={raw}
              onChange={(e) => setRaw(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") raise();
                if (e.key === "Escape") (e.target as HTMLInputElement).blur();
              }}
              disabled={!!pending}
              aria-invalid={!valid}
            />
          </label>
        </div>
      )}
      {kind && (
        <p className="raise-hint faint num">
          {valid ? (
            <>
              {kind === "raise" ? `Raise to ${chips(amount)} total this round` : `Bet ${chips(amount)}`}
              {myStreetBet > 0 && ` · puts in ${chips(amount - myStreetBet)} more (${chips(myStreetBet)} already in front)`}
              {kind === "raise" && myStreetBet === 0 && ` · puts in ${chips(amount)}`}
            </>
          ) : (
            `Enter ${chips(min)}–${chips(max)}`
          )}
        </p>
      )}
    </div>
  );
}
