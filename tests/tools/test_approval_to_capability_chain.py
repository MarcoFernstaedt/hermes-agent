"""The whole chain, end to end, with a real human on the other end of it.

The principal test in this file mints nothing. It registers a gateway notify
callback — the same one Discord, Telegram and the desktop app register — waits
for a real `approval.request` to arrive on it, answers it the way
`approval.respond` answers it, and then checks that the handler ran. Every
other route to a capability is a test-only shortcut, and a suite built on one
would pass while the production path stayed broken. That is the failure mode
this file exists to prevent: the previous version of this system had a gate at
dispatch, a broker that could mint, and nothing at all in between.

The second thing it checks is the shape of the negative space. `_run_approval_gate`
returns ``approved: True`` from five different places and only two of them are
a person answering a prompt. A cron job under ``cron_mode: approve`` and the
historical non-interactive fall-open both return it too, and neither is
consent. Those paths must produce no capability, which means a gated tool
refuses under them — and it must refuse *before* the handler, not after.
"""
from __future__ import annotations

import json

import pytest

from hermes_cli import execution_capability as capabilities
from hermes_cli.module_permissions import Tier


SESSION = "session-under-test"
CALL_ID = "toolu_probe_0001"


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    """A gateway session, nothing trusted, nothing approved, gate enforcing."""
    from tools import approval

    capabilities.revoke_all()
    monkeypatch.setenv("HERMES_TOOL_GATE_MODE", "enforce")
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    monkeypatch.setattr("tools.registry._trusted_tools", lambda: ())
    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", False)
    monkeypatch.setattr(approval, "_permanent_approved", set())
    monkeypatch.setattr(approval, "_session_approved", {})

    session_token = approval.set_current_session_key(SESSION)
    obs_tokens = approval.set_current_observability_context(
        turn_id="turn-1", tool_call_id=CALL_ID
    )
    try:
        yield
    finally:
        approval.reset_current_observability_context(obs_tokens)
        approval.reset_current_session_key(session_token)
        approval.unregister_gateway_notify(SESSION)
        capabilities.revoke_all()


@pytest.fixture
def tool(monkeypatch):
    """A registered tool at a chosen tier, and a log of every execution."""

    def make(tier: Tier, name: str = "probe_tool"):
        from tools.registry import ToolRegistry

        calls: list[dict] = []
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


@pytest.fixture
def owner():
    """The person on the other end of the approval card.

    Registers the real per-session notify callback and answers through
    `resolve_gateway_approval` — the same function the gateway's
    ``approval.respond`` RPC calls. Nothing here reaches into the capability
    broker.
    """
    from tools.approval import register_gateway_notify, resolve_gateway_approval

    seen: list[dict] = []

    def answers(choice: str):
        def notify(payload: dict) -> None:
            seen.append(payload)
            # The card is queued before notify runs, so answering here resolves
            # the entry the agent thread is about to wait on.
            resolve_gateway_approval(SESSION, choice)

        register_gateway_notify(SESSION, notify)
        return seen

    answers.seen = seen
    return answers


def refused(result) -> bool:
    payload = json.loads(result) if isinstance(result, str) else result
    return bool(payload.get("refused"))


