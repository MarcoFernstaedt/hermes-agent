/**
 * Format a token count as a human-readable string (e.g. 1M, 128K, 4096).
 * Strips trailing ".0" for clean round numbers.
 */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

/** Render a bubble timestamp; null for index-fallback pseudo-timestamps. */
export function formatMessageTime(
  timestamp: number,
  now = new Date(),
): string | null {
  const ms = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  // Hydration uses the row index when a stored message has no timestamp —
  // anything before ~2001 can't be a real message time.
  if (ms < 1_000_000_000_000) return null;
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return time;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}
