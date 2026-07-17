/**
 * Windowed hydration plans for the chat feed.
 *
 * A conversation spans a CHAIN of stored sessions (resume runs continue
 * under child ids). Hydrating everything up front makes long histories
 * slow and heavy, so the feed loads a window of the NEWEST messages
 * first and pages older ones in as the user scrolls up.
 *
 * These helpers are pure: given per-session message counts (chain order,
 * oldest session first) they plan which (session, offset, limit) pages to
 * fetch. A cursor marks where the next older page ends; `null` cursor =
 * the beginning of the session has been reached.
 */

export const HISTORY_PAGE_SIZE = 60;

export interface PageFetch {
  chainIndex: number;
  offset: number;
  limit: number;
}

export interface ChainCursor {
  chainIndex: number;
  /** Number of messages remaining before the loaded region in that session. */
  offset: number;
}

function cursorBefore(
  counts: number[],
  chainIndex: number,
  remaining: number,
): ChainCursor | null {
  if (remaining > 0) return { chainIndex, offset: remaining };
  for (let i = chainIndex - 1; i >= 0; i--) {
    if (counts[i] > 0) return { chainIndex: i, offset: counts[i] };
  }
  return null;
}

/** Plan the initial window: the newest `pageSize` messages across the chain. */
export function planInitialWindow(
  counts: number[],
  pageSize = HISTORY_PAGE_SIZE,
): { fetches: PageFetch[]; cursor: ChainCursor | null } {
  const fetches: PageFetch[] = [];
  let need = pageSize;
  for (let i = counts.length - 1; i >= 0 && need > 0; i--) {
    const take = Math.min(need, counts[i]);
    if (take <= 0) continue;
    fetches.push({ chainIndex: i, offset: counts[i] - take, limit: take });
    need -= take;
    if (need === 0) {
      return {
        fetches: fetches.sort((a, b) => a.chainIndex - b.chainIndex),
        cursor: cursorBefore(counts, i, counts[i] - take),
      };
    }
  }
  return {
    fetches: fetches.sort((a, b) => a.chainIndex - b.chainIndex),
    cursor: null,
  };
}

/** Plan the next older page from a cursor. */
export function planOlderPage(
  counts: number[],
  cursor: ChainCursor,
  pageSize = HISTORY_PAGE_SIZE,
): { fetch: PageFetch; cursor: ChainCursor | null } {
  const take = Math.min(pageSize, cursor.offset);
  const offset = cursor.offset - take;
  return {
    fetch: { chainIndex: cursor.chainIndex, offset, limit: take },
    cursor: cursorBefore(counts, cursor.chainIndex, offset),
  };
}
