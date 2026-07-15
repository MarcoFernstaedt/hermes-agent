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
}

const entries = new Map<string, HubEntry>();

function openEntry(
  channel: string,
  listeners: Set<DashboardEventListener>,
): HubEntry {
  const entry: HubEntry = {
    stop: () => undefined,
    listeners,
    connected: false,
    everConnected: false,
    terminal: null,
  };

  entry.stop = connectResilientEventSocket({
    buildUrl: () => api.buildWsUrl("/api/events", { channel }),
    onMessage: (event) => {
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
  const next = openEntry(channel, entry.listeners);
  entries.set(channel, next);
}

/** Test-only: drop all hub state. */
export function _resetDashboardEventHub(): void {
  for (const entry of entries.values()) entry.stop();
  entries.clear();
}
