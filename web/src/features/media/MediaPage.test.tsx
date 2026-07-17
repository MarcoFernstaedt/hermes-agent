import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MediaPage } from "./MediaPage";
import { MEDIA_SOURCES, moveMediaSourceFocus } from "./media-source";

describe("MediaPage", () => {
  it("defaults to Spotify and renders exactly one tabpanel", () => {
    const html = renderToStaticMarkup(<MediaPage />);

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Media source"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="tabpanel"');
    expect(html.match(/role="tabpanel"/g)).toHaveLength(1);
    expect(html).toContain("Spotify");
    expect(html).toContain("Loading Spotify playback");
    expect(html).not.toContain("Your First Hundred Million");
  });

  it("renders the audiobook panel without rendering Spotify content", () => {
    const html = renderToStaticMarkup(<MediaPage initialSource="audiobooks" />);

    expect(html.match(/role="tabpanel"/g)).toHaveLength(1);
    expect(html).toContain("Your First Hundred Million");
    expect(html).not.toContain("Loading Spotify playback");
  });

  it("moves tab focus with arrows and Home/End", () => {
    expect(moveMediaSourceFocus(MEDIA_SOURCES, "spotify", "ArrowRight")).toBe(
      "audiobooks",
    );
    expect(
      moveMediaSourceFocus(MEDIA_SOURCES, "apple-music", "ArrowRight"),
    ).toBe("spotify");
    expect(moveMediaSourceFocus(MEDIA_SOURCES, "spotify", "ArrowLeft")).toBe(
      "apple-music",
    );
    expect(moveMediaSourceFocus(MEDIA_SOURCES, "audiobooks", "Home")).toBe(
      "spotify",
    );
    expect(moveMediaSourceFocus(MEDIA_SOURCES, "spotify", "End")).toBe(
      "apple-music",
    );
  });
});
