"""Tests for tools.approval.request_tool_approval — the plugin pre_tool_call
``{"action": "approve"}`` escalation into the human-approval gate.

These verify that a plugin-driven approval reuses the SAME machinery as a
Tier-2 dangerous-command match: session/permanent allowlist, the CLI prompt,
the gateway submit_pending path, cron_mode, and fail-closed timeouts.
"""

import pytest

import tools.approval as approval
from tools.approval import request_tool_approval


@pytest.fixture(autouse=True)
def _isolate_approval_state(monkeypatch):
    """Give each test a clean session key and empty allowlists."""
    monkeypatch.setattr(
        approval, "get_current_session_key",
        lambda default="default": "test-session",
    )
    # Empty session + permanent approval stores so nothing pre-approves.
    monkeypatch.setattr(approval, "is_approved", lambda sk, pk: False)
    # Not a yolo session (the shared gate checks this first).
    monkeypatch.setattr(approval, "is_current_session_yolo_enabled", lambda: False)
    monkeypatch.setattr(approval, "_YOLO_MODE_FROZEN", False, raising=False)
    # No thread-registered CLI callback by default.
    monkeypatch.setattr(
        "tools.terminal_tool._get_approval_callback", lambda: None, raising=False
    )
    yield


class TestRequestToolApproval:
    def test_session_cached_approval_short_circuits(self, monkeypatch):
        monkeypatch.setattr(approval, "is_approved", lambda sk, pk: True)
        # Should NOT prompt at all.
        monkeypatch.setattr(
            approval, "prompt_dangerous_approval",
            lambda *a, **k: pytest.fail("should not prompt when already approved"),
        )
        res = request_tool_approval("write_file", "sensitive path", rule_key="ssh")
        assert res == {"approved": True, "message": None}

    def test_cli_approve_once(self, monkeypatch):
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: True)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "once")
        res = request_tool_approval("write_file", "writing ~/.ssh/authorized_keys")
        assert res["approved"] is True

    def test_cli_deny_blocks(self, monkeypatch):
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: True)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "deny")
        res = request_tool_approval("terminal", "curl PUT to external API")
        assert res["approved"] is False
        assert "denied" in res["message"].lower()
        assert res["pattern_key"].startswith("plugin_rule:")

    def test_cli_session_persists_session_only(self, monkeypatch):
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: True)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "session")
        calls = {"session": [], "permanent": []}
        monkeypatch.setattr(approval, "approve_session",
                            lambda sk, pk: calls["session"].append(pk))
        monkeypatch.setattr(approval, "approve_permanent",
                            lambda pk: calls["permanent"].append(pk))
        monkeypatch.setattr(approval, "save_permanent_allowlist", lambda x: None)
        res = request_tool_approval("write_file", "reason", rule_key="ssh-writes")
        assert res["approved"] is True
        assert calls["session"] == ["plugin_rule:ssh-writes"]
        assert calls["permanent"] == []  # session != always

    def test_cli_always_persists_permanent(self, monkeypatch):
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: True)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "always")
        persisted = {}
        monkeypatch.setattr(approval, "approve_session", lambda sk, pk: None)
        monkeypatch.setattr(approval, "approve_permanent",
                            lambda pk: persisted.setdefault("key", pk))
        monkeypatch.setattr(approval, "save_permanent_allowlist",
                            lambda x: persisted.setdefault("saved", True))
        res = request_tool_approval("write_file", "reason", rule_key="ssh-writes")
        assert res["approved"] is True
        assert persisted["key"] == "plugin_rule:ssh-writes"
        assert persisted["saved"] is True

    def test_gateway_path_submits_pending_and_defers(self, monkeypatch):
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: False)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: True)
        submitted = {}
        monkeypatch.setattr(approval, "submit_pending",
                            lambda sk, data: submitted.update(data))
        res = request_tool_approval("browser_navigate", "external URL",
                                    rule_key="ext-nav")
        assert res["approved"] is False
        assert res["status"] == "approval_required"
        assert submitted["pattern_key"] == "plugin_rule:ext-nav"

    def test_cron_deny_mode_blocks(self, monkeypatch):
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: False)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "env_var_enabled",
                            lambda v: v == "HERMES_CRON_SESSION")
        monkeypatch.setattr(approval, "_get_cron_approval_mode", lambda: "deny")
        res = request_tool_approval("terminal", "smtp send")
        assert res["approved"] is False
        assert "cron" in res["message"].lower()

    def test_cron_approve_mode_allows(self, monkeypatch):
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: False)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "env_var_enabled",
                            lambda v: v == "HERMES_CRON_SESSION")
        monkeypatch.setattr(approval, "_get_cron_approval_mode", lambda: "approve")
        res = request_tool_approval("terminal", "smtp send")
        assert res["approved"] is True

    def test_rule_key_derived_from_tool_and_reason(self, monkeypatch):
        """With no explicit rule_key, the pattern key is derived from
        tool + a hash of the reason (so distinct reasons persist apart)."""
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: True)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "deny")
        res = request_tool_approval("patch", "reason")  # no rule_key
        assert res["pattern_key"].startswith("plugin_rule:patch:")

    def test_distinct_reasons_get_distinct_keys(self, monkeypatch):
        """Two different reasons on the SAME tool must not share an [a]lways
        allowlist entry (Finding 3: tool_name alone was too coarse)."""
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: True)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "deny")
        k1 = request_tool_approval("write_file", "write to ~/.ssh")["pattern_key"]
        k2 = request_tool_approval("write_file", "send an email")["pattern_key"]
        assert k1 != k2

    def test_explicit_rule_key_overrides_derivation(self, monkeypatch):
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: True)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "deny")
        res = request_tool_approval("terminal", "any", rule_key="my-rule")
        assert res["pattern_key"] == "plugin_rule:my-rule"

    def test_no_human_non_cron_fails_closed(self, monkeypatch):
        """Non-interactive, non-gateway, NON-cron context blocks (fail-closed)
        — a plugin-flagged action never runs ungated without a human."""
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: False)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "env_var_enabled", lambda v: False)  # not cron
        res = request_tool_approval("terminal", "smtp send")
        assert res["approved"] is False
        assert "no interactive user or gateway" in res["message"].lower()

    def test_yolo_session_bypasses_gate(self, monkeypatch):
        """A --yolo session skips the plugin approval gate (parity with the
        dangerous-command path, via the shared _run_approval_gate)."""
        monkeypatch.setattr(approval, "is_current_session_yolo_enabled", lambda: True)
        monkeypatch.setattr(
            approval, "prompt_dangerous_approval",
            lambda *a, **k: pytest.fail("yolo must not prompt"),
        )
        res = request_tool_approval("terminal", "curl PUT", rule_key="ext")
        assert res == {"approved": True, "message": None}


