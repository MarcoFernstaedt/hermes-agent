"""The permission tier, consumed at the chokepoint.

Before this, `module_permissions.resolve()` had no production caller. A tool's
tier was recorded and never enforced, and `registry.dispatch()` reached
handlers without consulting it — so Gmail was safe only because its own handler
happened to contain a Gmail-shaped gate, and every other non-AUTO tool ran on
the strength of a classification nothing read.

Every refusal test here asserts the handler was called **zero** times. A gate
that refuses after the side effect is not a gate.
"""
from __future__ import annotations

import json

import pytest

from hermes_cli import execution_capability as cap
from hermes_cli.module_permissions import Tier


def mint(**kw):
    """`cap.mint` with the identity fields every capability now requires.

    Session, call id and approver are mandatory in production — a grant that
    matches any session, any call, or nobody in particular is not scoped to
    anything. Defaulting them here keeps each test naming only the field it is
    actually about.
    """
    kw.setdefault("session_id", "s1")
    kw.setdefault("tool_call_id", "c1")
    kw.setdefault("approver", "test:owner")
    kw.setdefault("receipt", "human_cli:once:r1")
    return cap.mint(**kw)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    cap.revoke_all()
    monkeypatch.setenv("HERMES_TOOL_GATE_MODE", "enforce")
    # Trust nothing unless a test says otherwise.
    monkeypatch.setattr("tools.registry._trusted_tools", lambda: ())
    yield
    cap.revoke_all()


@pytest.fixture(autouse=True)
def _inside_a_call():
    """Every test here runs as if the agent loop were inside call ``c1``.

    Production dispatch reads the correlation id from the approval
    contextvar the agent loop binds around each tool call. Without it the
    gate refuses on *missing identity* before it ever compares the token —
    which would make the binding tests below pass for the wrong reason.
    `TestACallMustIdentifyItself` covers the unbound case deliberately.
    """
    from tools import approval

    tokens = approval.set_current_observability_context(tool_call_id="c1")
    try:
        yield
    finally:
        approval.reset_current_observability_context(tokens)


@pytest.fixture
def gated(monkeypatch):
    """A registered tool at a given tier, and a record of every execution."""
    calls: list[dict] = []

    def make(tier: Tier, name: str = "probe_tool"):
        from tools.registry import ToolRegistry

        reg = ToolRegistry()
        reg.register(
            name=name,
            toolset="test",
            schema={"name": name, "parameters": {}},
            handler=lambda args, **kw: (calls.append(dict(args)), "ran")[1],
        )
        monkeypatch.setattr(
            "hermes_cli.module_permissions.get_tier", lambda n, _t=tier: _t
        )
        return reg, calls

    return make


def refused(result) -> bool:
    payload = json.loads(result) if isinstance(result, str) else result
    return bool(payload.get("refused"))


class TestAutoToolsAreUnaffected:
    def test_a_read_runs_without_any_capability(self, gated):
        reg, calls = gated(Tier.AUTO)
        assert reg.dispatch("probe_tool", {"q": 1}) == "ran"
        assert len(calls) == 1


class TestNonAutoToolsNeedACapability:
    @pytest.mark.parametrize("tier", [Tier.APPROVAL, Tier.ALWAYS_APPROVAL])
    def test_no_capability_refuses_without_running_the_handler(self, gated, tier):
        reg, calls = gated(tier)
        result = reg.dispatch("probe_tool", {"q": 1})
        assert refused(result)
        assert calls == [], "the handler ran despite a refusal"

    def test_an_unregistered_tool_is_treated_as_the_strictest(self, gated):
        # `get_tier` defaults unknown tools to ALWAYS_APPROVAL, and the gate
        # has to honour that rather than treating "no entry" as "no rules".
        from tools.registry import ToolRegistry

        calls: list = []
        reg = ToolRegistry()
        reg.register(
            name="never_registered", toolset="test",
            schema={"name": "never_registered", "parameters": {}},
            handler=lambda args, **kw: (calls.append(args), "ran")[1],
        )
        assert refused(reg.dispatch("never_registered", {}))
        assert calls == []

    def test_a_valid_capability_lets_it_run(self, gated):
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        args = {"q": 1}
        token = mint(
            tool_name="probe_tool", tool_call_id="c1", args=args,
            source=cap.SOURCE_HUMAN, receipt="human_cli:once:r1",
        ).token
        assert reg.dispatch("probe_tool", args, capability=token, session_id="s1") == "ran"
        assert len(calls) == 1

    def test_a_capability_for_a_different_call_is_refused(self, gated):
        """One approval authorises one call, not the next one that looks alike.

        Same tool, same arguments, same session — a different tool call id.
        Without this the gate would let a single "yes" cover a retry loop.
        """
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        args = {"q": 1}
        token = mint(
            tool_name="probe_tool", tool_call_id="some-other-call", args=args,
            source=cap.SOURCE_HUMAN, receipt="human_cli:once:r1",
        ).token
        result = reg.dispatch("probe_tool", args, capability=token, session_id="s1")
        assert refused(result)
        assert calls == []

    def test_a_capability_from_another_session_is_refused(self, gated):
        # Consent given in one conversation must not authorise another.
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        args = {"q": 1}
        token = mint(
            tool_name="probe_tool", session_id="other-session", args=args,
            source=cap.SOURCE_HUMAN, receipt="human_cli:once:r1",
        ).token
        result = reg.dispatch("probe_tool", args, capability=token, session_id="s1")
        assert refused(result)
        assert calls == []


