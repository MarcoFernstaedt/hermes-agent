"""Tests for the tiered module-tool permission model."""

import pytest

from hermes_cli import module_permissions as mp
from hermes_cli.module_permissions import Decision, Tier


@pytest.fixture(autouse=True)
def _clean_registry():
    mp._reset_for_tests()
    yield
    mp._reset_for_tests()


def test_auto_tier_always_allows():
    mp.register_tool_permission("media.get_state", Tier.AUTO)
    assert mp.resolve("media.get_state") is Decision.ALLOW


def test_approval_tier_requires_approval_unless_trusted():
    mp.register_tool_permission("calendar.create_event", Tier.APPROVAL)
    assert mp.resolve("calendar.create_event") is Decision.REQUIRE_APPROVAL
    assert (
        mp.resolve("calendar.create_event", trusted_tools={"calendar.create_event"})
        is Decision.ALLOW
    )


def test_always_approval_can_never_be_auto_approved():
    mp.register_tool_permission("email.send", Tier.ALWAYS_APPROVAL)
    # Even if the user tries to trust it, it still requires approval.
    assert (
        mp.resolve("email.send", trusted_tools={"email.send"})
        is Decision.REQUIRE_APPROVAL
    )
    assert mp.can_be_trusted("email.send") is False


def test_only_approval_tier_can_be_trusted():
    mp.register_tool_permission("notes.append", Tier.APPROVAL)
    mp.register_tool_permission("notes.read", Tier.AUTO)
    assert mp.can_be_trusted("notes.append") is True
    assert mp.can_be_trusted("notes.read") is False


def test_unknown_tool_fails_safe_to_always_approval():
    assert mp.get_tier("never.registered") is Tier.ALWAYS_APPROVAL
    assert (
        mp.resolve("never.registered", trusted_tools={"never.registered"})
        is Decision.REQUIRE_APPROVAL
    )


def test_reregister_same_tier_is_noop_but_change_raises():
    mp.register_tool_permission("x.tool", Tier.APPROVAL)
    mp.register_tool_permission("x.tool", Tier.APPROVAL)  # no-op
    with pytest.raises(ValueError):
        mp.register_tool_permission("x.tool", Tier.AUTO)
