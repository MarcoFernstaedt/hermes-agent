import { api } from "./api";
import {
  connectResilientEventSocket,
  isTerminalDashboardEventFailure,
  type EventSocketFailure,
} from "./resilient-event-socket";

/**
 * Shared, ref-counted subscription to the dashboard's `/api/events`
 * channel stream.
 *
 * ChatPage (bubble-feed projection) and ChatSidebar (model/tools panel)
 * both consume the same per-channel broadcast. Before this hub each opened
 * its own WebSocket — two sockets, two auth tickets, two independent
 * reconnect cadences per chat tab. The hub multiplexes every consumer of a
 * channel onto one resilient socket: the first subscriber opens it, later
 * subscribers fan in (and immediately learn the current connection state),
 * and the last unsubscribe closes it.
 */

export interface DashboardEventListener {
  onMessage(event: MessageEvent): void;
  onConnected?(reconnected: boolean): void;
  onDisconnected?(code: number | null): void;
  onTerminalFailure?(failure: EventSocketFailure): void;
}

interface HubEntry {
  stop: () => void;
  listeners: Set<DashboardEventListener>;
  connected: boolean;
  everConnected: boolean;
  terminal: EventSocketFailure | null;
  /** Highest `_seq` seen on this channel; drives dedup + reconnect catch-up. */
  lastSeq: number;
}

const entries = new Map<string, HubEntry>();

/** Pull the server's monotonic `_seq` off a frame, or null (heartbeat/raw). */
function extractSeq(data: unknown): number | null {
  if (typeof data !== "string") return null;
  try {
    const obj = JSON.parse(data);
    return obj && typeof obj._seq === "number" ? obj._seq : null;
  } catch {
    return null;
  }
}

function openEntry(
  channel: string,
  listeners: Set<DashboardEventListener>,
  lastSeq = 0,
): HubEntry {
  const entry: HubEntry = {
    stop: () => undefined,
    listeners,
    connected: false,
    everConnected: false,
    terminal: null,
    lastSeq,
  };

  entry.stop = connectResilientEventSocket({
    // On (re)connect, ask the server to replay everything past the last
    // sequence we saw — invisible catch-up after a drop or on a 2nd device.
    buildUrl: () =>
      api.buildWsUrl(
        "/api/events",
        entry.lastSeq > 0
          ? { channel, since: String(entry.lastSeq) }
          : { channel },
      ),
    onMessage: (event) => {
      const seq = extractSeq(event.data);
      if (seq !== null) {
        // Drop duplicates from a replay/live overlap; advance the cursor.
        if (seq <= entry.lastSeq) return;
        entry.lastSeq = seq;
      }
      for (const listener of [...entry.listeners]) listener.onMessage(event);
    },
    onConnected: (reconnected) => {
      entry.connected = true;
      entry.everConnected = true;
      entry.terminal = null;
      for (const listener of [...entry.listeners]) {
        listener.onConnected?.(reconnected);
      }
    },
    onDisconnected: (code) => {
      entry.connected = false;
      for (const listener of [...entry.listeners]) {
        listener.onDisconnected?.(code);
      }
    },
    isTerminalFailure: isTerminalDashboardEventFailure,
    onTerminalFailure: (failure) => {
      entry.connected = false;
      entry.terminal = failure;
      for (const listener of [...entry.listeners]) {
        listener.onTerminalFailure?.(failure);
      }
    },
  });

  return entry;
}

/**
 * Subscribe to a channel's event stream. Returns an unsubscribe function.
 * Late joiners are synchronously told the current state — `onConnected`
 * when the shared socket is already live, `onTerminalFailure` when it has
 * permanently failed — so a component mounting mid-session renders the
 * right status without waiting for the next transition.
 */
export function subscribeDashboardEvents(
  channel: string,
  listener: DashboardEventListener,
): () => void {
  let entry = entries.get(channel);
  if (!entry) {
    entry = openEntry(channel, new Set());
    entries.set(channel, entry);
  }
  entry.listeners.add(listener);

  if (entry.connected) {
    listener.onConnected?.(false);
  } else if (entry.terminal) {
    listener.onTerminalFailure?.(entry.terminal);
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    // The listener Set is carried by reference across restartDashboardEvents
    // swaps, so deleting from the subscribe-time entry covers every
    // generation of the socket.
    entry.listeners.delete(listener);
    const active = entries.get(channel);
    if (active && active.listeners.size === 0) {
      active.stop();
      entries.delete(channel);
    }
  };
}

/**
 * Tear down and re-open a channel's shared socket, keeping the current
 * listeners attached. This is the manual "reconnect" affordance: after a
 * terminal failure the resilient loop stops retrying on purpose, so a
 * user-initiated retry needs a fresh socket cycle.
 */
export function restartDashboardEvents(channel: string): void {
  const entry = entries.get(channel);
  if (!entry) return;
  entry.stop();
  // Carry the sequence cursor across the restart so the fresh socket
  // replays only what was missed rather than re-delivering the stream.
  const next = openEntry(channel, entry.listeners, entry.lastSeq);
  entries.set(channel, next);
}

/** Test-only: drop all hub state. */
export function _resetDashboardEventHub(): void {
  for (const entry of entries.values()) entry.stop();
  entries.clear();
}