class TestTheGenuineApprovedPath:
    """No test-only minting anywhere in this class."""

    def test_a_human_approving_the_card_is_what_lets_the_handler_run(
        self, tool, owner
    ):
        reg, calls = tool(Tier.ALWAYS_APPROVAL)
        cards = owner("once")

        assert reg.dispatch("probe_tool", {"to": "bob"}, session_id=SESSION) == "ran"

        assert len(cards) == 1, "the owner was never actually asked"
        assert calls == [{"to": "bob"}], "the handler did not run once"

    def test_the_card_describes_the_call_being_judged(self, tool, owner):
        reg, _ = tool(Tier.ALWAYS_APPROVAL)
        cards = owner("once")
        reg.dispatch("probe_tool", {"to": "bob", "subject": "hi"}, session_id=SESSION)

        card = cards[0]
        assert "probe_tool" in card["description"]
        preview = card["preview"]
        assert preview["tool"] == "probe_tool"
        # The arguments, so the owner judges the action rather than a label.
        assert preview["arguments"] == {"to": "bob", "subject": "hi"}

    def test_an_always_approval_card_does_not_offer_a_standing_grant(
        self, tool, owner
    ):
        # A card that offers "always" for an action that cannot be granted
        # always is a card that lies about what the button does.
        reg, _ = tool(Tier.ALWAYS_APPROVAL)
        cards = owner("once")
        reg.dispatch("probe_tool", {}, session_id=SESSION)

        assert cards[0]["allow_permanent"] is False
        assert cards[0]["choices"] == ["once", "deny"]

    def test_denial_stops_the_handler_being_reached(self, tool, owner):
        reg, calls = tool(Tier.ALWAYS_APPROVAL)
        owner("deny")

        assert refused(reg.dispatch("probe_tool", {}, session_id=SESSION))
        assert calls == [], "the handler ran despite a denial"

    def test_one_approval_authorises_one_execution(self, tool, owner):
        """Approving once must not license a retry loop.

        The second dispatch asks again — which is correct — so the owner is
        made to answer twice for two executions rather than once for both.
        """
        reg, calls = tool(Tier.ALWAYS_APPROVAL)
        cards = owner("once")

        reg.dispatch("probe_tool", {"n": 1}, session_id=SESSION)
        reg.dispatch("probe_tool", {"n": 1}, session_id=SESSION)

        assert len(calls) == 2
        assert len(cards) == 2, "the second execution reused the first approval"

    def test_nothing_is_left_live_after_the_call(self, tool, owner):
        reg, _ = tool(Tier.ALWAYS_APPROVAL)
        owner("once")
        reg.dispatch("probe_tool", {}, session_id=SESSION)
        assert capabilities.live_count() == 0


class TestTheEvidenceIsBoundToTheCall:
    def test_the_capability_records_who_said_yes(self, tool, owner, monkeypatch):
        reg, _ = tool(Tier.ALWAYS_APPROVAL)
        owner("once")

        spent: list = []
        real = capabilities.consume

        def watching(*a, **kw):
            cap = real(*a, **kw)
            spent.append(cap)
            return cap

        monkeypatch.setattr(capabilities, "consume", watching)
        monkeypatch.setattr("hermes_cli.tool_capability.capabilities.consume", watching)
        reg.dispatch("probe_tool", {"to": "bob"}, session_id=SESSION)

        cap = spent[-1]
        assert cap.source == capabilities.SOURCE_HUMAN
        assert cap.session_id == SESSION
        assert cap.tool_call_id == CALL_ID
        assert cap.tool_name == "probe_tool"
        assert cap.tier == "always_approval"
        assert cap.receipt.startswith("human_gateway:once:")
        assert cap.args_fingerprint == capabilities.argument_fingerprint({"to": "bob"})

    def test_a_capability_from_one_session_does_not_authorise_another(self, tool, owner):
        """The same call, in a different conversation, is asked about again.

        Identical tool, identical arguments, identical call id — and the
        approval given in the first session does not reach the second, because
        the session is part of what was agreed.
        """
        reg, calls = tool(Tier.ALWAYS_APPROVAL)
        cards = owner("once")

        reg.dispatch("probe_tool", {"n": 1}, session_id=SESSION)
        reg.dispatch("probe_tool", {"n": 1}, session_id="a-different-session")

        assert len(calls) == 2
        assert len(cards) == 2, "the second session reused the first's approval"

    def test_the_broker_refuses_a_capability_presented_by_another_session(self):
        cap = capabilities.mint(
            tool_name="probe_tool", tool_call_id=CALL_ID, args={"n": 1},
            session_id=SESSION, tier="always_approval",
            source=capabilities.SOURCE_HUMAN, receipt="human_gateway:once:r1",
        )
        with pytest.raises(capabilities.CapabilityError, match="another session"):
            capabilities.consume(
                cap.token, tool_name="probe_tool", args={"n": 1},
                session_id="a-different-session", tool_call_id=CALL_ID,
            )


