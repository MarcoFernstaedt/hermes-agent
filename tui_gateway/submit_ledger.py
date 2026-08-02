"""Which prompt submissions this install has already accepted.

A socket drops between the gateway accepting a prompt and the acknowledgement
reaching the browser. The client cannot tell whether its message landed, and
both answers available to it are wrong: dropping loses what the owner typed,
resending runs the turn twice. So the client mints a token per composed message
and presents the same one on every send of it, and the gateway decides which
situation it is actually in.

Two properties this module exists to hold, both of which the in-session
dictionary it replaces could not:

**An in-flight claim is never forgotten to make room.** The old table was a
bounded `OrderedDict` that evicted the oldest entry on overflow, and the oldest
entry is frequently the one still running — a long turn submitted before a
burst of short ones. Evicting it turns the very next resubmission of that
message into a first submission, which is the duplicate the whole mechanism
exists to prevent. Here, only *settled* entries are evictable; a table full of
live claims refuses a new one rather than dropping one.

**A claim outlives the process.** The old table lived inside the live session
dict, so an orphan reap, a gateway restart, or a cold resume erased every
record. That is exactly the window in which a client is most likely to resend —
it reconnects *because* something died. The claims and outcomes are written to
the same SQLite idempotency store the irreversible actions use, keyed by the
durable session key rather than the live session id, so they survive all three.

The in-memory table is kept in front of it as a cache, not as the record. Every
answer it can give, the store can give; it exists so the common case does not
touch the disk.
"""
from __future__ import annotations

import collections
import logging
import threading
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: How many settled outcomes a session caches in memory. A reconnect resubmits
#: the message it was unsure about, not the last two hundred, so this only has
#: to outlive one drop. The durable store answers anything older.
SUBMIT_TOKEN_MEMORY = 64

#: A hard ceiling on *live* claims for one session. Reaching it means something
#: is wrong — a client looping, or turns that never settle — and the honest
#: response is to refuse the submission rather than to forget one of the claims
#: that is protecting a message.
MAX_LIVE_CLAIMS = 256

#: Its own lock, not the session's. `history_lock` is a plain `threading.Lock`
#: and two of the release sites sit *inside* a block already holding it, so
#: reusing it would deadlock the handler on its own error paths. Nothing here
#: ever takes `history_lock`, so this cannot participate in a cycle.
_lock = threading.RLock()

#: The durable store, cached so it is opened once rather than per submission —
#: keyed by the resolved path, not merely by "have we opened one". Caching on a
#: bare flag made the handle outlive the `HERMES_HOME` it was built from, so a
#: second home silently kept reading and writing the first one's database.
_store = None
_store_path = None
_store_lock = threading.Lock()


class SubmitLedgerFull(RuntimeError):
    """This session has more live claims than it can be holding legitimately."""


def _durable_store():
    """The shared idempotency store, or None when it cannot be opened.

    A store that will not open is a degraded mode, not a failure: the in-memory
    table still stops the duplicate that happens within one process lifetime,
    which is the common case. Refusing every prompt because a database file is
    unwritable would be a much larger outage than the one being prevented.
    """
    global _store, _store_path
    try:
        from hermes_constants import get_hermes_home

        path = get_hermes_home() / "state" / "idempotency.sqlite3"
    except Exception:
        logger.warning("cannot resolve the idempotency store path", exc_info=True)
        return None

    with _store_lock:
        if _store is not None and _store_path == path:
            return _store
        try:
            from hermes_cli.actions.idempotency import IdempotencyStore

            _store = IdempotencyStore(path)
            _store_path = path
        except Exception:
            logger.warning(
                "prompt idempotency store unavailable; duplicate protection is "
                "in-memory only for this process", exc_info=True,
            )
            _store = None
            _store_path = None
        return _store


def _durable_key(session: dict, token: str) -> str:
    """The store key: durable session identity, never the live session id.

    `session_key` is what the session database is keyed by and what a resume
    reattaches to. The live `sid` is regenerated whenever the process is, which
    would make every restart look like a different conversation and defeat the
    point of persisting anything.
    """
    key = ""
    if isinstance(session, dict):
        key = str(session.get("session_key") or "").strip()
    return f"prompt_submit:{key}:{token}"