class TestACallMustIdentifyItself:
    """A call with no correlation identity cannot be matched to an approval.

    These deliberately run *outside* the module's autouse call context, so the
    gate sees exactly what a caller that never bound one would present.
    """

    @pytest.fixture(autouse=True)
    def _no_call_context(self):
        from tools import approval

        tokens = approval.set_current_observability_context(tool_call_id="")
        try:
            yield
        finally:
            approval.reset_current_observability_context(tokens)

    def test_an_unidentified_call_is_refused_even_holding_a_capability(self, gated):
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        args = {"q": 1}
        token = mint(
            tool_name="probe_tool", args=args,
            source=cap.SOURCE_HUMAN, receipt="human_cli:once:r1",
        ).token
        result = reg.dispatch("probe_tool", args, capability=token, session_id="s1")
        assert refused(result)
        assert calls == []

    def test_an_unidentified_call_is_refused_with_no_capability(self, gated):
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        assert refused(reg.dispatch("probe_tool", {"q": 1}, session_id="s1"))
        assert calls == []


class TestACapabilityIsBoundAndSingleUse:
    def test_a_replayed_capability_is_refused(self, gated):
        # One approval must not become several executions.
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        args = {"q": 1}
        token = mint(tool_name="probe_tool", tool_call_id="c1", args=args,
                         source=cap.SOURCE_HUMAN, receipt="human_cli:once:r1").token

        assert reg.dispatch("probe_tool", args, capability=token, session_id="s1") == "ran"
        assert refused(reg.dispatch("probe_tool", args, capability=token, session_id="s1"))
        assert len(calls) == 1

    def test_arguments_changed_after_approval_are_refused(self, gated):
        # Approving one call must not execute a different one.
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        token = mint(tool_name="probe_tool", tool_call_id="c1",
                         args={"to": "bob"}, source=cap.SOURCE_HUMAN,
                         receipt="human_cli:once:r1").token
        assert refused(
            reg.dispatch("probe_tool", {"to": "eve"}, capability=token,
                         session_id="s1")
        )
        assert calls == []

    def test_a_capability_for_another_tool_is_refused(self, gated):
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        token = mint(tool_name="other_tool", tool_call_id="c1", args={},
                         source=cap.SOURCE_HUMAN, receipt="human_cli:once:r1").token
        assert refused(reg.dispatch("probe_tool", {}, capability=token,
                                    session_id="s1"))
        assert calls == []

    def test_an_expired_capability_is_refused(self, gated):
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        args = {"q": 1}
        c = mint(tool_name="probe_tool", tool_call_id="c1", args=args,
                     source=cap.SOURCE_HUMAN, receipt="human_cli:once:r1",
                     now=1000.0)
        with pytest.raises(cap.CapabilityError, match="expired"):
            cap.consume(c.token, tool_name="probe_tool", args=args,
                        session_id="s1", tool_call_id="c1",
                        now=1000.0 + cap.DEFAULT_TTL_SECONDS + 1)
        assert calls == []

    def test_an_invented_token_is_refused(self, gated):
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        assert refused(reg.dispatch("probe_tool", {}, capability="made-up"))
        assert calls == []


