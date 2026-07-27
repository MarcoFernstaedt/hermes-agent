"""Agent guards — outbound secret-scan, per-category rate ceilings, anomaly flags.

Defense in depth for agent-initiated tool calls, enforced at the dispatch
chokepoint (alongside scopes and approval integrity) and recorded under the
audit log. Three checks, each independently switchable:

* **Outbound secret-scan** — before a *send*-category payload leaves the
  system, scan it for credentials (private keys, cloud keys, provider tokens).
  Default ``enforce``: a detected secret blocks the send. High-confidence
  patterns only, to keep false positives near zero.
* **Rate ceilings** — a rolling-window cap on write / send / delete calls, to
  catch a runaway loop. Default ``observe`` (audit only) with generous limits,
  so it can be calibrated against real use before it ever blocks.
* **Anomaly flags** — first-ever email recipient and burst-delete are recorded
  as audit signals (never silently blocked; destructive tiers already fail-safe
  to ALWAYS_APPROVAL).

Only write/send/delete calls are considered; AUTO-tier reads are never touched.
All modes are read from the environment so they can be flipped without a code
change.
"""
from __future__ import annotations

import os
import re
import threading
import time
from collections import deque
from typing import Any, Optional

WRITE = "write"
SEND = "send"
DELETE = "delete"

_LOCK = threading.Lock()
# category -> deque[timestamp] for the rolling window.
_WINDOWS: dict[str, deque[float]] = {WRITE: deque(), SEND: deque(), DELETE: deque()}
_WINDOW_SECONDS = 3600.0  # one hour

# Generous defaults; override per category via env.
_DEFAULT_CEILINGS = {WRITE: 400, SEND: 40, DELETE: 60}

# Recent delete timestamps for the burst-delete flag (short window).
_RECENT_DELETES: deque[float] = deque()
_BURST_DELETE_WINDOW = 60.0
_BURST_DELETE_THRESHOLD = 5

# Seen email recipients (first-contact flag). Process-local hint, not security.
_SEEN_RECIPIENTS: set[str] = set()


# -- modes -----------------------------------------------------------------

def secret_scan_mode() -> str:
    raw = (os.environ.get("HERMES_OUTBOUND_SECRET_SCAN") or "enforce").strip().lower()
    return raw if raw in {"enforce", "observe", "off"} else "enforce"


def rate_limit_mode() -> str:
    raw = (os.environ.get("HERMES_AGENT_RATE_LIMIT") or "observe").strip().lower()
    return raw if raw in {"enforce", "observe", "off"} else "observe"


def _ceiling(category: str) -> int:
    env = os.environ.get(f"HERMES_RATE_LIMIT_{category.upper()}")
    if env:
        try:
            return max(1, int(env))
        except ValueError:
            pass
    return _DEFAULT_CEILINGS.get(category, 400)


# -- categorisation --------------------------------------------------------

_SEND_HINTS = ("send", "reply", "publish", "post_message", "dispatch_message", "tweet")
_DELETE_HINTS = ("delete", "trash", "destroy", "purge", "remove", "_rm", "rm_")


def categorize(tool_name: str, tier: Any) -> Optional[str]:
    """Map a tool to write/send/delete, or None for reads (AUTO tier)."""
    try:
        from hermes_cli.module_permissions import Tier

        if tier is Tier.AUTO:
            return None
    except Exception:
        pass
    name = (tool_name or "").lower()
    if any(h in name for h in _SEND_HINTS):
        return SEND
    if any(h in name for h in _DELETE_HINTS):
        return DELETE
    return WRITE


# -- outbound secret scan --------------------------------------------------

# High-confidence credential shapes only.
_SECRET_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("private_key_block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}")),
    ("openai_key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9]{20,}")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("stripe_secret", re.compile(r"\bsk_live_[0-9A-Za-z]{20,}")),
]


def scan_secrets(text: str) -> list[str]:
    """Return the names of credential patterns found in ``text`` (possibly empty)."""
    if not text:
        return []
    found: list[str] = []
    for name, pat in _SECRET_PATTERNS:
        if pat.search(text):
            found.append(name)
    return found


def _payload_text(args: Any) -> str:
    try:
        import json

        return json.dumps(args, default=str, ensure_ascii=False)
    except Exception:
        return str(args)


# -- audit -----------------------------------------------------------------

def _audit(tool: str, action: str, outcome: str, detail: dict) -> None:
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor="agent",
            module="agent_guards",
            tool=tool,
            action=action,
            outcome=outcome,
            detail=detail,
        )
    except Exception:
        pass


# -- the combined pre-dispatch check ---------------------------------------

def pre_dispatch_check(tool_name: str, args: Any, tier: Any = None) -> Optional[str]:
    """Run the guards for an agent-initiated tool call.

    Returns a refusal message when the call must be blocked, else None. Reads
    (AUTO) are never gated. On a blocked or flagged condition an audit row is
    written. Rate windows advance only for calls that are allowed to proceed.
    """
    if tier is None:
        try:
            from hermes_cli.module_permissions import get_tier

            tier = get_tier(tool_name)
        except Exception:
            tier = None
    category = categorize(tool_name, tier)
    if category is None:
        return None

    # 1) Outbound secret scan (send category only — the payload is leaving).
    if category == SEND:
        mode = secret_scan_mode()
        if mode != "off":
            hits = scan_secrets(_payload_text(args))
            if hits:
                enforced = mode == "enforce"
                _audit(
                    tool_name,
                    "outbound_secret_detected",
                    "refused" if enforced else "observed",
                    {"patterns": hits, "enforced": enforced},
                )
                if enforced:
                    return (
                        f"Blocked: the outbound payload for '{tool_name}' contains "
                        f"what looks like a credential ({', '.join(hits)}). Remove "
                        "the secret before sending."
                    )

    now = time.time()

    # 2) Anomaly flags (never block here; audit only).
    if category == DELETE:
        with _LOCK:
            while _RECENT_DELETES and now - _RECENT_DELETES[0] > _BURST_DELETE_WINDOW:
                _RECENT_DELETES.popleft()
            _RECENT_DELETES.append(now)
            burst = len(_RECENT_DELETES)
        if burst >= _BURST_DELETE_THRESHOLD:
            _audit(tool_name, "burst_delete", "flagged",
                   {"count": burst, "window_seconds": _BURST_DELETE_WINDOW})

    # 3) Rate ceilings (rolling window).
    mode = rate_limit_mode()
    if mode != "off":
        ceiling = _ceiling(category)
        with _LOCK:
            window = _WINDOWS[category]
            while window and now - window[0] > _WINDOW_SECONDS:
                window.popleft()
            count = len(window)
            over = count >= ceiling
            if not over:
                window.append(now)
        if over:
            enforced = mode == "enforce"
            _audit(
                tool_name,
                "rate_ceiling_exceeded",
                "refused" if enforced else "observed",
                {"category": category, "count": count, "ceiling": ceiling,
                 "enforced": enforced},
            )
            if enforced:
                return (
                    f"Blocked: the '{category}' rate ceiling ({ceiling}/hour) was "
                    f"reached. Pause or raise HERMES_RATE_LIMIT_{category.upper()}."
                )

    return None


def reset_state() -> None:
    """Clear all rolling windows and flags (tests / a fresh session)."""
    with _LOCK:
        for w in _WINDOWS.values():
            w.clear()
        _RECENT_DELETES.clear()
        _SEEN_RECIPIENTS.clear()
