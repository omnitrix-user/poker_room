import { useEffect, useState, useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import type { Action } from "@riverroom/engine";
import type { Ack, ChatMessage, ClientEventName, ErrorCode, Notice, RoomView } from "@riverroom/protocol";

export type ConnectionState = "connecting" | "live" | "reconnecting";

export interface RoomSnapshot {
  view: RoomView | null;
  conn: ConnectionState;
  /** Set when joining failed (bad code, full room, expired session…). */
  joinError: { code: ErrorCode | "unauthenticated"; message: string } | null;
  notices: (Notice & { id: number })[];
  superseded: boolean;
  /** serverTime - localTime, for rendering server deadlines. */
  clockOffset: number;
  chat: ChatMessage[];
}

const ACK_TIMEOUT_MS = 8000;

/**
 * One socket per open room. Rejoins automatically after reconnecting, keeps the latest
 * authoritative view, and exposes typed request helpers. The server is the source of
 * truth: nothing here predicts or mutates game state locally.
 */
export class RoomClient {
  private snapshot: RoomSnapshot = { view: null, conn: "connecting", joinError: null, notices: [], superseded: false, clockOffset: 0, chat: [] };
  private readonly listeners = new Set<() => void>();
  private readonly socket: Socket;
  private noticeId = 0;

  constructor(private readonly code: string) {
    this.socket = io({ transports: ["websocket", "polling"], reconnectionDelayMax: 4000 });
    this.socket.on("connect", () => void this.join());
    this.socket.on("disconnect", (reason) => {
      if (reason !== "io client disconnect") this.update({ conn: "reconnecting" });
    });
    this.socket.on("connect_error", (err) => {
      if (err.message === "unauthenticated") {
        this.socket.disconnect();
        this.update({ joinError: { code: "unauthenticated", message: "Choose a name to join this table." } });
      } else {
        this.update({ conn: "reconnecting" });
      }
    });
    this.socket.on("room:state", (view: RoomView) => this.update({ view, conn: "live", clockOffset: view.serverTime - Date.now() }));
    this.socket.on("room:notice", (n: Notice) => this.pushNotice(n));
    this.socket.on("room:chat-history", (chat: ChatMessage[]) => this.update({ chat }));
    this.socket.on("room:chat", (m: ChatMessage) => this.update({ chat: [...this.snapshot.chat.slice(-99), m] }));
    this.socket.on("room:superseded", () => {
      this.socket.disconnect();
      this.update({ superseded: true });
    });
  }

  private async join() {
    const ack = await this.request("room:join", { code: this.code });
    if (!ack.ok) {
      this.update({ joinError: { code: ack.code, message: ack.message } });
      if (ack.code !== "internal") this.socket.disconnect();
    } else this.update({ joinError: null, conn: "live" });
  }

  /** Reconnects after being superseded by another tab ("use this tab instead"). */
  reclaim() {
    this.update({ superseded: false, conn: "connecting" });
    this.socket.connect();
  }

  request(event: ClientEventName, payload: object = {}): Promise<Ack> {
    if (!this.socket.connected) return Promise.resolve({ ok: false, code: "internal", message: "You're offline. Reconnecting…" });
    return (this.socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload) as Promise<Ack>).catch(() => ({
      ok: false as const,
      code: "internal" as const,
      message: "The server didn't respond. Try again.",
    }));
  }

  /**
   * Sends a game action. The action id makes a retry safe: if the first attempt's
   * acknowledgement is lost, the server recognises the id and does not apply it twice.
   */
  async act(action: Action): Promise<Ack> {
    const g = this.snapshot.view?.game;
    if (!g) return { ok: false, code: "wrong_state", message: "There is no hand in progress." };
    const payload = { actionId: crypto.randomUUID(), handNo: g.handNo, seq: g.seq, action };
    const first = await this.request("game:action", payload);
    if (first.ok || first.code !== "internal") return first;
    await new Promise((r) => setTimeout(r, 600));
    return this.request("game:action", payload);
  }

  dismissNotice(id: number) {
    this.update({ notices: this.snapshot.notices.filter((n) => n.id !== id) });
  }

  private pushNotice(n: Notice) {
    const id = ++this.noticeId;
    this.update({ notices: [...this.snapshot.notices.slice(-3), { ...n, id }] });
    setTimeout(() => this.dismissNotice(id), 5000);
  }

  private update(patch: Partial<RoomSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = () => this.snapshot;

  destroy() {
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}

export function useRoomClient(code: string, enabled: boolean): [RoomClient | null, RoomSnapshot | null] {
  const [client, setClient] = useState<RoomClient | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const c = new RoomClient(code);
    setClient(c);
    return () => {
      c.destroy();
      setClient(null);
    };
  }, [code, enabled]);
  const snap = useSyncExternalStore(
    client?.subscribe ?? noopSubscribe,
    client?.getSnapshot ?? nullSnapshot,
  );
  return [client, snap];
}

const noopSubscribe = () => () => {};
const nullSnapshot = () => null;
