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

export function moveMediaSourceFocus(
  sources: readonly MediaSource[],
  current: MediaSource,
  key: MediaNavigationKey,
): MediaSource {
  const currentIndex = Math.max(0, sources.indexOf(current));
  if (key === "Home") return sources[0];
  if (key === "End") return sources[sources.length - 1];
  const delta = key === "ArrowRight" ? 1 : -1;
  return sources[(currentIndex + delta + sources.length) % sources.length];
}
