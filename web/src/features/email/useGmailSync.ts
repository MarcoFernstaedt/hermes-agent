import { useEffect, useRef } from "react";

import { api } from "@/lib/api";

/**
 * Incremental Gmail sync via the mailbox `historyId`.
 *
 * Rather than re-listing on a timer, this polls the tiny profile endpoint for
 * the mailbox's current `historyId` (one cheap field). Only when it advances
 * does it fetch the actual delta (`/history`) and report how many messages were
 * added to the inbox — the caller decides whether to revalidate. Polling pauses
 * while the tab is hidden and never overlaps itself.
 *
 * `onDelta(added)` fires with the count of newly-added inbox messages; `added`
 * is 0 when the start id expired (too old to diff) and a full refresh is the
 * only safe response.
 */
export function useGmailSync(
  enabled: boolean,
  onDelta: (added: number) => void,
  intervalMs = 45000,
): void {
  const lastHistoryId = useRef<string | null>(null);
  const onDeltaRef = useRef(onDelta);

  useEffect(() => {
    onDeltaRef.current = onDelta;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };

    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        schedule();
        return;
      }
      try {
        const profile = await api.getEmailProfile();
        const hid = profile.historyId ?? null;
        const prev = lastHistoryId.current;
        if (hid && prev && hid !== prev) {
          const delta = await api.getEmailHistory(prev, "INBOX");
          if (!cancelled) {
            if (delta.expired) onDeltaRef.current(0);
            else if (delta.added.length) onDeltaRef.current(delta.added.length);
          }
        }
        if (hid) lastHistoryId.current = hid;
      } catch {
        // Transient (offline, reauth mid-poll) — try again next tick.
      }
      schedule();
    };

    // First tick just establishes the baseline historyId (no delta reported).
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, intervalMs]);
}