class TestOnceOnly:
    """`once_only` — approval that cannot be turned into a standing grant.

    ALWAYS_APPROVAL means what it says: *this* action, *this* time. An
    irreversible action that can be pre-approved, session-cached or
    yolo-bypassed is an APPROVAL-tier action wearing a stricter label.
    """

    def test_a_cached_session_grant_does_not_short_circuit_it(self, monkeypatch):
        prompted = []
        monkeypatch.setattr(approval, "is_approved", lambda sk, pk: True)
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: True)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(
            approval, "prompt_dangerous_approval",
            lambda *a, **k: (prompted.append(1), "once")[1],
        )
        res = request_tool_approval("gmail_send", "send", once_only=True)
        assert res["approved"] is True
        assert prompted == [1], "a prior grant must not answer for this send"

    def test_yolo_does_not_bypass_it(self, monkeypatch):
        prompted = []
        monkeypatch.setattr(approval, "is_current_session_yolo_enabled", lambda: True)
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: True)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(
            approval, "prompt_dangerous_approval",
            lambda *a, **k: (prompted.append(1), "once")[1],
        )
        res = request_tool_approval("gmail_send", "send", once_only=True)
        assert res["approved"] is True
        assert prompted == [1], "--yolo must not send mail unasked"

    def test_a_session_answer_is_not_persisted(self, monkeypatch):
        # The card should not offer it, but a CLI prompt still can — so the
        # refusal to persist has to live here, not only in the UI.
        calls = {"session": [], "permanent": []}
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: True)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "prompt_dangerous_approval", lambda *a, **k: "always")
        monkeypatch.setattr(approval, "approve_session",
                            lambda sk, pk: calls["session"].append(pk))
        monkeypatch.setattr(approval, "approve_permanent",
                            lambda pk: calls["permanent"].append(pk))
        monkeypatch.setattr(approval, "save_permanent_allowlist", lambda x: None)

        res = request_tool_approval("gmail_send", "send", once_only=True)
        assert res["approved"] is True
        assert calls == {"session": [], "permanent": []}

    def test_it_still_fails_closed_with_no_human(self, monkeypatch):
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: False)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "env_var_enabled", lambda v: False)
        res = request_tool_approval("gmail_send", "send", once_only=True)
        assert res["approved"] is False

    def test_cron_approve_mode_cannot_auto_approve_it(self, monkeypatch):
        """`cron_mode: approve` is a standing grant by another name."""
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: False)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: False)
        monkeypatch.setattr(approval, "env_var_enabled",
                            lambda v: v == "HERMES_CRON_SESSION")
        monkeypatch.setattr(approval, "_get_cron_approval_mode", lambda: "approve")
        res = request_tool_approval("gmail_send", "send", once_only=True)
        assert res["approved"] is False
        assert "cron" in res["message"].lower()