class TestThePathsThatApproveNobody:
    """Five code paths return ``approved: True``. Only two are consent."""

    def test_a_cron_auto_approval_is_not_consent(self, tool, monkeypatch):
        from tools import approval

        reg, calls = tool(Tier.APPROVAL)
        monkeypatch.delenv("HERMES_GATEWAY_SESSION", raising=False)
        monkeypatch.setenv("HERMES_CRON_SESSION", "1")
        monkeypatch.setattr(approval, "_get_cron_approval_mode", lambda: "approve")
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: False)

        result = reg.dispatch("probe_tool", {}, session_id=SESSION)
        assert refused(result)
        assert "without anyone approving it" in json.loads(result)["error"]
        assert calls == []

    def test_the_non_interactive_fall_open_is_not_consent(self, tool, monkeypatch):
        from tools import approval

        reg, calls = tool(Tier.APPROVAL)
        monkeypatch.delenv("HERMES_GATEWAY_SESSION", raising=False)
        monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: False)
        monkeypatch.setattr(approval, "_get_session_platform", lambda: "")

        assert refused(reg.dispatch("probe_tool", {}, session_id=SESSION))
        assert calls == []

    def test_a_gateway_with_nobody_listening_refuses(self, tool):
        # No notify callback registered: the gate queues a pending approval and
        # tells the agent "approval_required". That is not an approval.
        reg, calls = tool(Tier.ALWAYS_APPROVAL)
        assert refused(reg.dispatch("probe_tool", {}, session_id=SESSION))
        assert calls == []

    def test_yolo_cannot_authorise_an_always_approval_tool(self, tool, monkeypatch):
        from tools import approval

        reg, calls = tool(Tier.ALWAYS_APPROVAL)
        monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", True)

        assert refused(reg.dispatch("probe_tool", {}, session_id=SESSION))
        assert calls == [], "--yolo ran an always-approval tool"

    def test_yolo_is_recorded_as_a_bypass_not_as_an_answer(self, tool, monkeypatch):
        """It may authorise an APPROVAL-tier tool — under its own name.

        An audit that cannot tell the owner turning the gate off apart from
        the owner answering a prompt is not an audit.
        """
        from tools import approval

        reg, calls = tool(Tier.APPROVAL)
        monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", True)

        spent: list = []
        real = capabilities.consume
        monkeypatch.setattr(
            "hermes_cli.tool_capability.capabilities.consume",
            lambda *a, **kw: (lambda c: (spent.append(c), c)[1])(real(*a, **kw)),
        )
        assert reg.dispatch("probe_tool", {}, session_id=SESSION) == "ran"
        assert len(calls) == 1
        assert spent[-1].source == capabilities.SOURCE_OWNER_BYPASS


class TestStandingGrants:
    def test_a_session_answer_covers_later_calls_at_approval_tier(self, tool, owner):
        reg, calls = tool(Tier.APPROVAL)
        cards = owner("session")

        assert reg.dispatch("probe_tool", {"n": 1}, session_id=SESSION) == "ran"
        assert reg.dispatch("probe_tool", {"n": 2}, session_id=SESSION) == "ran"

        assert len(calls) == 2
        assert len(cards) == 1, "the owner was asked again after saying 'session'"

    def test_the_second_call_is_recorded_as_standing_not_as_a_fresh_answer(
        self, tool, owner, monkeypatch
    ):
        reg, _ = tool(Tier.APPROVAL)
        owner("session")
        reg.dispatch("probe_tool", {"n": 1}, session_id=SESSION)

        spent: list = []
        real = capabilities.consume
        monkeypatch.setattr(
            "hermes_cli.tool_capability.capabilities.consume",
            lambda *a, **kw: (lambda c: (spent.append(c), c)[1])(real(*a, **kw)),
        )
        reg.dispatch("probe_tool", {"n": 2}, session_id=SESSION)
        assert spent[-1].source == capabilities.SOURCE_STANDING
        assert spent[-1].receipt.startswith("standing_session:")

    def test_a_session_answer_does_not_carry_to_an_always_approval_tool(
        self, tool, owner
    ):
        reg, calls = tool(Tier.ALWAYS_APPROVAL)
        cards = owner("session")

        reg.dispatch("probe_tool", {"n": 1}, session_id=SESSION)
        reg.dispatch("probe_tool", {"n": 2}, session_id=SESSION)

        assert len(calls) == 2
        assert len(cards) == 2, "an always-approval tool honoured a standing grant"


