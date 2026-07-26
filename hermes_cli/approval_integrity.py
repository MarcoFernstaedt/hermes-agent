"""Approval integrity — bind a human approval to the exact payload approved.

When a human approves a tool call, they approve *specific arguments* (this
path, this recipient, this command). If the payload that actually executes
differs from the one that was approved — because a later middleware transform,
retry, or bug mutated it — the human's consent no longer covers what runs. This
module records a canonical hash of the approved payload and verifies, at the
execution chokepoint, that it is unchanged.

Design notes:

* **Keyed by ``tool_call_id``.** A record is created when approval is granted
  and consumed when the call executes. Records expire after a short TTL so an
  abandoned approval never lingers.
* **Two modes.** ``observe`` (default) records a mismatch to the audit log and
  lets the call proceed — safe to ship while the approval→execution arg path is
  verified against the live app. ``enforce`` refuses a mismatched call. The
  mode is read from ``HERMES_APPROVAL_INTEGRITY`` (``observe`` | ``enforce`` |
  ``off``) so it can be flipped without a code change once verified.
* **Hash only.** We never store the payload, only a SHA-256 of its canonical
  form, so this adds no new place secrets can leak.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

_LOCK = threading.Lock()
_RECORDS: dict[str, "_Record"] = {}
_TTL_SECONDS = 900.0  # 15 min: longer than any human approval round-trip.
_MAX_RECORDS = 512  # Bound memory; evict oldest past this.


@dataclass(frozen=True)
class _Record:
    digest: str
    tool_name: str
    created_at: float


def canonical_hash(tool_name: str, args: Any) -> str:
    """A stable SHA-256 over ``(tool_name, args)``.

    Canonical form sorts object keys so semantically-identical payloads hash
    identically regardless of key order. Non-serialisable values fall back to
    ``repr`` so hashing never raises.
    """
    try:
        blob = json.dumps(
            {"tool": tool_name, "args": args},
            sort_keys=True,
            separators=(",", ":"),
            default=repr,
            ensure_ascii=False,
        )
    except Exception:
        blob = f"{tool_name}:{args!r}"
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def mode() -> str:
    """Current enforcement mode: ``observe`` (default), ``enforce`` or ``off``."""
    raw = (os.environ.get("HERMES_APPROVAL_INTEGRITY") or "observe").strip().lower()
    return raw if raw in {"observe", "enforce", "off"} else "observe"


def _evict_locked(now: float) -> None:
    # Drop expired records; if still over the cap, drop the oldest.
    expired = [k for k, r in _RECORDS.items() if now - r.created_at > _TTL_SECONDS]
    for k in expired:
        _RECORDS.pop(k, None)
    if len(_RECORDS) > _MAX_RECORDS:
        for k in sorted(_RECORDS, key=lambda k: _RECORDS[k].created_at)[
            : len(_RECORDS) - _MAX_RECORDS
        ]:
            _RECORDS.pop(k, None)


def record_grant(tool_call_id: str, tool_name: str, args: Any) -> None:
    """Record the payload a human just approved for ``tool_call_id``.

    No-op when integrity is off or there is no call id to key on."""
    if not tool_call_id or mode() == "off":
        return
    now = time.time()
    with _LOCK:
        _evict_locked(now)
        _RECORDS[tool_call_id] = _Record(
            digest=canonical_hash(tool_name, args),
            tool_name=tool_name,
            created_at=now,
        )


def clear(tool_call_id: str) -> None:
    """Forget any record for ``tool_call_id`` (e.g. on a denied/cancelled call)."""
    if not tool_call_id:
        return
    with _LOCK:
        _RECORDS.pop(tool_call_id, None)


def _audit_mismatch(tool_call_id: str, tool_name: str, enforced: bool) -> None:
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor="agent",
            module="approval_integrity",
            tool=tool_name,
            action="payload_changed_after_approval",
            target=tool_call_id,
            decision="approved",
            outcome="refused" if enforced else "observed",
            detail={"tool_call_id": tool_call_id, "enforced": enforced},
        )
    except Exception:
        pass


def verify_at_execution(
    tool_call_id: str, tool_name: str, args: Any
) -> Optional[str]:
    """Verify the executing payload matches what was approved.

    Returns a refusal message when the payload changed *and* the mode is
    ``enforce``; otherwise ``None`` (nothing recorded, payload matches, or
    observe-mode — a mismatch is still audited). The record is consumed either
    way: an approval covers a single execution.
    """
    if not tool_call_id:
        return None
    m = mode()
    if m == "off":
        return None
    with _LOCK:
        record = _RECORDS.pop(tool_call_id, None)
    if record is None:
        return None  # This call was not gated by a human approval.
    if canonical_hash(tool_name, args) == record.digest:
        return None
    enforced = m == "enforce"
    _audit_mismatch(tool_call_id, tool_name, enforced)
    if enforced:
        return (
            f"Approval integrity check failed for '{tool_name}': the payload "
            "changed after it was approved. Re-request approval for the current "
            "arguments."
        )
    return None
