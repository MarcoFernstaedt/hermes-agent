import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
const providerSource = readFileSync(new URL("./MediaProvider.tsx", import.meta.url), "utf8");

describe("native media navigation shell", () => {
  it("keeps /media in the native route and navigation registries", () => {
    expect(appSource).toContain('"/media": MediaPage');
    expect(appSource).toContain('{ path: "/media", label: "Media", icon: Music }');
  });

  it("mounts the media provider outside routed pages so the dock survives navigation", () => {
    const providerStart = appSource.indexOf("<MediaProvider>");
    const routes = appSource.indexOf("<Routes>", providerStart);
    const providerEnd = appSource.indexOf("</MediaProvider>", routes);

    expect(providerStart).toBeGreaterThan(-1);
    expect(routes).toBeGreaterThan(providerStart);
    expect(providerEnd).toBeGreaterThan(routes);
  });

  it("reserves safe-area-aware content space for the persistent mobile dock", () => {
    expect(appSource).toContain("media-dock-inset");
    // Routed content clears the tab bar + mini-player via measured heights.
    expect(stylesSource).toContain(".media-dock-inset");
    expect(stylesSource).toContain("--app-media-dock-h");
    expect(stylesSource).toContain("--app-bottom-nav-h");
    expect(stylesSource).toContain("safe-area-inset-bottom");
  });

  it("stacks the mini-player above the tab bar and floats the composer flush", () => {
    // Mini-player docks above the tab bar rather than covering it.
    expect(stylesSource).toContain(".player-dock");
    expect(stylesSource).toContain("bottom: var(--app-bottom-nav-h)");
    // Chat composer reserves exactly the dock height (none while the
    // keyboard is up, when the dock is hidden behind it).
    expect(stylesSource).toContain(".chat-dock-inset");
    expect(stylesSource).toContain(
      'html[data-media-dock="active"]:not([data-keyboard="open"]) .chat-dock-inset',
    );
    // The tab bar and mini-player publish their measured heights.
    expect(appSource).toContain("--app-bottom-nav-h");
    expect(providerSource).toContain("--app-media-dock-h");
  });
});
