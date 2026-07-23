/**
 * The shared data cache — the one fetching + caching layer every module uses.
 *
 * Goals (deliberately a small subset of react-query/SWR, with no dependency):
 *   - Request deduplication: concurrent reads of the same key share one
 *     in-flight promise, so a list render never fans out into N identical
 *     requests.
 *   - Stale-while-revalidate: a cached value is returned immediately while a
 *     refetch happens in the background.
 *   - Background refetch: callers can revalidate on an interval or on window
 *     focus without re-plumbing their own fetch.
 *
 * This module is pure (no React) so it is unit-testable on its own; the
 * `useData` hook subscribes to it.
 */

export interface CacheEntry<T = unknown> {
  data: T | undefined;
  error: unknown;
  /** Timestamp (ms) of the last successful fetch, 0 if never. */
  updatedAt: number;
  /** In-flight fetch, if any (used for dedup). */
  promise: Promise<T> | undefined;
  /** True while a fetch is running (initial or revalidation). */
  isValidating: boolean;
}

type Listener = () => void;

const _cache = new Map<string, CacheEntry>();
const _listeners = new Map<string, Set<Listener>>();

function ensure<T>(key: string): CacheEntry<T> {
  let entry = _cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) {
    entry = { data: undefined, error: undefined, updatedAt: 0, promise: undefined, isValidating: false };
    _cache.set(key, entry as CacheEntry);
  }
  return entry;
}

function emit(key: string): void {
  const ls = _listeners.get(key);
  if (ls) for (const fn of [...ls]) fn();
}

export function getEntry<T>(key: string): CacheEntry<T> {
  return ensure<T>(key);
}

export function subscribe(key: string, fn: Listener): () => void {
  let set = _listeners.get(key);
  if (!set) {
    set = new Set();
    _listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) _listeners.delete(key);
  };
}

/**
 * Fetch `key` via `fetcher`, deduping concurrent calls and skipping a refetch
 * that lands inside `dedupeMs` of the last successful one. Returns the (shared)
 * promise. Updates the cache entry and notifies subscribers on settle.
 */
export function fetchKey<T>(
  key: string,
  fetcher: () => Promise<T>,
  dedupeMs = 2000,
): Promise<T> {
  const entry = ensure<T>(key);
  if (entry.promise) return entry.promise; // dedup: share the in-flight fetch
  if (entry.updatedAt > 0 && Date.now() - entry.updatedAt < dedupeMs && entry.error === undefined) {
    // Fresh enough — hand back the cached value without a network hit.
    return Promise.resolve(entry.data as T);
  }

  entry.isValidating = true;
  emit(key);

  const p = (async () => {
    try {
      const data = await fetcher();
      entry.data = data;
      entry.error = undefined;
      entry.updatedAt = Date.now();
      return data;
    } catch (err) {
      entry.error = err;
      throw err;
    } finally {
      entry.promise = undefined;
      entry.isValidating = false;
      emit(key);
    }
  })();

  entry.promise = p;
  return p;
}

/** Optimistically set (or clear) a key's data and notify subscribers. Passing
 *  no value clears the entry so the next read refetches. */
export function mutate<T>(key: string, data?: T): void {
  const entry = ensure<T>(key);
  if (arguments.length < 2) {
    entry.data = undefined;
    entry.updatedAt = 0;
    entry.error = undefined;
  } else {
    entry.data = data;
    entry.updatedAt = Date.now();
    entry.error = undefined;
  }
  emit(key);
}

/** Test-only: wipe cache + listeners. */
export function _resetCacheForTests(): void {
  _cache.clear();
  _listeners.clear();
}
