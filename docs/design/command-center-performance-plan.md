# Imperator Command Center — Performance & Engineering Plan

A living plan for keeping the dashboard fast as it grows. Split into
what is DONE (shipped, verified), and the NEXT candidates ranked by
leverage. The rule for additions: measure first, cache close to the
user, ship less JavaScript, never regress the chat's time-to-interactive.

## Baseline (measured 2026-07)

| Surface | Size (raw) | Notes |
|---|---|---|
| `index-*.js` (core: React, router, xterm, chat) | ~1.2 MB | ~340 KB gzipped |
| Shared UI chunk | ~376 KB | loaded with first lazy page |
| Docs page + manifest | ~108 KB + 66 KB | lazy, per-page raw-md chunks |
| Everything else | ≤ 120 KB each | 400+ lazy chunks (pages, doc bodies) |

## Done

- **Route-level code splitting** — every page except the persistent
  ChatPage is `lazy()`; doc bodies and the docs manifest load only on
  the Docs route; media, jobs, settings are all their own chunks.
- **Immutable asset caching** — Vite emits content-hashed filenames, so
  `/assets/*` now serves `Cache-Control: public, max-age=31536000,
  immutable`; repeat visits skip revalidation entirely. `index.html`
  stays `no-store` (it carries the session token and current hashes) so
  deploys land on the next reload. Icons/fonts/manifest cache for a day.
- **GZip on the wire** — `_SelectiveGZipMiddleware` compresses HTML,
  JS, CSS, and JSON (~70% smaller main bundle transfer). Byte-range
  audio streams and file downloads are exempt: gzipping a 206 response
  corrupts `Content-Range` offsets.
- **Windowed data everywhere** — chat history hydrates the newest page
  and pages older messages on scroll; sessions/files lists load in
  windows with sentinel-triggered fetches; the analytics/log surfaces
  cap line counts. No unbounded renders remain.
- **One socket per concern** — `/api/events` is multiplexed through a
  ref-counted hub (event-channel-hub) so N components share one
  WebSocket; PTY and RPC sidecars are single instances.
- **Perceived speed** — skeleton/spinner states on every page, smooth
  scroll-to-latest on chat open, scroll anchoring on prepends,
  back-to-top affordances, `prefers-reduced-motion` respected.

## Next (ranked)

1. **Vendor chunk splitting** — split `react`/`react-dom`/`router` and
   `@xterm/*` into named vendor chunks so app-code changes don't bust
   the (large, rarely-changing) vendor cache. Low risk, best repeat-
   visit win now that assets are immutable.
2. **Precompressed assets** — emit `.js.gz`/`.js.br` at build time and
   serve them directly (saves per-request CPU vs middleware gzip, and
   brotli beats gzip ~15% on JS). Needs a StaticFiles subclass.
3. **Service worker (careful scope)** — cache-first for `/assets`,
   network-first for `index.html`, explicit versioned cleanup. Gives
   instant PWA cold-start and offline shell + offline docs. Do this
   only with a kill-switch; a stale SW is worse than no SW.
4. **xterm deferral** — the raw console is a fallback surface; loading
   `@xterm` lazily on first console open (or when the PTY attaches)
   would cut ~250 KB from the critical path. Requires care: the PTY
   socket opens at chat mount and the terminal must attach without
   losing scrollback.
5. **API response caching** — short-TTL ETag/If-None-Match on hot,
   mostly-static GETs (`/api/status`, model catalog, skills list) to
   cheapen the dashboard's polling loops.
6. **Font subsetting** — the display faces ship full Latin ranges;
   subsetting would trim first-paint bytes.

## Practices (apply to every change)

- Measure with the network tab cold + warm before/after; a change that
  can't show a number doesn't land.
- New pages are lazy by default; new heavy deps need a chunk budget
  note in the PR.
- Anything polled must be cheap (ETag or windowed) — no full-table
  fetches on an interval.
- Lists that can exceed ~50 rows get the LoadMoreSentinel pattern.
- Accessibility gates: axe clean, one `<main>`, one visible `<h1>`
  per view, keyboard-reachable scroll regions.
