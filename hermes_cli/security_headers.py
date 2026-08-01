"""Response headers for a Tailnet-only dashboard.

Defence in depth, sized to the actual deployment. This dashboard is reachable
only over Tailscale, served through Tailscale Serve, and speaks WebSockets on
the same origin — so the job here is to close the browser-side gaps without
breaking either of those, and a header that breaks the app is worse than the
header's absence.

Three decisions are load-bearing:

**The CSP allows `'unsafe-inline'` for styles and not for scripts.** The build
emits inline style attributes (Tailwind arbitrary values, measured heights set
from JS) and inlining a style cannot execute code. Scripts are a different
matter, so `script-src` stays `'self'`, which is exactly what the bundle needs
and nothing more. There are no CDNs, fonts or third-party scripts to allow —
that is a product constraint, and the CSP is where it becomes enforced rather
than merely intended.

**`connect-src` includes `ws:` and `wss:` on `'self'`.** The chat transport and
the event feed are WebSockets. Omitting this is the classic way a CSP silently
kills a realtime app; it does not fail loudly, the socket simply never opens.

**HSTS is emitted only on a genuinely secure request.** Sending it over plain
HTTP is meaningless, and sending it from behind a proxy that terminates TLS
elsewhere can pin a hostname the owner did not intend. So it is gated on the
request actually being HTTPS.

`Permissions-Policy` allows microphone, camera and geolocation for `self` only.
They are needed — push-to-talk, one-frame camera description, current location
— and permitting them for `self` while denying every third party is the point:
no embedded frame or injected script can reach the microphone.
"""
from __future__ import annotations

from typing import Dict

#: One year, the conventional HSTS max-age. No `preload`: preloading is a
#: one-way door on a domain the owner may want to use differently, and this is
#: a Tailnet host, not a public site.
HSTS_MAX_AGE = 31_536_000

CSP_DIRECTIVES = (
    "default-src 'self'",
    # No CDNs, no third-party scripts. The product constraint, enforced.
    "script-src 'self'",
    # Inline styles are emitted by the build and cannot execute.
    "style-src 'self' 'unsafe-inline'",
    # `blob:` covers object URLs for captured camera frames and recorded audio;
    # `data:` covers inline icons.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    # WebSockets are the chat transport and the event feed. Omitting these is
    # how a CSP silently kills a realtime app.
    "connect-src 'self' ws: wss:",
    # Nothing may frame this, and it may frame nothing.
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
)

#: Paths that must not receive these headers. The WebSocket upgrade path is
#: excluded because header injection on a 101 response is at best ignored and
#: at worst rejected by an intermediary.
_EXCLUDED_PREFIXES = ("/api/ws",)


def is_secure_request(scheme: str, forwarded_proto: str = "") -> bool:
    """Whether the *client's* connection was HTTPS.

    Tailscale Serve terminates TLS and forwards over HTTP, so the app's own
    scheme says `http` for a request the browser made over `https`. Reading
    only `request.url.scheme` would therefore never emit HSTS on exactly the
    deployment that wants it. `X-Forwarded-Proto` is trusted here because the
    only thing in front of this server is the owner's own proxy on the
    loopback interface.
    """
    if forwarded_proto:
        # A proxy chain sends a comma-separated list; the client's protocol is
        # the first entry.
        first = forwarded_proto.split(",")[0].strip().lower()
        if first:
            return first == "https"
    return scheme.lower() == "https"


def security_headers(*, secure: bool, is_html: bool = True) -> Dict[str, str]:
    """The headers to add to a response.

    ``is_html`` gates the policies that only mean something for a document.
    Attaching a CSP to a JSON API response costs bytes on every call and
    protects nothing, since there is no document context to constrain.
    """
    headers: Dict[str, str] = {
        # Applies to every response: a JSON body sniffed as HTML is an XSS
        # vector regardless of what the endpoint intended.
        "X-Content-Type-Options": "nosniff",
        # Never leak a dashboard path to an external destination.
        "Referrer-Policy": "strict-origin-when-cross-origin",
        # Powerful features for this origin only. Third parties get nothing —
        # that is the protection, not the denial of the features themselves.
        "Permissions-Policy": (
            "microphone=(self), camera=(self), geolocation=(self), "
            "payment=(), usb=(), midi=(), magnetometer=(), gyroscope=(), "
            "accelerometer=(), interest-cohort=()"
        ),
    }

    if is_html:
        headers["Content-Security-Policy"] = "; ".join(CSP_DIRECTIVES)
        # Redundant beside `frame-ancestors` for modern browsers, kept for the
        # ones that only understand this.
        headers["X-Frame-Options"] = "DENY"

    if secure:
        # Only on a real HTTPS request. Over plain HTTP it means nothing, and
        # from behind the wrong proxy it can pin a hostname unintentionally.
        headers["Strict-Transport-Security"] = f"max-age={HSTS_MAX_AGE}; includeSubDomains"

    return headers


def should_apply(path: str) -> bool:
    """False for paths where these headers do not belong.

    The WebSocket upgrade is the only exclusion: headers on a 101 response are
    ignored at best and rejected by an intermediary at worst, and a chat that
    will not connect is a broken dashboard.
    """
    return not any(path.startswith(prefix) for prefix in _EXCLUDED_PREFIXES)
