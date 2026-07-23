/*
 * Imperator dashboard service worker — offline app shell.
 *
 * SECURITY CONTRACT (this app reads and writes live API keys):
 *   - The navigation document (index.html) is NEVER cached. In loopback mode
 *     the server injects the ephemeral session token into that HTML, so
 *     caching it would persist a secret to disk. Navigations are network-only,
 *     falling back to a static, token-free offline page when the network is
 *     down.
 *   - /api/*, websockets, and auth routes are NEVER intercepted or cached —
 *     they carry live keys, session content, and tokens. They hit the network
 *     as-is; offline they fail, which is the correct behaviour (no stale
 *     secrets served).
 *   - Only content-hashed, secret-free static assets (JS/CSS/fonts/icons) are
 *     cached, plus the standalone offline page and the manifest/icons.
 *
 * Bump VERSION to invalidate every cache on the next activation.
 */
const VERSION = "imperator-sw-v1";
const SHELL_CACHE = VERSION + "-shell";
const ASSET_CACHE = VERSION + "-assets";

// Token-free precache: the offline fallback plus install/manifest assets.
const SHELL_URLS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/imperator-192.png",
  "/icons/imperator-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !key.startsWith(VERSION))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheableAsset(url) {
  return (
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/fonts/") ||
    url.pathname.startsWith("/fonts-terminal/") ||
    url.pathname.startsWith("/ds-assets/") ||
    url.pathname.startsWith("/icons/")
  );
}

function isNeverCache(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/ws") ||
    url.pathname.startsWith("/login") ||
    url.pathname.startsWith("/oauth") ||
    url.pathname === "/sw.js"
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCache(url)) return; // let the network handle it, untouched

  // Navigations: network-only (the document may carry the injected session
  // token, so it must never be cached). When offline, serve the static,
  // token-free offline page so the PWA still shows something coherent.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match("/offline.html").then(
          (cached) =>
            cached ||
            new Response("You are offline.", {
              status: 503,
              headers: { "Content-Type": "text/plain" },
            }),
        ),
      ),
    );
    return;
  }

  // Content-hashed, secret-free static assets: cache-first for instant,
  // offline-capable loads. Hashed filenames are immutable, so a stale entry
  // is never wrong — a new deploy requests new names.
  if (isCacheableAsset(url)) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            if (res.ok && res.type === "basic") {
              const copy = res.clone();
              caches
                .open(ASSET_CACHE)
                .then((cache) => cache.put(req, copy))
                .catch(() => {});
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Manifest and other same-origin GETs: cache-first, then network.
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
