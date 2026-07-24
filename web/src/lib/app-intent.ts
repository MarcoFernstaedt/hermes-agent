/**
 * App intents — a tiny one-shot signal bus for "do a thing on that page".
 *
 * The command palette (and anything else) can ask a module's page to perform a
 * local action it owns — open the email composer, open the new-event dialog,
 * focus the vault search — without that action's owner exposing global state.
 *
 * The wrinkle: when the palette navigates to a page and then fires the intent,
 * the page may not be mounted yet, so a plain event would be missed. So intents
 * are *latched*: `emitIntent` records the latest intent with a monotonic id and
 * a timestamp, and also dispatches a live event. A page's `useIntent` hook fires
 * on the live event when already mounted, and on mount consumes any fresh latch
 * (within a short window) it hasn't seen. Each latch is consumed exactly once.
 */

export type AppIntentName =
  | "email:compose"
  | "email:search"
  | "calendar:new-event"
  | "vault:new-note"
  | "vault:search";

interface LatchedIntent {
  id: number;
  name: AppIntentName;
  detail: unknown;
  ts: number;
}

const EVENT = "app-intent";
/** How long after emit a freshly-mounted page will still honour the latch. */
const LATCH_WINDOW_MS = 2000;

let counter = 0;
let latch: LatchedIntent | null = null;

/** Fire an intent. Latches it for pages mounting momentarily, and signals live
 *  listeners already mounted. */
export function emitIntent(name: AppIntentName, detail?: unknown): void {
  counter += 1;
  latch = { id: counter, name, detail, ts: Date.now() };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: latch }));
  }
}

/** Read (without consuming) the current latch — used by the hook on mount. */
export function peekIntentLatch(): LatchedIntent | null {
  return latch;
}

export { EVENT as APP_INTENT_EVENT, LATCH_WINDOW_MS };
export type { LatchedIntent };
