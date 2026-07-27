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
# tool_call_id -> consumed-at timestamp, so a record can't be replayed after it
# has already authorised one execution (fail-closed against replay in enforce).
_CONSUMED: dict[str, float] = {}
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
    # Age out the consumed-ledger on the same TTL and cap.
    stale = [k for k, ts in _CONSUMED.items() if now - ts > _TTL_SECONDS]
    for k in stale:
        _CONSUMED.pop(k, None)
    if len(_CONSUMED) > _MAX_RECORDS:
        for k in sorted(_CONSUMED, key=lambda k: _CONSUMED[k])[
            : len(_CONSUMED) - _MAX_RECORDS
        ]:
            _CONSUMED.pop(k, None)


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
        _CONSUMED.pop(tool_call_id, None)


def reset_state() -> None:
    """Clear all records and the consumed ledger (tests / a fresh session)."""
    with _LOCK:
        _RECORDS.clear()
        _CONSUMED.clear()


def _audit(tool_call_id: str, tool_name: str, action: str, outcome: str, detail: dict) -> None:
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor="agent",
            module="approval_integrity",
            tool=tool_name,
            action=action,
            target=tool_call_id,
            decision="approved",
            outcome=outcome,
            detail={"tool_call_id": tool_call_id, **detail},
        )
    except Exception:
        pass


def verify_at_execution(
    tool_call_id: str, tool_name: str, args: Any, *, gated: bool = False
) -> Optional[str]:
    """Verify the executing payload matches what was approved.

    Returns a refusal message when the call must be blocked, else ``None``.

    Behaviour, corrected per the on-machine recon (fail-closed in enforce):

    * **Match** — the record is consumed and, in observe mode, a ``verified``
      row is written so the audit log has a *denominator* (how many gated calls
      passed), not only mismatches. Returns None.
    * **Mismatch** — audited; refused in enforce, allowed-but-audited in observe.
    * **No record** — in ``enforce`` a call known to be ``gated`` fails **closed**
      (a human-gated call must carry a valid, unconsumed grant); a replay of an
      already-consumed grant likewise fails closed. In observe (or for non-gated
      calls) this stays None so nothing is blocked during measurement.
    * **Errors** — in enforce mode an unexpected error fails closed rather than
      silently allowing.
    """
    if not tool_call_id:
        return None
    m = mode()
    if m == "off":
        return None
    enforced = m == "enforce"
    try:
        with _LOCK:
            record = _RECORDS.pop(tool_call_id, None)
            replayed = tool_call_id in _CONSUMED
            if record is not None:
                _CONSUMED[tool_call_id] = time.time()

        if record is None:
            if enforced and (replayed or gated):
                reason = "replay of a consumed approval" if replayed else "no approval record"
                _audit(tool_call_id, tool_name, "missing_approval_record", "refused",
                       {"reason": reason, "enforced": True})
                return (
                    f"Approval integrity check failed for '{tool_name}': "
                    f"{reason}. Re-request approval for the current arguments."
                )
            return None

        if canonical_hash(tool_name, args) == record.digest:
            if not enforced:  # measurement phase — record the denominator.
                _audit(tool_call_id, tool_name, "verified", "observed", {"enforced": False})
            return None

        _audit(tool_call_id, tool_name, "payload_changed_after_approval",
               "refused" if enforced else "observed", {"enforced": enforced})
        if enforced:
            return (
                f"Approval integrity check failed for '{tool_name}': the payload "
                "changed after it was approved. Re-request approval for the current "
                "arguments."
            )
        return None
    except Exception:
        # Never let an integrity bug silently widen autonomy: fail closed in
        # enforce, fail open (allow) in observe so measurement can't break work.
        if enforced:
            return (
                f"Approval integrity check errored for '{tool_name}'; refusing to "
                "run the gated call. Re-request approval."
            )
        return None
