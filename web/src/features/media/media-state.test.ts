import { describe, expect, it, vi } from "vitest";

import {
  createDeferredMediaStart,
  createLatestRequestGate,
  initialMediaState,
  mediaReducer,
  normalizeSpotifyProviderState,
} from "./media-state";
import type { SpotifyMediaState } from "@/lib/api";

function spotify(overrides: Partial<SpotifyMediaState>): SpotifyMediaState {
  return {
    provider: "spotify",
    status: "ready",
    message: "Ready",
    playback: null,
    capabilities: {},
    devices: [],
    queue: [],
    ...overrides,
  };
}

describe("normalizeSpotifyProviderState", () => {
  it.each([
    ["needs_auth", "disconnected"],
    ["needs_device", "empty"],
    ["degraded", "error"],
  ] as const)("maps %s to provider-neutral %s", (status, expected) => {
    expect(normalizeSpotifyProviderState(spotify({ status })).status).toBe(expected);
  });

  it("creates provider-neutral now playing metadata without raw payloads", () => {
    const normalized = normalizeSpotifyProviderState(spotify({
      playback: {
        is_playing: true,
        progress_ms: 1200,
        item: {
          name: "Track",
          uri: "spotify:track:opaque",
          duration_ms: 90000,
          artists: ["Artist"],
        },
        device: { id: "device", name: "Office", volume_percent: 50 },
      },
    }));

    expect(normalized.status).toBe("ready");
    expect(normalized.nowPlaying).toEqual({
      provider: "spotify",
      id: "spotify:track:opaque",
      title: "Track",
      subtitle: "Artist",
      durationSeconds: 90,
      positionSeconds: 1.2,
      isPlaying: true,
    });
  });
});

describe("mediaReducer", () => {
  it("rolls back rejected optimistic commands and ignores stale failures", () => {
    const ready = {
      ...initialMediaState,
      nowPlaying: {
        provider: "spotify" as const,
        id: "spotify:track:opaque",
        title: "Track",
        subtitle: "Artist",
        durationSeconds: 90,
        positionSeconds: 1,
        isPlaying: false,
      },
    };
    const pending = mediaReducer(ready, {
      type: "command-started",
      commandId: 2,
      optimisticPlaying: true,
    });

    expect(pending.nowPlaying?.isPlaying).toBe(true);
    const refreshed = mediaReducer(pending, {
      type: "spotify-loaded",
      value: {
        provider: "spotify",
        status: "ready",
        message: "Refreshed.",
        nowPlaying: ready.nowPlaying,
      },
    });
    expect(refreshed.pendingCommand).toBeNull();
    expect(refreshed.nowPlaying?.isPlaying).toBe(false);
    expect(mediaReducer(pending, {
      type: "command-rejected",
      commandId: 1,
      message: "Old failure",
    })).toBe(pending);

    const recovered = mediaReducer(pending, {
      type: "command-rejected",
      commandId: 2,
      message: "Playback command failed. Try again.",
      providerState: {
        provider: "spotify",
        status: "error",
        message: "Spotify control failed safely.",
        nowPlaying: null,
      },
    });
    expect(recovered.nowPlaying?.isPlaying).toBe(false);
    expect(recovered.spotify.status).toBe("error");
    expect(recovered.pendingCommand).toBeNull();
    expect(recovered.announcement).toBe("Playback command failed. Try again.");
  });

  it("keeps in-flight optimistic playback intact when search fails", () => {
    const ready = {
      ...initialMediaState,
      spotify: {
        provider: "spotify" as const,
        status: "ready" as const,
        message: "Ready",
        nowPlaying: {
          provider: "spotify" as const,
          id: "spotify:track:opaque",
          title: "Track",
          subtitle: "Artist",
          durationSeconds: 90,
          positionSeconds: 1,
          isPlaying: false,
        },
      },
      nowPlaying: {
        provider: "spotify" as const,
        id: "spotify:track:opaque",
        title: "Track",
        subtitle: "Artist",
        durationSeconds: 90,
        positionSeconds: 1,
        isPlaying: false,
      },
    };
    const pending = mediaReducer(ready, {
      type: "command-started",
      commandId: 7,
      optimisticPlaying: true,
    });

    const afterSearchFailure = mediaReducer(pending, {
      type: "spotify-search-failed",
      message: "Spotify search failed. Check the connection and retry.",
    });

    expect(afterSearchFailure.nowPlaying?.isPlaying).toBe(true);
    expect(afterSearchFailure.pendingCommand).toEqual(pending.pendingCommand);
    expect(afterSearchFailure.spotify.message).toBe(
      "Spotify search failed. Check the connection and retry.",
    );
  });


  it("clears audiobook playback when profile-scoped media reloads", () => {
    const reloading = mediaReducer({
      ...initialMediaState,
      nowPlaying: {
        provider: "audiobook",
        id: "chapter",
        title: "Chapter",
        subtitle: "Book",
        durationSeconds: 100,
        positionSeconds: 20,
        isPlaying: true,
      },
    }, {
      type: "audiobook-loaded",
      value: {
        provider: "audiobook",
        status: "loading",
        message: "Loading audiobook library…",
        nowPlaying: null,
      },
    });

    expect(reloading.nowPlaying).toBeNull();
  });
});

describe("createDeferredMediaStart", () => {
  it("removes a cancelled metadata listener before it can seek or play", () => {
    let listener: (() => void) | undefined;
    const audio = {
      currentTime: 0,
      addEventListener: vi.fn((_name: string, callback: () => void) => {
        listener = callback;
      }),
      removeEventListener: vi.fn(),
      play: vi.fn(async () => undefined),
    };

    const cancel = createDeferredMediaStart(audio, 42);
    cancel();
    listener?.();

    expect(audio.removeEventListener).toHaveBeenCalledWith("loadedmetadata", expect.any(Function));
    expect(audio.currentTime).toBe(0);
    expect(audio.play).not.toHaveBeenCalled();
  });
});

describe("createLatestRequestGate", () => {
  it("marks only the newest asynchronous request as current", () => {
    const gate = createLatestRequestGate();
    const first = gate.next();
    const second = gate.next();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });
});