def _table(session: dict) -> collections.OrderedDict:
    seen = session.get("_submit_tokens")
    if not isinstance(seen, collections.OrderedDict):
        seen = collections.OrderedDict()
        session["_submit_tokens"] = seen
    return seen


def _evict_settled(seen: collections.OrderedDict) -> None:
    """Trim the cache to its budget, touching only settled entries.

    Deliberately not `popitem(last=False)`. The oldest entry is often a long
    turn that is still running, and forgetting a live claim is the one failure
    this table must never have.
    """
    if len(seen) <= SUBMIT_TOKEN_MEMORY:
        return
    for token, entry in list(seen.items()):
        if len(seen) <= SUBMIT_TOKEN_MEMORY:
            return
        if entry.get("state") != "in_flight":
            seen.pop(token, None)


def _live_claims(seen: collections.OrderedDict) -> int:
    return sum(1 for e in seen.values() if e.get("state") == "in_flight")


def _replay_for(record: dict) -> dict:
    """What to tell a caller whose token the store already knows about."""
    state = (record or {}).get("state")
    if state == "succeeded":
        result = (record or {}).get("result")
        if isinstance(result, dict):
            return dict(result, duplicate=True)
        return {"status": "queued", "duplicate": True}
    if state == "ambiguous":
        # The gateway claimed this message and then died before recording what
        # became of it. It may be in the history and it may not — and the one
        # thing that must not happen is a silent resubmission, because that is
        # how one prompt becomes two. Say so, and let the client reconcile
        # against the message history it can actually read.
        return {
            "status": "unresolved",
            "duplicate": True,
            "message": (
                "An earlier submission of this message was interrupted before "
                "its outcome was recorded. Check the conversation before "
                "sending it again."
            ),
        }
    # `in_flight` or `dispatching`: the original is still being handled. Saying
    # "accepted" would be a second promise about one message; "queued" is true —
    # it is going to run, and it is not running yet.
    return {"status": "queued", "duplicate": True}


def claim(session: dict, token: str):
    """First caller for ``token`` claims it; later ones get what to say instead.

    Returns None when this caller should go ahead and submit, or a response dict
    when it must not — either the recorded outcome of the first submission, or
    an acknowledgement that the first one is still running.

    Raises `SubmitLedgerFull` when the session is already holding more live
    claims than it plausibly can. Refusing is the safe direction: the caller
    turns it into an error the client can retry, and no protected message is
    forgotten to make room.
    """
    if not token:
        # An empty key is not a key. A helper that filed every tokenless
        # submission under "" would make them all collide with each other —
        # one blank entry claiming to be the outcome of whatever ran first.
        return None

    with _lock:
        seen = _table(session)
        entry = seen.get(token)
        if entry is not None:
            seen.move_to_end(token)
            if entry.get("state") == "in_flight":
                return {"status": "queued", "duplicate": True}
            recorded = entry.get("result")
            return dict(recorded, duplicate=True) if isinstance(recorded, dict) else (
                {"status": "queued", "duplicate": True}
            )
        if _live_claims(seen) >= MAX_LIVE_CLAIMS:
            raise SubmitLedgerFull(
                f"this session is already holding {MAX_LIVE_CLAIMS} unfinished "
                "submissions; refusing to forget one to accept another"
            )

    # Not in the cache. That is either a genuinely new message or a resubmission
    # arriving after a restart — the case the durable store exists for.
    store = _durable_store()
    attempt: Optional[str] = None
    if store is not None:
        try:
            won, prior, attempt = store.claim(_durable_key(session, token))
        except Exception:
            logger.warning("prompt idempotency claim failed", exc_info=True)
            won, prior, attempt = True, None, None
        if not won:
            replay = _replay_for(prior or {})
            with _lock:
                seen = _table(session)
                if prior and prior.get("state") == "succeeded":
                    seen[token] = {"state": "settled", "result": dict(replay)}
                    seen.move_to_end(token)
                    _evict_settled(seen)
            return replay

    with _lock:
        seen = _table(session)
        if token in seen:
            # Another thread claimed it between the cache miss and here. It
            # holds the durable claim; this caller must not also submit.
            return {"status": "queued", "duplicate": True}
        seen[token] = {"state": "in_flight", "attempt": attempt}
        seen.move_to_end(token)
        _evict_settled(seen)
    if store is not None and attempt is not None:
        try:
            # Past this point the prompt is about to be handed to the agent, so
            # an unexplained death is ambiguous rather than "never happened".
            store.mark_dispatching(_durable_key(session, token), attempt)
        except Exception:
            logger.warning("prompt idempotency dispatch mark failed", exc_info=True)
    return None


