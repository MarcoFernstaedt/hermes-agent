import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

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
    expect(stylesSource).toContain('html[data-media-dock="active"] .media-dock-inset');
    expect(stylesSource).toContain("safe-area-inset-bottom");
  });
});
