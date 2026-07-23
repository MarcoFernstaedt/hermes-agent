import { useCallback, useEffect, useRef } from "react";
import { useSyncExternalStore } from "react";

import {
  fetchKey,
  getEntry,
  mutate as cacheMutate,
  subscribe,
} from "@/lib/data-cache";

export interface UseDataOptions {
  /** Skip refetch when a successful fetch happened within this window (ms). */
  dedupeMs?: number;
  /** Revalidate this often in the background (ms). 0 disables. */
  refreshInterval?: number;
  /** Revalidate when the window/tab regains focus. Default true. */
  revalidateOnFocus?: boolean;
  /** Don't fetch at all (e.g. missing dependency). Keeps returning cache. */
  paused?: boolean;
}

export interface UseDataResult<T> {
  data: T | undefined;
  error: unknown;
  /** True on the first load when there is no cached value yet. */
  isLoading: boolean;
  /** True whenever a fetch (initial or background) is in flight. */
  isValidating: boolean;
  /** Force a revalidation now. */
  refetch: () => Promise<T | undefined>;
  /** Optimistically set (or, with no arg, clear) the cached value. */
  mutate: (data?: T) => void;
}

/**
 * Subscribe a component to a cache key, fetching via `fetcher` with
 * stale-while-revalidate + dedup + optional background refresh. Every module's
 * data reads go through this rather than rolling their own `useEffect` fetch.
 */
export function useData<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: UseDataOptions = {},
): UseDataResult<T> {
  const {
    dedupeMs = 2000,
    refreshInterval = 0,
    revalidateOnFocus = true,
    paused = false,
  } = options;

  // Keep the latest fetcher without making it a subscription dependency.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const entry = useSyncExternalStore(
    useCallback((cb) => (key ? subscribe(key, cb) : () => {}), [key]),
    () => (key ? getEntry<T>(key) : undefined),
    () => (key ? getEntry<T>(key) : undefined),
  );

  const revalidate = useCallback((): Promise<T | undefined> => {
    if (!key || paused) return Promise.resolve(entry?.data);
    return fetchKey<T>(key, () => fetcherRef.current(), dedupeMs).catch(
      () => getEntry<T>(key).data,
    );
  }, [key, paused, dedupeMs, entry?.data]);

  // Initial + key-change fetch.
  useEffect(() => {
    if (!key || paused) return;
    void revalidate();
  }, [key, paused, revalidate]);

  // Background interval refresh.
  useEffect(() => {
    if (!key || paused || refreshInterval <= 0) return;
    const id = setInterval(() => void revalidate(), refreshInterval);
    return () => clearInterval(id);
  }, [key, paused, refreshInterval, revalidate]);

  // Revalidate on focus / reconnect.
  useEffect(() => {
    if (!key || paused || !revalidateOnFocus) return;
    const onFocus = () => void revalidate();
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
    };
  }, [key, paused, revalidateOnFocus, revalidate]);

  const mutate = useCallback(
    (data?: T) => {
      if (!key) return;
      // undefined clears the entry (next read refetches); a value sets it.
      if (data === undefined) cacheMutate<T>(key);
      else cacheMutate<T>(key, data);
    },
    [key],
  );

  return {
    data: entry?.data,
    error: entry?.error,
    isLoading: !!key && entry?.data === undefined && entry?.error === undefined,
    isValidating: !!entry?.isValidating,
    refetch: revalidate,
    mutate,
  };
}
