import { DEFAULT_SETTINGS, type RoomSettings } from "@riverroom/protocol";
import type { Config } from "./config.ts";
import { errInfo, log } from "./log.ts";
import type { RoomData } from "./model.ts";
import { Room } from "./room.ts";
import { newId, newRoomCode } from "./secrets.ts";
import type { Store } from "./store.ts";

/** Owns the in-memory room actors. One process holds the authoritative state for every room. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room | null>>();

  constructor(
    private readonly store: Store,
    private readonly config: Config,
  ) {}

  /** Restores every unfinished room from its snapshot (called once at boot). */
  async restoreAll(): Promise<number> {
    const ids = await this.store.liveRoomIds();
    for (const id of ids) {
      try {
        await this.load(id);
      } catch (err) {
        log.error("failed to restore room", { roomId: id, ...errInfo(err) });
      }
    }
    return this.rooms.size;
  }

  async create(hostId: string, settings: RoomSettings = DEFAULT_SETTINGS): Promise<Room> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const data: RoomData = {
        id: newId(),
        code: newRoomCode(),
        hostId,
        settings,
        status: "lobby",
        members: [],
        handsPlayed: 0,
        buttonSeat: null,
        hand: null,
        persistedEvents: 0,
        endRequested: false,
        version: 1,
      };
      try {
        await this.store.createRoom(data);
      } catch (err) {
        // Unique violation on the code: try another one.
        if ((err as { code?: string }).code === "23505") continue;
        throw err;
      }
      const room = this.track(new Room(data, this.store, this.config, (r) => this.evictLater(r)));
      return room;
    }
    throw new Error("could not allocate a room code");
  }

  async byCode(code: string): Promise<Room | "finished" | null> {
    const row = await this.store.findRoomByCode(code);
    if (!row) return null;
    if (row.status === "finished") return "finished";
    return this.rooms.get(row.id) ?? this.load(row.id);
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  private load(roomId: string): Promise<Room | null> {
    const existing = this.loading.get(roomId);
    if (existing) return existing;
    const p = (async () => {
      const data = await this.store.loadSnapshot(roomId);
      if (!data) return null;
      const room = this.track(new Room(data, this.store, this.config, (r) => this.evictLater(r)));
      await room.loadChat();
      room.resume();
      return room;
    })().finally(() => this.loading.delete(roomId));
    this.loading.set(roomId, p);
    return p;
  }

  private track(room: Room): Room {
    this.rooms.set(room.id, room);
    return room;
  }

  /** Finished rooms stay briefly so connected players see the final standings, then leave memory. */
  private evictLater(room: Room): void {
    setTimeout(() => {
      if (this.rooms.get(room.id) !== room) return;
      room.dispose();
      this.rooms.delete(room.id);
    }, 60_000).unref();
  }

  async shutdown(): Promise<void> {
    for (const room of this.rooms.values()) {
      await room.idle();
      room.dispose();
    }
    this.rooms.clear();
  }
}
