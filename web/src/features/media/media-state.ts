import type { SpotifyMediaState } from "@/lib/api";

export type MediaProvider = "spotify" | "audiobook";
export type ProviderStatus =
  | "loading"
  | "disconnected"
  | "empty"
  | "ready"
  | "stale"
  | "error";

export interface NowPlaying {
  provider: MediaProvider;
  id: string;
  title: string;
  subtitle: string;
  durationSeconds: number;
  positionSeconds: number;
  isPlaying: boolean;
}

export interface NormalizedProviderState {
  provider: MediaProvider;
  status: ProviderStatus;
  message: string;
  nowPlaying: NowPlaying | null;
}

export interface MediaState {
  spotify: NormalizedProviderState;
  audiobook: NormalizedProviderState;
  nowPlaying: NowPlaying | null;
  pendingCommand: { id: number; rollback: NowPlaying | null } | null;
  announcement: string;
}

export const initialMediaState: MediaState = {
  spotify: {
    provider: "spotify",
    status: "loading",
    message: "Loading Spotify playback…",
    nowPlaying: null,
  },
  audiobook: {
    provider: "audiobook",
    status: "loading",
    message: "Loading audiobook library…",
    nowPlaying: null,
  },
  nowPlaying: null,
  pendingCommand: null,
  announcement: "",
};

export function normalizeSpotifyProviderState(
  state: SpotifyMediaState,
): NormalizedProviderState {
  const status: ProviderStatus =
    state.status === "needs_auth"
      ? "disconnected"
      : state.status === "needs_device"
        ? "empty"
        : state.status === "degraded"
          ? "error"
          : state.playback?.item
            ? "ready"
            : "empty";
  const item = state.playback?.item;
  const nowPlaying: NowPlaying | null = item
    ? {
        provider: "spotify",
        id: item.uri ?? `spotify:${item.name ?? "unknown"}`,
        title: item.name ?? "Unknown track",
        subtitle: item.artists.join(", ") || "Unknown artist",
        durationSeconds: Math.max(0, (item.duration_ms ?? 0) / 1000),
        positionSeconds: Math.max(0, (state.playback?.progress_ms ?? 0) / 1000),
        isPlaying: Boolean(state.playback?.is_playing),
      }
    : null;
  return {
    provider: "spotify",
    status,
    message: state.message,
    nowPlaying,
  };
}

export type MediaAction =
  | { type: "spotify-loaded"; value: NormalizedProviderState }
  | { type: "spotify-failed"; message: string }
  | { type: "spotify-search-failed"; message: string }
  | { type: "audiobook-loaded"; value: NormalizedProviderState }
  | { type: "now-playing"; value: NowPlaying | null; announcement?: string }
  | { type: "position"; value: number; isPlaying?: boolean }
  | { type: "command-started"; commandId: number; optimisticPlaying?: boolean }
  | { type: "command-resolved"; commandId: number; value: NormalizedProviderState }
  | {
      type: "command-rejected";
      commandId: number;
      message: string;
      providerState?: NormalizedProviderState;
    };

export function mediaReducer(state: MediaState, action: MediaAction): MediaState {
  switch (action.type) {
    case "spotify-loaded":
      return {
        ...state,
        spotify: action.value,
        nowPlaying:
          state.nowPlaying?.provider === "audiobook"
            ? state.nowPlaying
            : action.value.nowPlaying,
        pendingCommand: null,
        announcement: action.value.message,
      };
    case "spotify-failed":
      return {
        ...state,
        spotify: {
          ...state.spotify,
          status: state.spotify.nowPlaying ? "stale" : "error",
          message: action.message,
        },
        nowPlaying: state.pendingCommand?.rollback ?? state.nowPlaying,
        pendingCommand: null,
        announcement: action.message,
      };
    case "spotify-search-failed":
      return {
        ...state,
        spotify: {
          ...state.spotify,
          status: state.spotify.nowPlaying ? "stale" : state.spotify.status,
          message: action.message,
        },
        announcement: action.message,
      };
    case "audiobook-loaded":
      return {
        ...state,
        audiobook: action.value,
        nowPlaying:
          action.value.status === "loading" && state.nowPlaying?.provider === "audiobook"
            ? null
            : state.nowPlaying,
      };
    case "now-playing":
      return {
        ...state,
        nowPlaying: action.value,
        announcement: action.announcement ?? state.announcement,
      };
    case "position":
      if (!state.nowPlaying) return state;
      return {
        ...state,
        nowPlaying: {
          ...state.nowPlaying,
          positionSeconds: Math.max(0, action.value),
          isPlaying: action.isPlaying ?? state.nowPlaying.isPlaying,
        },
      };
    case "command-started":
      return {
        ...state,
        nowPlaying:
          state.nowPlaying && action.optimisticPlaying !== undefined
            ? { ...state.nowPlaying, isPlaying: action.optimisticPlaying }
            : state.nowPlaying,
        pendingCommand: { id: action.commandId, rollback: state.nowPlaying },
      };
    case "command-resolved":
      if (state.pendingCommand?.id !== action.commandId) return state;
      return {
        ...state,
        spotify: action.value,
        nowPlaying: action.value.nowPlaying,
        pendingCommand: null,
        announcement: action.value.message,
      };
    case "command-rejected":
      if (state.pendingCommand?.id !== action.commandId) return state;
      return {
        ...state,
        spotify: action.providerState ?? state.spotify,
        nowPlaying: state.pendingCommand.rollback,
        pendingCommand: null,
        announcement: action.message,
      };
  }
}

export function createLatestRequestGate() {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (requestId: number) => requestId === current,
  };
}

interface DeferredAudio {
  currentTime: number;
  addEventListener(name: "loadedmetadata", callback: () => void): void;
  removeEventListener(name: "loadedmetadata", callback: () => void): void;
  play(): Promise<unknown>;
}

export function createDeferredMediaStart(
  audio: DeferredAudio,
  positionSeconds: number,
): () => void {
  let active = true;
  const onLoaded = () => {
    audio.removeEventListener("loadedmetadata", onLoaded);
    if (!active) return;
    active = false;
    audio.currentTime = Math.max(0, positionSeconds);
    void audio.play().catch(() => undefined);
  };
  audio.addEventListener("loadedmetadata", onLoaded);
  return () => {
    if (!active) return;
    active = false;
    audio.removeEventListener("loadedmetadata", onLoaded);
  };
}