class TestMintingRequiresIdentity:
    def test_a_capability_without_a_call_id_is_refused(self):
        # Without a correlation identity there is no way to say which call a
        # decision belonged to, and a capability matching any call is not one.
        with pytest.raises(cap.CapabilityError, match="the call it authorises"):
            mint(tool_name="probe_tool", tool_call_id="", args={},
                     source=cap.SOURCE_HUMAN, receipt="human_cli:once:r1")

    def test_an_unknown_source_is_refused(self):
        with pytest.raises(cap.CapabilityError, match="unknown capability source"):
            mint(tool_name="probe_tool", tool_call_id="c1", args={},
                     source="vibes", receipt="human_cli:once:r1")

    def test_every_source_is_recorded_for_the_audit(self):
        for source in (
            cap.SOURCE_HUMAN, cap.SOURCE_TRUSTED_TOOL,
            cap.SOURCE_STANDING, cap.SOURCE_OWNER_BYPASS,
        ):
            c = mint(tool_name="t", tool_call_id="c", args={}, source=source,
                         tier="approval", receipt=f"{source}:once:r")
            assert c.source == source

    def test_a_capability_without_a_receipt_is_refused(self):
        # An approval nobody can be traced back to is not evidence of one.
        with pytest.raises(cap.CapabilityError, match="identity of the response"):
            mint(tool_name="t", tool_call_id="c", args={},
                     source=cap.SOURCE_HUMAN, receipt="")

    def test_an_always_approval_tool_cannot_be_minted_from_a_standing_grant(self):
        """The rule the strictest tier exists for, held in the broker itself.

        A caller that forgets it — or a future caller that never knew it —
        cannot mint a standing grant for a tool the owner declared always-ask.
        """
        for source in (cap.SOURCE_STANDING, cap.SOURCE_OWNER_BYPASS,
                       cap.SOURCE_TRUSTED_TOOL):
            with pytest.raises(cap.CapabilityError, match="only a person"):
                mint(tool_name="gmail_send", tool_call_id="c", args={},
                         source=source, tier="always_approval",
                         receipt=f"{source}:once:r")


class TestTrustedTools:
    def test_an_approval_tier_tool_the_owner_trusts_runs_without_a_prompt(
        self, gated, monkeypatch
    ):
        reg, calls = gated(Tier.APPROVAL)
        monkeypatch.setattr("tools.registry._trusted_tools", lambda: ("probe_tool",))
        assert reg.dispatch("probe_tool", {}) == "ran"
        assert len(calls) == 1

    def test_trusting_an_always_approval_tool_changes_nothing(self, gated, monkeypatch):
        # The whole point of the strictest tier: it cannot be opted out of.
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        monkeypatch.setattr("tools.registry._trusted_tools", lambda: ("probe_tool",))
        assert refused(reg.dispatch("probe_tool", {}))
        assert calls == []

    def test_an_unreadable_trust_list_trusts_nothing(self, gated, monkeypatch):
        reg, calls = gated(Tier.APPROVAL)

        def boom():
            raise RuntimeError("config unreadable")

        monkeypatch.setattr("tools.registry._trusted_tools", boom)
        assert refused(reg.dispatch("probe_tool", {}))
        assert calls == []


class TestFailClosed:
    @pytest.mark.parametrize(
        "symbol", ["resolve_call", "tier_for_call", "get_tier"]
    )
    def test_a_broken_permission_lookup_refuses_rather_than_allows(
        self, gated, monkeypatch, symbol
    ):
        """An exception in the permission layer must never read as permission.

        Parametrised over every entry point the gate actually calls, because
        the failure this guards against is not "one function raises" — it is
        "the layer cannot answer", and which function that surfaces through
        changes whenever the layer is refactored.
        """
        reg, calls = gated(Tier.AUTO)

        def boom(*a, **kw):
            raise RuntimeError("permission layer exploded")

        monkeypatch.setattr(f"hermes_cli.module_permissions.{symbol}", boom)
        assert refused(reg.dispatch("probe_tool", {}))
        assert calls == []

    def test_requires_capability_defaults_to_yes_on_error(self, monkeypatch):
        monkeypatch.setattr(
            "hermes_cli.module_permissions.resolve_call",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("nope")),
        )
        assert cap.requires_capability("anything") is True

    def test_consume_raises_rather_than_returning_false(self):
        # A caller that forgets to check a boolean executes anyway; this is the
        # one check where forgetting must not be survivable.
        with pytest.raises(cap.CapabilityError):
            cap.consume(None, tool_name="t", args={}, tool_call_id="c", session_id="s1")


