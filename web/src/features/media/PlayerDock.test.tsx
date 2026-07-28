import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlayerDockView } from "./MediaProvider";
import { initialMediaState } from "./media-state";

describe("PlayerDockView", () => {
  it("renders mobile-accessible persistent controls and a live recovery region", () => {
    const html = renderToStaticMarkup(
      <PlayerDockView
        state={{
          ...initialMediaState,
          nowPlaying: {
            provider: "spotify",
            id: "spotify:track:opaque",
            title: "Track",
            subtitle: "Artist",
            durationSeconds: 120,
            positionSeconds: 30,
            isPlaying: true,
          },
          announcement: "Playback restored.",
        }}
        spotify={{
          provider: "spotify",
          status: "ready",
          message: "Ready",
          playback: null,
          capabilities: { seek: true, volume: true },
          devices: [],
          queue: [],
        }}
        audioRef={createRef<HTMLAudioElement>()}
        selectedChapter={null}
        onControlSpotify={async () => undefined}
        onNextAudiobook={() => undefined}
        onTimeUpdate={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Persistent media player"');
    expect(html).toContain('aria-label="Pause media"');
    expect(html).toContain('aria-label="Seek track"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Playback restored.");
    expect(html).not.toContain("access_token");
  });
});
