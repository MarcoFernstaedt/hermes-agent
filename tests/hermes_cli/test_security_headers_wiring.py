"""The security headers as the running app actually emits them.

`test_security_headers.py` tests the policy. This tests the wiring — which is
where the failure would be, and where it would be silent: a CSP that omits
WebSockets does not raise, it just means chat never connects.
"""
from __future__ import annotations

import pytest


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from hermes_cli.web_server import app

    return TestClient(app)


class TestJsonResponses:
    def test_they_carry_the_transport_protections(self, client):
        # An unauthenticated request still gets headers — they are applied by
        # middleware, not by the route, so an auth failure is protected too.
        response = client.get("/api/system/health")
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"

    def test_a_rejected_request_is_protected_too(self, client):
        """Middleware order, pinned.

        Registered before the auth gates, this middleware sat *inside* them:
        every short-circuited 401 came back with no `nosniff` and no referrer
        policy, so the responses most worth protecting were the only ones
        unprotected. It has to be registered last to wrap them.
        """
        response = client.get("/api/system/health")
        if response.status_code == 200:
            pytest.skip("auth is not enforced in this configuration")
        assert response.status_code in (401, 403)
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert "Permissions-Policy" in response.headers

    def test_they_do_not_carry_a_document_policy(self, client):
        response = client.get("/api/system/health")
        assert "Content-Security-Policy" not in response.headers

    def test_powerful_features_are_scoped_to_this_origin(self, client):
        policy = client.get("/api/system/health").headers["Permissions-Policy"]
        assert "microphone=(self)" in policy
        assert "payment=()" in policy


class TestHtmlResponses:
    def test_the_document_gets_a_csp_that_allows_websockets(self, client):
        response = client.get("/")
        if "text/html" not in response.headers.get("content-type", ""):
            pytest.skip("no packaged frontend in this checkout")
        csp = response.headers["Content-Security-Policy"]
        # The silent killer: without this the app renders and never connects.
        assert "connect-src 'self' ws: wss:" in csp
        assert "script-src 'self'" in csp
        assert "frame-ancestors 'none'" in csp

    def test_the_document_refuses_to_be_framed(self, client):
        response = client.get("/")
        if "text/html" not in response.headers.get("content-type", ""):
            pytest.skip("no packaged frontend in this checkout")
        assert response.headers["X-Frame-Options"] == "DENY"


class TestHsts:
    def test_it_is_absent_over_plain_http(self, client):
        assert "Strict-Transport-Security" not in client.get("/api/system/health").headers

    def test_a_forwarding_proxy_makes_it_appear(self, client):
        # Tailscale Serve terminates TLS and forwards over HTTP. Without
        # reading the forwarded header, HSTS would never be emitted on exactly
        # the deployment that wants it.
        response = client.get(
            "/api/system/health", headers={"X-Forwarded-Proto": "https"}
        )
        assert "Strict-Transport-Security" in response.headers


class TestTheWebsocketPathIsCoveredAndStillWorks:
    def test_a_rejected_http_request_under_the_ws_prefix_gets_headers(self, client):
        """The exclusion this replaces stripped headers from exactly these.

        HTTP middleware never sees a WebSocket scope, so excluding `/api/ws`
        protected nothing about the upgrade — it only unprotected the 404s and
        auth rejections served over ordinary HTTP under that prefix.
        """
        for path in ("/api/ws", "/api/ws-anything"):
            response = client.get(path)
            assert response.headers["X-Content-Type-Options"] == "nosniff", path
            assert "Referrer-Policy" in response.headers, path

    def test_the_upgrade_itself_still_connects_or_closes_cleanly(self, client):
        """The regression that matters: middleware must not break the socket.

        Either the handshake completes or the server closes it deliberately
        (auth, readiness). Both are fine. A middleware fault would surface as
        neither — a raised exception during the upgrade.
        """
        from starlette.websockets import WebSocketDisconnect

        try:
            with client.websocket_connect("/api/ws") as ws:
                ws.close()
        except WebSocketDisconnect:
            pass  # a deliberate server-side close is a pass
        except Exception as exc:  # noqa: BLE001
            message = str(exc).lower()
            # Starlette raises a plain exception when the app rejects the
            # handshake outright; that is still a deliberate refusal.
            assert "denied" in message or "403" in message or "reject" in message, (
                f"the upgrade failed in an unexpected way: {exc!r}"
            )


class TestNothingElseBreaks:
    def test_the_capability_endpoint_is_reachable_and_carries_no_secret(
        self, client, monkeypatch
    ):
        monkeypatch.setenv("HASS_URL", "http://hp.local:8123")
        monkeypatch.setenv("HASS_TOKEN", "hass-SECRET-TOKEN-VALUE")

        response = client.get("/api/system/capabilities")
        if response.status_code in (401, 403):
            pytest.skip("auth is required in this configuration")
        assert response.status_code == 200
        body = response.text
        assert "hass-SECRET-TOKEN-VALUE" not in body
        payload = response.json()
        assert "capabilities" in payload
        assert any(c["key"] == "home_assistant" for c in payload["capabilities"])

    def test_an_existing_route_still_answers(self, client):
        # The middleware runs on every request; a mistake here would take the
        # whole surface down rather than one header with it.
        assert client.get("/api/system/health").status_code in (200, 401, 403)
