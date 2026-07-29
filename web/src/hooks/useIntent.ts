import { useEffect, useRef } from "react";

import {
  APP_INTENT_EVENT,
  LATCH_WINDOW_MS,
  peekIntentLatch,
  type AppIntentName,
  type LatchedIntent,
} from "@/lib/app-intent";

/**
 * Subscribe a page to an app intent (see lib/app-intent.ts).
 *
 * Fires `handler(detail)` once per emitted intent of `name`, whether the page
 * was already mounted (live event) or is mounting just after the palette fired
 * (fresh latch, consumed once). The handler is kept in a ref so subscribing
 * doesn't churn on every render.
 */
export function useIntent(
  name: AppIntentName,
  handler: (detail: unknown) => void,
): void {
  const handlerRef = useRef(handler);
  // Highest latch id this hook instance has already acted on.
  const consumedRef = useRef(0);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const act = (intent: LatchedIntent) => {
      if (intent.name !== name) return;
      if (intent.id <= consumedRef.current) return;
      consumedRef.current = intent.id;
      handlerRef.current(intent.detail);
    };

    // Catch a latch set moments ago (palette navigated, then emitted, then we
    // mounted). Ignore stale latches so an old intent doesn't re-trigger.
    const pending = peekIntentLatch();
    if (pending && Date.now() - pending.ts <= LATCH_WINDOW_MS) {
      act(pending);
    }

    const onEvent = (event: Event) => {
      const intent = (event as CustomEvent<LatchedIntent>).detail;
      if (intent) act(intent);
    };
    window.addEventListener(APP_INTENT_EVENT, onEvent);
    return () => window.removeEventListener(APP_INTENT_EVENT, onEvent);
  }, [name]);
}
