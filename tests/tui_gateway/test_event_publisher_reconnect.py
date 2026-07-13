from __future__ import annotations

import json
import threading
import time
from unittest.mock import Mock

import tui_gateway.event_publisher as publisher


def _event(event_type: str, payload: dict | None = None) -> dict:
    return {
        "jsonrpc": "2.0",
        "method": "event",
        "params": {"type": event_type, "payload": payload or {}},
    }


def _wait_until(predicate, timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition was not met before timeout")


class _Socket:
    def __init__(self, *, fail_send: bool = False) -> None:
        self.fail_send = fail_send
        self.sent: list[str] = []
        self.closed = False

    def send(self, data: str) -> None:
        if self.fail_send:
            raise OSError("publisher connection dropped")
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True


def test_transport_reconnects_after_publish_socket_drops(monkeypatch) -> None:
    broken = _Socket(fail_send=True)
    recovered = _Socket()
    connect = Mock(side_effect=[broken, recovered])
    monkeypatch.setattr(publisher, "ws_connect", connect)

    transport = publisher.WsPublisherTransport("ws://dashboard/api/pub")
    try:
        transport.write(_event("message.start"))
        _wait_until(lambda: connect.call_count >= 2)
        transport.write(_event("message.complete"))
        _wait_until(lambda: bool(recovered.sent))

        assert json.loads(recovered.sent[0])["params"]["type"] == "message.complete"
        assert broken.closed is True
    finally:
        transport.close()


def test_transport_replays_idempotent_completion_until_recovered(monkeypatch) -> None:
    first_broken = _Socket(fail_send=True)
    second_broken = _Socket(fail_send=True)
    recovered = _Socket()
    connect = Mock(side_effect=[first_broken, second_broken, recovered])
    monkeypatch.setattr(publisher, "ws_connect", connect)

    transport = publisher.WsPublisherTransport("ws://dashboard/api/pub")
    try:
        transport.write(_event("message.complete", {"content": "done"}))
        _wait_until(lambda: bool(recovered.sent))

        assert json.loads(recovered.sent[0]) == _event(
            "message.complete", {"content": "done"}
        )
    finally:
        transport.close()


def test_transport_retries_initial_connection_without_dropping_event(monkeypatch) -> None:
    recovered = _Socket()
    connect = Mock(side_effect=[OSError("server restarting"), recovered])
    monkeypatch.setattr(publisher, "ws_connect", connect)

    transport = publisher.WsPublisherTransport("ws://dashboard/api/pub")
    try:
        transport.write(_event("session.info"))
        _wait_until(lambda: bool(recovered.sent))

        assert json.loads(recovered.sent[0])["params"]["type"] == "session.info"
        assert connect.call_count == 2
    finally:
        transport.close()


def test_completion_displaces_streaming_delta_when_queue_is_full(monkeypatch) -> None:
    connect_started = threading.Event()
    release_connect = threading.Event()

    def blocked_connect(*_args, **_kwargs):
        connect_started.set()
        release_connect.wait(timeout=1.0)
        raise OSError("still offline")

    monkeypatch.setattr(publisher, "_QUEUE_MAX", 2)
    monkeypatch.setattr(publisher, "ws_connect", blocked_connect)
    transport = publisher.WsPublisherTransport("ws://dashboard/api/pub")
    try:
        assert transport.write(_event("message.delta", {"text": "a"}))
        assert connect_started.wait(timeout=1.0)
        assert transport.write(_event("session.info", {"session_id": "session-1"}))
        assert transport.write(_event("message.delta", {"text": "b"}))

        assert transport.write(_event("message.complete", {"text": "final"}))
        queued = list(transport._q.queue)
        assert len(queued) == 2
        queued_types = [json.loads(item)["params"]["type"] for item in queued]
        assert queued_types == ["session.info", "message.complete"]
    finally:
        release_connect.set()
        transport.close()


def test_distinct_completions_displace_superseded_session_snapshot(monkeypatch) -> None:
    connect_started = threading.Event()
    release_connect = threading.Event()

    def blocked_connect(*_args, **_kwargs):
        connect_started.set()
        release_connect.wait(timeout=1.0)
        raise OSError("still offline")

    monkeypatch.setattr(publisher, "_QUEUE_MAX", 2)
    monkeypatch.setattr(publisher, "ws_connect", blocked_connect)
    transport = publisher.WsPublisherTransport("ws://dashboard/api/pub")
    try:
        assert transport.write(_event("message.delta", {"text": "start worker"}))
        assert connect_started.wait(timeout=1.0)
        assert transport.write(_event("session.info", {"session_id": "session-1"}))
        assert transport.write(_event("message.complete", {"text": "first"}))
        assert transport.write(_event("message.complete", {"text": "second"}))

        queued = [json.loads(item) for item in transport._q.queue]
        assert [item["params"]["type"] for item in queued] == [
            "message.complete",
            "message.complete",
        ]
        assert [item["params"]["payload"]["text"] for item in queued] == [
            "first",
            "second",
        ]
    finally:
        release_connect.set()
        transport.close()


def test_queue_full_of_distinct_completions_fails_closed(monkeypatch) -> None:
    connect_started = threading.Event()
    release_connect = threading.Event()

    def blocked_connect(*_args, **_kwargs):
        connect_started.set()
        release_connect.wait(timeout=1.0)
        raise OSError("still offline")

    monkeypatch.setattr(publisher, "_QUEUE_MAX", 2)
    monkeypatch.setattr(publisher, "ws_connect", blocked_connect)
    transport = publisher.WsPublisherTransport("ws://dashboard/api/pub")
    try:
        assert transport.write(_event("message.delta", {"text": "start worker"}))
        assert connect_started.wait(timeout=1.0)
        assert transport.write(_event("message.complete", {"text": "first"}))
        assert transport.write(_event("message.complete", {"text": "second"}))
        assert not transport.write(_event("message.complete", {"text": "third"}))

        queued = [json.loads(item) for item in transport._q.queue]
        assert [item["params"]["payload"]["text"] for item in queued] == [
            "first",
            "second",
        ]
    finally:
        release_connect.set()
        transport.close()
