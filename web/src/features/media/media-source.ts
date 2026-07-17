export const MEDIA_SOURCES = [
  "spotify",
  "audiobooks",
  "apple-music",
] as const;

export type MediaSource = (typeof MEDIA_SOURCES)[number];
export type MediaNavigationKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

export const SOURCE_LABELS: Record<MediaSource, string> = {
  spotify: "Spotify",
  audiobooks: "Audiobooks",
  "apple-music": "Apple Music",
};

export const DISABLED_MEDIA_SOURCES = new Set<MediaSource>(["apple-music"]);

export function isMediaSourceDisabled(source: MediaSource): boolean {
  return DISABLED_MEDIA_SOURCES.has(source);
}

export function moveMediaSourceFocus(
  sources: readonly MediaSource[],
  current: MediaSource,
  key: MediaNavigationKey,
): MediaSource {
  const enabledSources = sources.filter((source) => !isMediaSourceDisabled(source));
  if (enabledSources.length === 0) return current;
  const activeCurrent = isMediaSourceDisabled(current) ? enabledSources[0] : current;
  const currentIndex = Math.max(0, enabledSources.indexOf(activeCurrent));
  if (key === "Home") return enabledSources[0];
  if (key === "End") return enabledSources[enabledSources.length - 1];
  const delta = key === "ArrowRight" ? 1 : -1;
  return enabledSources[(currentIndex + delta + enabledSources.length) % enabledSources.length];
}