class TestFailingClosed:
    def test_evidence_that_cannot_be_recorded_is_not_an_approval(
        self, tool, owner, monkeypatch
    ):
        """The owner said yes and the mint failed. The action must not happen.

        This is the edge where a system usually leaks: the human intent was
        positive, so it is tempting to proceed and log the bookkeeping failure.
        Then the audit has no record of an action that took place.
        """
        reg, calls = tool(Tier.ALWAYS_APPROVAL)
        owner("once")
        monkeypatch.setattr(
            "hermes_cli.tool_capability.capabilities.mint",
            lambda **kw: (_ for _ in ()).throw(RuntimeError("broker unavailable")),
        )

        assert refused(reg.dispatch("probe_tool", {}, session_id=SESSION))
        assert calls == []

    def test_a_call_with_no_correlation_id_cannot_be_approved(self, tool, owner):
        # A capability has to name which call it authorises. Without an id
        # there is nothing to bind, so there is nothing that could be agreed.
        from tools import approval

        reg, calls = tool(Tier.ALWAYS_APPROVAL)
        owner("once")
        tokens = approval.set_current_observability_context(tool_call_id="")
        try:
            result = reg.dispatch("probe_tool", {}, session_id=SESSION)
        finally:
            approval.reset_current_observability_context(tokens)

        assert refused(result)
        assert "no tool call id" in json.loads(result)["error"]
        assert calls == []

    def test_an_unrecognised_decision_path_refuses(self, tool, monkeypatch):
        """A new approval surface cannot smuggle in a capability by accident.

        `_SOURCE_BY_DECISION` is a closed set. A gate that starts reporting a
        provenance this module has never heard of refuses rather than guessing
        which source it resembles.
        """
        from hermes_cli import tool_capability

        reg, calls = tool(Tier.APPROVAL)

        def gate(tool_name, reason, **kw):
            kw["on_authoritative_response"]("once", "some_new_surface", "r1")
            return {"approved": True, "message": None}

        monkeypatch.setattr("tools.approval.request_tool_approval", gate)
        with pytest.raises(Exception):
            tool_capability.authorise(
                tool_name="probe_tool", args={}, session_id=SESSION,
                tool_call_id=CALL_ID,
            )
        assert calls == []


class TestThePreConsentPseudoGrantIsGone:
    def test_dispatching_a_gated_tool_records_no_grant_before_consent(
        self, tool, monkeypatch
    ):
        """`model_tools` used to snapshot a "grant" for every gated call.

        It ran before anything had been approved, so a grant always existed
        and `verify_at_execution` could only ever mean "the payload did not
        change" — never "a human authorised this". The snapshot is gone; the
        grant is written by the mint, so it exists only if somebody said yes.
        """
        import model_tools

        source = __import__("inspect").getsource(model_tools)
        assert "_integrity.record_grant(" not in source

    def test_the_grant_is_written_when_the_capability_is_minted(self, tool, owner):
        from hermes_cli import approval_integrity

        approval_integrity.reset_state()
        reg, _ = tool(Tier.ALWAYS_APPROVAL)
        owner("once")
        reg.dispatch("probe_tool", {"to": "bob"}, session_id=SESSION)

        # The grant exists and is for the payload that was approved.
        assert approval_integrity.verify_at_execution(
            CALL_ID, "probe_tool", {"to": "bob"}
        ) is None