class TestApprovalPreviewReachesTheCard:
    """The structured preview has to arrive with the approval request.

    A card that shows only a one-line description cannot be the thing the
    owner judges an irreversible send by — they need the sender, every
    recipient, the subject and the body.
    """

    def _gateway(self, monkeypatch, captured: dict):
        monkeypatch.setattr(approval, "_is_interactive_cli", lambda: False)
        monkeypatch.setattr(approval, "_is_gateway_approval_context", lambda: True)
        monkeypatch.setattr(
            approval, "_gateway_notify_cbs", {"test-session": lambda *a, **k: True},
            raising=False,
        )
        monkeypatch.setattr(
            approval, "_await_gateway_decision",
            lambda sk, cb, data, surface="gateway": (
                captured.update(data),
                {"resolved": 1, "choice": "once"},
            )[1],
        )

    def test_the_preview_travels_with_the_request(self, monkeypatch):
        captured: dict = {}
        self._gateway(monkeypatch, captured)
        preview = {"from": "m@x.com", "to": ["a@x.com"], "subject": "S"}
        res = request_tool_approval(
            "gmail_send", "send an email", preview=preview, once_only=True
        )
        assert res["approved"] is True
        assert captured["preview"] == preview

    def test_a_once_only_card_does_not_offer_a_standing_grant(self, monkeypatch):
        captured: dict = {}
        self._gateway(monkeypatch, captured)
        request_tool_approval("gmail_send", "send", once_only=True)

        assert captured["allow_permanent"] is False
        assert captured["choices"] == ["once", "deny"]

    def test_an_ordinary_request_keeps_the_full_choice_set(self, monkeypatch):
        captured: dict = {}
        self._gateway(monkeypatch, captured)
        request_tool_approval("write_file", "write to ~/.ssh")

        assert captured["allow_permanent"] is True
        assert "choices" not in captured

    def test_extra_data_cannot_overwrite_the_allowlist_key(self, monkeypatch):
        # A caller-supplied key would let a preview redirect which pattern the
        # decision is recorded against.
        captured: dict = {}
        self._gateway(monkeypatch, captured)
        request_tool_approval(
            "gmail_send", "send", rule_key="real-key",
            preview={"pattern_key": "something-else"},
        )
        assert captured["pattern_key"] == "plugin_rule:real-key"
