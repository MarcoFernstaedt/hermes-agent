import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MediaPage } from "./MediaPage";
import { MEDIA_SOURCES, moveMediaSourceFocus } from "./media-source";

describe("MediaPage", () => {
  it("defaults to Spotify and renders valid tab panels", () => {
    const html = renderToStaticMarkup(<MediaPage />);

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Media source"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="tabpanel"');
    expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
    expect(html).toContain('aria-controls="media-panel-spotify"');
    expect(html).toContain('id="media-panel-spotify"');
    expect(html).toContain('aria-controls="media-panel-audiobooks"');
    expect(html).toContain('id="media-panel-audiobooks"');
    expect(html).toContain('aria-controls="media-panel-apple-music"');
    expect(html).toContain('id="media-panel-apple-music"');
    expect(html).toContain("Spotify");
    expect(html).toContain("Loading Spotify playback");
    expect(html).not.toContain("Your First Hundred Million");
  });

  it("renders the audiobook panel without rendering Spotify content", () => {
    const html = renderToStaticMarkup(<MediaPage initialSource="audiobooks" />);

    expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
    expect(html).toContain("Audiobook library");
    expect(html).toContain("Loading audiobook library");
    expect(html).not.toContain("Loading Spotify playback");
  });

  it("moves tab focus with arrows and Home/End without activating disabled sources", () => {
    expect(moveMediaSourceFocus(MEDIA_SOURCES, "spotify", "ArrowRight")).toBe(
      "audiobooks",
    );
    expect(
      moveMediaSourceFocus(MEDIA_SOURCES, "audiobooks", "ArrowRight"),
    ).toBe("spotify");
    expect(moveMediaSourceFocus(MEDIA_SOURCES, "spotify", "ArrowLeft")).toBe(
      "audiobooks",
    );
    expect(moveMediaSourceFocus(MEDIA_SOURCES, "audiobooks", "Home")).toBe(
      "spotify",
    );
    expect(moveMediaSourceFocus(MEDIA_SOURCES, "spotify", "End")).toBe(
      "audiobooks",
    );
  });
});
