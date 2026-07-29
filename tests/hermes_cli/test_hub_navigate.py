"""`hub_navigate` — the fence around agent-driven navigation.

The agent reads untrusted content, so a navigation payload is an injection
target. Both sides validate independently; this covers the server side and
asserts the two allow-lists have not drifted apart.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from tools.hub_navigate_tools import NAVIGABLE_ROUTES, _handle_navigate


def call(**kwargs) -> dict:
    raw = json.loads(_handle_navigate(kwargs))
    body = raw.get("result", raw)
    return json.loads(body) if isinstance(body, str) else body


def is_error(**kwargs) -> bool:
    return "error" in json.loads(_handle_navigate(kwargs)) or "error" in _handle_navigate(kwargs)


class TestAllowList:
    def test_an_allow_listed_route_is_accepted(self):
        out = call(route="/review", reason="You asked to see it.")
        assert out["route"] == "/review"

    @pytest.mark.parametrize(
        "route",
        ["/admin", "/etc/passwd", "https://evil.example", "//evil.example",
         "javascript:alert(1)", "/review/../secrets", ""],
    )
    def test_anything_off_the_list_is_refused(self, route):
        assert is_error(route=route, reason="because")

    def test_the_refusal_names_the_valid_choices(self):
        raw = _handle_navigate({"route": "/nope", "reason": "x"})
        assert "/review" in raw and "/now" in raw


class TestReasonIsMandatory:
    def test_a_move_with_no_reason_is_refused(self):
        # The reason is what gets announced before focus moves; without it the
        # jump is indistinguishable from the app glitching.
        assert is_error(route="/review")
        assert is_error(route="/review", reason="   ")

    def test_the_reason_is_carried_through(self):
        out = call(route="/now", reason="Two things need you.")
        assert out["reason"] == "Two things need you."


class TestFragmentSafety:
    @pytest.mark.parametrize(
        "value",
        ["../secrets", "//host", "javascript:x", 'a"b', "a b", "a\\b", "a`b", "x" * 201],
    )
    def test_unsafe_fragments_are_refused(self, value):
        assert is_error(route="/vault", reason="look", entity_id=value)

    def test_a_reasonable_entity_id_passes(self):
        out = call(route="/vault", reason="look", entity_id="note-42")
        assert out["route"] == "/vault"

    def test_every_fragment_field_is_checked_not_just_entity_id(self):
        for field in ("view", "filter", "range"):
            assert is_error(**{"route": "/jobs", "reason": "look", field: "../x"})


class TestDeliveryIsHonest:
    def test_it_reports_when_nothing_was_listening(self, monkeypatch):
        """Claiming to have moved a dashboard that is not open would be a lie."""
        import builtins

        real_import = builtins.__import__

        def no_events(name, *a, **k):
            if name == "hermes_cli.events":
                raise ImportError("no event bus here")
            return real_import(name, *a, **k)

        monkeypatch.setattr(builtins, "__import__", no_events)
        out = call(route="/now", reason="check")
        assert out["navigated"] is False
        assert "nothing moved" in out["note"].lower()


class TestBothSidesAgree:
    def test_the_allow_lists_have_not_drifted(self):
        """A route added on one side only would half-work in a confusing way."""
        source = Path("web/src/lib/hubNavigate.ts").read_text(encoding="utf-8")
        block = re.search(
            r"export const NAVIGABLE_ROUTES = \[(.*?)\] as const;", source, re.S
        )
        assert block, "could not find NAVIGABLE_ROUTES in the frontend"
        frontend = set(re.findall(r'"([^"]+)"', block.group(1)))
        assert frontend == set(NAVIGABLE_ROUTES), (
            f"only in frontend: {sorted(frontend - set(NAVIGABLE_ROUTES))}; "
            f"only in backend: {sorted(set(NAVIGABLE_ROUTES) - frontend)}"
        )


class TestRegistration:
    def test_the_tool_is_discoverable_and_auto_tier(self):
        from tools.registry import _module_registers_tools

        assert _module_registers_tools(Path("tools/hub_navigate_tools.py")) is True

        import tools.hub_navigate_tools  # noqa: F401
        from hermes_cli.module_permissions import Tier, get_tier

        # AUTO because emitting an intent changes nothing by itself — the
        # frontend validates, announces, and asks before interrupting.
        assert get_tier("hub_navigate") is Tier.AUTO