class TestObserveMode:
    """The default, and honestly a gap rather than a setting.

    `get_tier()` returns ALWAYS_APPROVAL for unregistered tools, and most tools
    in this repository were never registered — so enforcing immediately would
    refuse nearly every call. `observe` audits what *would* be refused so the
    backlog is measurable against real traffic.
    """

    def test_observe_lets_the_call_through(self, gated, monkeypatch):
        monkeypatch.setenv("HERMES_TOOL_GATE_MODE", "observe")
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        assert reg.dispatch("probe_tool", {}) == "ran"
        assert len(calls) == 1

    def test_observe_audits_what_it_would_have_refused(self, gated, monkeypatch):
        monkeypatch.setenv("HERMES_TOOL_GATE_MODE", "observe")
        rows: list[dict] = []
        monkeypatch.setattr("hermes_cli.audit_log.record", lambda **kw: rows.append(kw))

        reg, _ = gated(Tier.ALWAYS_APPROVAL)
        reg.dispatch("probe_tool", {})

        assert rows, "an unenforced refusal must still be visible"
        assert rows[0]["action"] == "capability_missing"
        assert rows[0]["outcome"] == "observed"
        assert rows[0]["tool"] == "probe_tool"

    def test_enforce_records_the_refusal_as_enforced(self, gated, monkeypatch):
        rows: list[dict] = []
        monkeypatch.setattr("hermes_cli.audit_log.record", lambda **kw: rows.append(kw))
        reg, _ = gated(Tier.ALWAYS_APPROVAL)
        reg.dispatch("probe_tool", {})
        assert rows[0]["outcome"] == "refused"

    def test_an_unset_mode_refuses_rather_than_choosing_the_weakest(
        self, monkeypatch
    ):
        """A control whose *absence* selects its own weakest setting is not one.

        This used to return `observe`, so "nobody has configured this" was
        indistinguishable from "somebody chose to measure". The shipped default
        is still observe — but the product states it at startup via
        `apply_default_gate_modes()`; the check does not invent it.
        """
        from tools.registry import GateModeError, tool_gate_mode

        monkeypatch.delenv("HERMES_TOOL_GATE_MODE", raising=False)
        with pytest.raises(GateModeError, match="not set"):
            tool_gate_mode()

    def test_a_misspelled_mode_refuses(self, monkeypatch):
        # `HERMES_TOOL_GATE_MODE=enfore` in a deployment used to silently
        # downgrade a machine somebody had deliberately switched to enforcing.
        from tools.registry import GateModeError, tool_gate_mode

        monkeypatch.setenv("HERMES_TOOL_GATE_MODE", "enfore")
        with pytest.raises(GateModeError, match="not one of"):
            tool_gate_mode()

    def test_a_call_with_no_mode_configured_never_reaches_the_handler(
        self, gated, monkeypatch
    ):
        reg, calls = gated(Tier.AUTO)
        monkeypatch.delenv("HERMES_TOOL_GATE_MODE", raising=False)
        assert refused(reg.dispatch("probe_tool", {}))
        assert calls == []

    def test_a_call_with_a_misspelled_mode_never_reaches_the_handler(
        self, gated, monkeypatch
    ):
        reg, calls = gated(Tier.AUTO)
        monkeypatch.setenv("HERMES_TOOL_GATE_MODE", "enfore")
        assert refused(reg.dispatch("probe_tool", {}))
        assert calls == []

    def test_the_product_default_is_observe_and_it_is_stated(self, monkeypatch):
        from hermes_constants import (
            DEFAULT_TOOL_GATE_MODE,
            apply_default_gate_modes,
        )
        from tools.registry import tool_gate_mode

        monkeypatch.delenv("HERMES_TOOL_GATE_MODE", raising=False)
        apply_default_gate_modes()
        assert DEFAULT_TOOL_GATE_MODE == "observe"
        assert tool_gate_mode() == "observe"

    def test_seeding_never_overwrites_an_operators_choice(self, monkeypatch):
        from hermes_constants import apply_default_gate_modes
        from tools.registry import tool_gate_mode

        monkeypatch.setenv("HERMES_TOOL_GATE_MODE", "enforce")
        apply_default_gate_modes()
        assert tool_gate_mode() == "enforce"


class TestDirectRegistryDispatchIsCovered:
    def test_the_bypass_the_review_found_is_closed(self, gated):
        """`registry.dispatch()` was reachable without any permission check.

        That is what made the tier system decorative: anything holding the
        registry could invoke a handler directly, and the only tool that
        survived did so because its handler contained its own gate.
        """
        reg, calls = gated(Tier.ALWAYS_APPROVAL)
        assert refused(reg.dispatch("probe_tool", {"anything": True}))
        assert calls == []
