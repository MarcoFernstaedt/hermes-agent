/**
 * Marco's replacement for the day's suggested outcome, and where it lives.
 *
 * It was `useState(null)`. So the override survived exactly as long as the
 * component: a refresh, a route change to Progress and back, or the tab being
 * restored from the background all silently reinstated Imperator's suggestion.
 * That is worse than not offering an override at all — the owner made a
 * decision, the page acknowledged it, and then quietly reversed it when they
 * were not looking.
 *
 * Two rules the storage has to hold:
 *
 * **It is scoped to a day.** "Start with this instead" is a statement about
 * today. Carrying it into tomorrow would resurrect a choice about work that may
 * be finished, and would do so at the exact moment the owner is least expecting
 * the page to be opinionated.
 *
 * **It is scoped to a candidate that still exists.** An overridden outcome that
 * has since left the ranking — the review item was answered, the packet was
 * sent — must not suppress the suggestion for something that is still there.
 * Reading is therefore a question about the current candidates, not a bare
 * value lookup.
 */

const KEY = "imperator.now.override";

export interface StoredOverride {
  /** ISO day the choice was made for. */
  day: string;
  /** The candidate id. */
  id: string;
}

/** The local calendar day, which is the unit the owner thinks in. */
export function today(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * Decide whether a stored choice still applies.
 *
 * Exported and pure so the expiry and the disappeared-candidate cases can be
 * asserted without a browser.
 */
export function resolveOverride(
  stored: StoredOverride | null,
  args: { day: string; candidateIds: readonly string[] },
): string | null {
  if (!stored) return null;
  if (stored.day !== args.day) return null;
  return args.candidateIds.includes(stored.id) ? stored.id : null;
}

export function readStoredOverride(): StoredOverride | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as StoredOverride).day === "string" &&
      typeof (parsed as StoredOverride).id === "string"
    ) {
      return parsed as StoredOverride;
    }
    return null;
  } catch {
    // Private browsing, storage disabled, or a value someone else wrote. The
    // safe answer is "no override", which is the state the page starts in.
    return null;
  }
}

export function writeStoredOverride(id: string | null, day = today()): void {
  try {
    if (id === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify({ day, id }));
  } catch {
    // A choice that cannot be persisted still applies to this view; failing
    // the click would be a worse answer than forgetting it on reload.
  }
}
