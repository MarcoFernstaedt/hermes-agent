"""Security headers, sized to a Tailnet-only deployment.

The constraint that shapes every test: a header that breaks the app is worse
than the header's absence. This dashboard speaks WebSockets on the same origin
and sits behind Tailscale Serve, and a CSP that kills either does not fail
loudly — the socket simply never opens.
"""
from __future__ import annotations

import pytest

from hermes_cli.security_headers import (
    CSP_DIRECTIVES,
    is_secure_request,
    security_headers,
    should_apply,
)


def csp(**kw) -> str:
    return security_headers(secure=True, **kw).get("Content-Security-Policy", "")


class TestTheCspDoesNotBreakTheApp:
    def test_websockets_are_allowed_or_chat_dies_silently(self):
        # The chat transport and the event feed are both WebSockets. A CSP
        # that omits these produces an app that looks fine and never connects.
        connect = next(d for d in CSP_DIRECTIVES if d.startswith("connect-src"))
        assert "ws:" in connect and "wss:" in connect

    def test_blob_urls_are_allowed_for_captured_media(self):
        # Camera frames and recorded audio become object URLs.
        assert "blob:" in next(d for d in CSP_DIRECTIVES if d.startswith("media-src"))
        assert "blob:" in next(d for d in CSP_DIRECTIVES if d.startswith("img-src"))

    def test_inline_styles_are_allowed_because_the_build_emits_them(self):
        style = next(d for d in CSP_DIRECTIVES if d.startswith("style-src"))
        assert "'unsafe-inline'" in style

    def test_inline_scripts_are_not(self):
        # An inline style cannot execute; an inline script can. The asymmetry
        # is the whole point of listing them separately.
        script = next(d for d in CSP_DIRECTIVES if d.startswith("script-src"))
        assert "'unsafe-inline'" not in script
        assert "'unsafe-eval'" not in script

    def test_no_third_party_origin_is_permitted_anywhere(self):
        # No CDNs, no external fonts, no telemetry. A product constraint that
        # the CSP turns from an intention into an enforcement.
        for directive in CSP_DIRECTIVES:
            assert "http://" not in directive
            assert "https://" not in directive

    def test_nothing_may_frame_this_and_it_frames_nothing(self):
        assert "frame-ancestors 'none'" in CSP_DIRECTIVES
        assert "frame-src 'none'" in CSP_DIRECTIVES


class TestHstsOnlyWhenItMeansSomething:
    def test_it_is_sent_on_a_secure_request(self):
        assert "Strict-Transport-Security" in security_headers(secure=True)

    def test_it_is_absent_on_plain_http(self):
        # Over HTTP it is meaningless, and from behind the wrong proxy it can
        # pin a hostname the owner did not intend.
        assert "Strict-Transport-Security" not in security_headers(secure=False)

    def test_it_does_not_preload(self):
        # Preload is a one-way door on a domain the owner may want back.
        value = security_headers(secure=True)["Strict-Transport-Security"]
        assert "preload" not in value


class TestDetectingTheClientsProtocol:
    def test_a_direct_https_request_is_secure(self):
        assert is_secure_request("https") is True

    def test_a_direct_http_request_is_not(self):
        assert is_secure_request("http") is False

    def test_the_forwarded_header_wins_behind_a_proxy(self):
        # Tailscale Serve terminates TLS and forwards over HTTP, so the app's
        # own scheme says `http` for a request the browser made over `https`.
        # Reading only the scheme would never emit HSTS on the one deployment
        # that wants it.
        assert is_secure_request("http", forwarded_proto="https") is True

    def test_a_proxy_chain_reports_the_clients_hop(self):
        assert is_secure_request("http", forwarded_proto="https, http") is True
        assert is_secure_request("https", forwarded_proto="http, https") is False

    def test_an_empty_forwarded_header_falls_back_to_the_scheme(self):
        assert is_secure_request("https", forwarded_proto="") is True
        assert is_secure_request("https", forwarded_proto="   ") is True


class TestPowerfulFeatures:
    def test_microphone_camera_and_location_are_allowed_for_this_origin(self):
        # They are needed. Permitting them for self while denying every third
        # party is the protection — not refusing them outright, which would
        # only mean the features do not work.
        policy = security_headers(secure=True)["Permissions-Policy"]
        for feature in ("microphone=(self)", "camera=(self)", "geolocation=(self)"):
            assert feature in policy

    def test_payment_and_device_apis_are_denied_outright(self):
        policy = security_headers(secure=True)["Permissions-Policy"]
        for feature in ("payment=()", "usb=()", "midi=()"):
            assert feature in policy


class TestAlwaysOn:
    @pytest.mark.parametrize("secure", [True, False])
    def test_content_type_sniffing_is_off_on_every_response(self, secure):
        # A JSON body sniffed as HTML is an XSS vector whatever the endpoint
        # intended.
        assert security_headers(secure=secure)["X-Content-Type-Options"] == "nosniff"

    @pytest.mark.parametrize("secure", [True, False])
    def test_referrers_never_leak_a_path_off_origin(self, secure):
        assert (
            security_headers(secure=secure)["Referrer-Policy"]
            == "strict-origin-when-cross-origin"
        )


class TestApiResponsesAreNotDocuments:
    def test_json_responses_carry_no_csp(self):
        # A CSP on a JSON body costs bytes on every call and constrains no
        # document context.
        headers = security_headers(secure=True, is_html=False)
        assert "Content-Security-Policy" not in headers
        assert "X-Frame-Options" not in headers

    def test_json_responses_still_get_the_transport_protections(self):
        headers = security_headers(secure=True, is_html=False)
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert "Strict-Transport-Security" in headers


class TestTheWebsocketPathIsLeftAlone:
    def test_the_upgrade_path_is_excluded(self):
        # Headers on a 101 are ignored at best and rejected by an intermediary
        # at worst, and a chat that will not connect is a broken dashboard.
        assert should_apply("/api/ws") is False
        assert should_apply("/api/ws/anything") is False

    def test_everything_else_is_covered(self):
        for path in ("/", "/now", "/api/system/capabilities", "/assets/index.js"):
            assert should_apply(path) is True
