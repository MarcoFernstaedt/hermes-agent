"""Best-effort WebSocket publisher transport for the PTY-side gateway.

The dashboard's `/api/pty` spawns `hermes --tui` as a child process, which
spawns its own ``tui_gateway.entry``.  Tool/reasoning/status events fire on
*that* gateway's transport — three processes removed from the dashboard
server itself.  To surface them in the dashboard sidebar (`/api/events`),
the PTY-side gateway opens a back-WS to the dashboard at startup and
mirrors every emit through this transport.

Wire protocol: newline-framed JSON-RPC event envelopes (the same shape the
dispatcher passes to ``write``). The dashboard's ``/api/pub`` endpoint
rebroadcasts the bytes verbatim to subscribers.

Failure mode: silent and self-healing. The agent loop never blocks waiting for the
sidecar to connect or drain. Connection work runs on a daemon thread, retries
with bounded backoff. The queue stays bounded; terminal/session snapshots may
displace an older streaming frame so durable completion is not starved. Failed
snapshots are replayed because their reducers are idempotent, while ambiguous
streaming deltas are not replayed because that could duplicate text.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
from typing import Optional

try:
    from websockets.sync.client import connect as ws_connect
except ImportError:  # pragma: no cover - websockets is a required install path
    ws_connect = None  # type: ignore[assignment]

_log = logging.getLogger(__name__)

_DRAIN_STOP = object()

_QUEUE_MAX = 256
_REPLAY_SAFE_TYPES = frozenset({"message.complete", "session.info"})


def _event_type(line: str) -> Optional[str]:
    try:
        event = json.loads(line)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(event, dict):
        return None
    event_type = event.get("type")
    params = event.get("params")
    if event_type is None and isinstance(params, dict):
        event_type = params.get("type")
    return event_type if isinstance(event_type, str) else None


def _is_replay_safe(line: str) -> bool:
    return _event_type(line) in _REPLAY_SAFE_TYPES


class WsPublisherTransport:
    __slots__ = (
        "_url",
        "_connect_timeout",
        "_lock",
        "_ws",
        "_dead",
        "_q",
        "_worker",
    )

    def __init__(self, url: str, *, connect_timeout: float = 2.0) -> None:
        self._url = url
        self._connect_timeout = connect_timeout
        self._lock = threading.Lock()
        self._ws: Optional[object] = None
        self._dead = ws_connect is None
        self._q: queue.Queue[object] = queue.Queue(maxsize=_QUEUE_MAX)
        self._worker: Optional[threading.Thread] = None

        if self._dead:
            return

        # Connection establishment belongs to the drain thread too.  A
        # dashboard restart must not permanently disable the publisher during
        # TUI construction, and the agent loop must never block on networking.
        self._worker = threading.Thread(
            target=self._drain,
            name="hermes-ws-pub",
            daemon=True,
        )
        self._worker.start()

    def _discard_ws(self) -> None:
        with self._lock:
            ws, self._ws = self._ws, None
        if ws is not None:
            try:
                ws.close()  # type: ignore[union-attr]
            except Exception:
                pass

    def _connect_with_backoff(self) -> bool:
        delay = 0.05
        while not self._dead:
            try:
                ws = ws_connect(  # type: ignore[misc]
                    self._url,
                    open_timeout=self._connect_timeout,
                    max_size=None,
                )
                with self._lock:
                    if self._dead:
                        try:
                            ws.close()
                        except Exception:
                            pass
                        return False
                    self._ws = ws
                return True
            except Exception as exc:
                _log.debug("event publisher connect failed; retrying: %s", exc)
                threading.Event().wait(delay)
                delay = min(delay * 2, 1.0)
        return False

    def _drain(self) -> None:
        while not self._dead:
            item = self._q.get()
            if item is _DRAIN_STOP:
                return
            if not isinstance(item, str):
                continue
            replay_safe = _is_replay_safe(item)
            while not self._dead:
                if self._ws is None and not self._connect_with_backoff():
                    return
                try:
                    with self._lock:
                        ws = self._ws
                    if ws is None:
                        continue
                    ws.send(item)  # type: ignore[union-attr]
                    break
                except Exception as exc:
                    _log.debug("event publisher write failed; reconnecting: %s", exc)
                    self._discard_ws()
                    if not replay_safe:
                        # Streaming deltas are ambiguous: retrying may duplicate text.
                        if not self._connect_with_backoff():
                            return
                        break

    def write(self, obj: dict) -> bool:
        if self._dead or self._worker is None:
            return False

        line = json.dumps(obj, ensure_ascii=False)
        try:
            self._q.put_nowait(line)
            return True
        except queue.Full:
            if not _is_replay_safe(line):
                return False
            # Preserve already-queued terminal/session snapshots. Replace only
            # the oldest disposable streaming frame while holding Queue's own
            # mutex so the drain thread cannot race the selection.
            with self._q.mutex:
                queued = self._q.queue
                for index, queued_item in enumerate(queued):
                    if isinstance(queued_item, str) and not _is_replay_safe(queued_item):
                        del queued[index]
                        queued.append(line)
                        self._q.not_empty.notify()
                        return True

                incoming_type = _event_type(line)
                # A fresh completion is more valuable than an older session
                # metadata snapshot. Session metadata itself is coalescible.
                if incoming_type in {"message.complete", "session.info"}:
                    for index, queued_item in enumerate(queued):
                        if (
                            isinstance(queued_item, str)
                            and _event_type(queued_item) == "session.info"
                        ):
                            del queued[index]
                            queued.append(line)
                            self._q.not_empty.notify()
                            return True
            return False

    def close(self) -> None:
        self._dead = True
        self._discard_ws()
        w = self._worker
        if w is not None and w.is_alive():
            try:
                self._q.put_nowait(_DRAIN_STOP)
            except queue.Full:
                pass
            w.join(timeout=3.0)
        self._worker = None
