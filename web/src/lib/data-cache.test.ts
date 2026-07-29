import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetCacheForTests,
  fetchKey,
  getEntry,
  mutate,
  subscribe,
} from "./data-cache";

afterEach(() => {
  _resetCacheForTests();
  vi.useRealTimers();
});

describe("data-cache", () => {
  it("dedupes concurrent fetches of the same key", async () => {
    const fetcher = vi.fn().mockResolvedValue("v");
    const [a, b] = [fetchKey("k", fetcher), fetchKey("k", fetcher)];
    expect(await a).toBe("v");
    expect(await b).toBe("v");
    expect(fetcher).toHaveBeenCalledTimes(1); // shared in-flight promise
    expect(getEntry("k").data).toBe("v");
  });

  it("serves a fresh cached value without refetching within dedupeMs", async () => {
    const fetcher = vi.fn().mockResolvedValue("v1");
    await fetchKey("k", fetcher, 5000);
    await fetchKey("k", fetcher, 5000); // within window
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refetches once the dedupe window has passed", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");
    await fetchKey("k", fetcher, 1000);
    vi.advanceTimersByTime(1500);
    const v = await fetchKey("k", fetcher, 1000);
    expect(v).toBe("v2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stores errors and retries on the next call", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    await expect(fetchKey("k", fetcher)).rejects.toThrow("boom");
    expect(getEntry("k").error).toBeInstanceOf(Error);
    // Error entries are not "fresh", so the next call refetches immediately.
    expect(await fetchKey("k", fetcher)).toBe("ok");
    expect(getEntry("k").error).toBeUndefined();
  });

  it("notifies subscribers on settle and on mutate", async () => {
    const fetcher = vi.fn().mockResolvedValue("v");
    const cb = vi.fn();
    const unsub = subscribe("k", cb);
    await fetchKey("k", fetcher);
    expect(cb).toHaveBeenCalled(); // isValidating true -> false, at least twice
    cb.mockClear();
    mutate("k", "next");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getEntry("k").data).toBe("next");
    unsub();
    cb.mockClear();
    mutate("k", "again");
    expect(cb).not.toHaveBeenCalled(); // unsubscribed
  });

  it("mutate() with no value clears the entry so it refetches", async () => {
    const fetcher = vi.fn().mockResolvedValue("v");
    await fetchKey("k", fetcher, 9999);
    mutate("k"); // clear
    expect(getEntry("k").data).toBeUndefined();
    await fetchKey("k", fetcher, 9999); // must refetch despite dedupe window
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
