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

/**
 * Replace a key's entry with a *new* object carrying `patch` over the current
 * values. Entries are immutable so `useData`'s useSyncExternalStore snapshot
 * (the entry reference) actually changes on update — mutating in place would
 * leave the reference identical and React would skip the re-render, stranding
 * a component that has no other reason to re-render on the loading state.
 */
function replace<T>(key: string, patch: Partial<CacheEntry<T>>): CacheEntry<T> {
  const next = { ...ensure<T>(key), ...patch } as CacheEntry<T>;
  _cache.set(key, next as CacheEntry);
  return next;
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

  const p = (async () => {
    try {
      const data = await fetcher();
      replace<T>(key, {
        data,
        error: undefined,
        updatedAt: Date.now(),
        promise: undefined,
        isValidating: false,
      });
      emit(key);
      return data;
    } catch (err) {
      replace<T>(key, { error: err, promise: undefined, isValidating: false });
      emit(key);
      throw err;
    }
  })();

  replace<T>(key, { promise: p, isValidating: true });
  emit(key);
  return p;
}

/** Optimistically set (or clear) a key's data and notify subscribers. Passing
 *  no value clears the entry so the next read refetches. */
export function mutate<T>(key: string, data?: T): void {
  if (arguments.length < 2) {
    replace<T>(key, { data: undefined, updatedAt: 0, error: undefined });
  } else {
    replace<T>(key, { data, updatedAt: Date.now(), error: undefined });
  }
  emit(key);
}

/** Test-only: wipe cache + listeners. */
export function _resetCacheForTests(): void {
  _cache.clear();
  _listeners.clear();
}
