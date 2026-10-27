import { useEffect, useRef } from "react";
import type { RoomView } from "@riverroom/protocol";
import { play } from "./sound.ts";

/**
 * Turns state changes into feedback: sounds for new cards and actions, a chime when it's
 * your turn, and a tab-title alert when the page is in the background.
 */
export function useGameFeedback(view: RoomView | null) {
  const prev = useRef<{ hand: number; events: number; myTurn: boolean; settled: boolean } | null>(null);
  const g = view?.game ?? null;
  const myTurn = Boolean(g?.legal);
  // Results are settled once pots are on display (not during a staged runout).
  const settled = (g?.result?.pots.length ?? 0) > 0;

  useEffect(() => {
    if (!g) return;
    const before = prev.current;
    const sameHand = before?.hand === g.handNo;
    if (before) {
      const fresh = sameHand ? g.events.slice(before.events) : g.events;
      const last = fresh[fresh.length - 1];
      if (!sameHand) play("deal");
      else if (last?.kind === "deal") play("deal");
      else if (last?.kind === "action") play(last.action === "check" ? "check" : last.action === "fold" ? "fold" : "chip");
      if (myTurn && !(before.myTurn && sameHand)) play("turn");
      const iWon = g.result?.pots.some((p) => p.winners.some((w) => w.playerId === view!.you.playerId));
      if (settled && !(before.settled && sameHand) && iWon) setTimeout(() => play("win"), 300);
    }
    prev.current = { hand: g.handNo, events: g.events.length, myTurn, settled };
  }, [g?.handNo, g?.events.length, g?.street, myTurn, settled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Background tab: flag the title while it's your turn.
  useEffect(() => {
    const base = "RiverRoom";
    const set = () => {
      document.title = myTurn && document.hidden ? "● Your turn — RiverRoom" : base;
    };
    set();
    document.addEventListener("visibilitychange", set);
    return () => {
      document.removeEventListener("visibilitychange", set);
      document.title = base;
    };
  }, [myTurn]);
}