def record_outcome(session: dict, token: str, result: dict) -> dict:
    """Remember what this submission decided, so a replay repeats it."""
    if not token:
        return result
    attempt = None
    try:
        with _lock:
            seen = _table(session)
            entry = seen.get(token)
            if entry is None:
                return result
            attempt = entry.get("attempt")
            seen[token] = {"state": "settled", "result": dict(result)}
            seen.move_to_end(token)
            _evict_settled(seen)
    except Exception:
        logger.warning("prompt outcome cache write failed", exc_info=True)

    store = _durable_store()
    if store is not None and attempt is not None:
        try:
            store.settle_dispatched(
                _durable_key(session, token), attempt,
                state="succeeded", result=dict(result),
            )
        except Exception:
            logger.warning("prompt idempotency settle failed", exc_info=True)
    return result


def release(session: dict, token: str) -> None:
    """Forget a claim that never produced an outcome.

    A submission that errored out did not happen, so holding the token would
    make the retry a no-op — the client would resend, get "queued, duplicate",
    and wait forever for a turn nobody started.

    Only ever correct for a claim that produced nothing, so a settled entry is
    left exactly as it is.
    """
    if not token:
        return
    attempt = None
    try:
        with _lock:
            seen = session.get("_submit_tokens")
            if isinstance(seen, collections.OrderedDict):
                entry = seen.get(token)
                if isinstance(entry, dict) and entry.get("state") == "in_flight":
                    attempt = entry.get("attempt")
                    seen.pop(token, None)
                else:
                    return
    except Exception:
        logger.warning("prompt claim release failed", exc_info=True)
        return

    store = _durable_store()
    if store is None or attempt is None:
        return
    key = _durable_key(session, token)
    try:
        # `claim` marked it dispatching, so `release` (which only drops an
        # `in_flight` row) will not match. Settle it as a proven non-event
        # instead: `claim` reacquires a `failed` row, which is exactly the
        # "this may be attempted again" the caller is asserting.
        if not store.release(key, attempt):
            store.settle_reconciled(key, attempt, state="failed",
                                    result={"error": "submission was refused"})
    except Exception:
        logger.warning("prompt idempotency release failed", exc_info=True)


def lookup(session: dict, token: str) -> dict:
    """What is known about ``token``, without claiming or changing anything.

    This is what a client with held sends asks before resending: it names the
    tokens it is unsure about and is told, per token, whether the gateway ever
    saw them. ``unknown`` means genuinely never seen — the message did not land
    and sending it is safe.
    """
    if not token:
        return {"token": token, "state": "unknown"}
    with _lock:
        seen = session.get("_submit_tokens")
        entry = seen.get(token) if isinstance(seen, collections.OrderedDict) else None
        if isinstance(entry, dict):
            if entry.get("state") == "in_flight":
                return {"token": token, "state": "in_flight", "resend": False}
            return {
                "token": token, "state": "settled", "resend": False,
                "result": dict(entry.get("result") or {}),
            }

    store = _durable_store()
    if store is None:
        return {"token": token, "state": "unknown", "resend": True}
    try:
        record = store.lookup(_durable_key(session, token))
    except Exception:
        logger.warning("prompt idempotency lookup failed", exc_info=True)
        # Not being able to look is not evidence that nothing landed.
        return {"token": token, "state": "unresolved", "resend": False}
    if record is None:
        return {"token": token, "state": "unknown", "resend": True}
    state = record.get("state")
    if state == "succeeded":
        return {
            "token": token, "state": "settled", "resend": False,
            "result": record.get("result") or {},
        }
    if state == "failed":
        # Proven not to have happened, so resending is not a duplicate.
        return {"token": token, "state": "failed", "resend": True}
    return {"token": token, "state": state or "unresolved", "resend": False}


def _reset_for_tests() -> None:
    """Drop the cached store handle. Rarely needed — the cache is path-keyed."""
    global _store, _store_path
    with _store_lock:
        _store = None
        _store_path = None
