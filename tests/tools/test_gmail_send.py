"""`gmail_send` — the one tool that puts mail on the wire.

Every test here is about the same thing: nothing leaves the machine that the
owner did not approve, and nothing leaves twice.

No test performs a real send. The Gmail client is stubbed throughout.
"""
from __future__ import annotations

import json

import pytest


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "state").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: h)
    return h


@pytest.fixture(autouse=True)
def approved(monkeypatch):
    """Stand in for the owner, and record what they were shown.

    Every send goes through the human gate now, so without this the tests
    would fail closed — correctly, but uninformatively. Returning the captured
    call lets each test assert on the card the owner would actually see,
    without a Google credential anywhere in the loop.
    """
    calls: list[dict] = []

    def gate(tool_name, reason, **kw):
        calls.append({"tool": tool_name, "reason": reason, **kw})
        return {"approved": True, "message": None}

    monkeypatch.setattr("tools.approval.request_tool_approval", gate)
    return calls


@pytest.fixture
def denied(monkeypatch):
    """The owner says no."""
    def gate(tool_name, reason, **kw):
        return {"approved": False, "message": "BLOCKED: Action denied by user."}

    monkeypatch.setattr("tools.approval.request_tool_approval", gate)


@pytest.fixture
def sent(monkeypatch):
    """Capture what would have gone out, without going out."""
    outbox = []

    class FakeClient:
        def get_profile(self):
            return {"emailAddress": "marco@example.com"}

        def send_message(self, raw, **kw):
            outbox.append(raw)
            return {"id": f"msg-{len(outbox)}"}

    monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", FakeClient)
    monkeypatch.setattr(
        "hermes_cli.google.compose.build_raw_message",
        lambda **kw: json.dumps(kw, sort_keys=True),
    )
    return outbox


def call(**kwargs) -> dict:
    from tools.gmail_send_tool import _handle_gmail_send

    raw = json.loads(_handle_gmail_send(kwargs))
    body = raw.get("result", raw)
    return json.loads(body) if isinstance(body, str) else body


def errored(**kwargs) -> bool:
    from tools.gmail_send_tool import _handle_gmail_send

    return "error" in json.loads(_handle_gmail_send(kwargs))


ARGS = {"to": ["bob@example.com"], "subject": "Invoice", "body": "Paying today."}


class TestPermissionTier:
    def test_send_is_always_approval_and_cannot_be_trusted(self):
        """APPROVAL would let the settings UI offer an auto-approve toggle, and
        one click would let the agent send anything unprompted for a session."""
        import tools.gmail_send_tool  # noqa: F401
        from hermes_cli.module_permissions import Tier, can_be_trusted, get_tier

        assert get_tier("gmail_send") is Tier.ALWAYS_APPROVAL
        assert can_be_trusted("gmail_send") is False

    def test_the_resolver_always_requires_approval_even_if_trusted(self):
        import tools.gmail_send_tool  # noqa: F401
        from hermes_cli.module_permissions import Decision, resolve

        # Even a caller that wrongly lists it as trusted cannot make it auto.
        assert resolve("gmail_send", trusted_tools={"gmail_send"}) is Decision.REQUIRE_APPROVAL

    def test_it_is_discoverable(self):
        from pathlib import Path

        from tools.registry import _module_registers_tools

        assert _module_registers_tools(Path("tools/gmail_send_tool.py")) is True


class TestSenderIsNotAnArgument:
    def test_the_sender_comes_from_the_authenticated_mailbox(self, home, sent):
        out = call(**ARGS)
        assert out["from"] == "marco@example.com"

    def test_a_caller_supplied_sender_is_refused_not_ignored(self, home, sent):
        # A model that could name its own `from` could impersonate.
        assert errored(**ARGS, **{"from": "ceo@bank.example"})
        assert errored(**ARGS, sender="ceo@bank.example")
        assert sent == []

    def test_an_unresolvable_sender_fails_closed(self, home, monkeypatch):
        class NoProfile:
            def get_profile(self):
                return {}

            def send_message(self, raw, **kw):  # pragma: no cover - must not run
                raise AssertionError("sent without a verified sender")

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", NoProfile)
        assert errored(**ARGS)


class TestUnsupportedFieldsAreRejected:
    @pytest.mark.parametrize(
        "field,value",
        [("cc", ["x@y.z"]), ("bcc", ["x@y.z"]), ("attachments", ["f.pdf"]),
         ("html", "<b>hi</b>"), ("reply_all", True)],
    )
    def test_rejected_rather_than_silently_dropped(self, home, sent, field, value):
        # Dropping a bcc would mean the owner approved a card that did not
        # describe the message that actually went out.
        assert errored(**ARGS, **{field: value})
        assert sent == []


class TestRequiredFields:
    @pytest.mark.parametrize("field", ["to", "subject", "body"])
    def test_missing_field_refuses(self, home, sent, field):
        args = dict(ARGS)
        args.pop(field)
        assert errored(**args)
        assert sent == []

    def test_blank_body_or_subject_refuses(self, home, sent):
        assert errored(**{**ARGS, "body": "   "})
        assert errored(**{**ARGS, "subject": "  "})
        assert sent == []


class TestIdempotency:
    def test_the_same_message_is_never_sent_twice(self, home, sent):
        first = call(**ARGS)
        assert first["sent"] is True
        assert len(sent) == 1

        second = call(**ARGS)
        assert second["duplicate_suppressed"] is True
        assert second["message_id"] == first["message_id"]
        # The retry-after-reconnect path: reported, not resent.
        assert len(sent) == 1

    def test_a_different_body_is_a_different_message(self, home, sent):
        call(**ARGS)
        call(**{**ARGS, "body": "Actually, paying tomorrow."})
        assert len(sent) == 2

    def test_a_different_recipient_is_a_different_message(self, home, sent):
        call(**ARGS)
        call(**{**ARGS, "to": ["alice@example.com"]})
        assert len(sent) == 2

    def test_reordering_the_same_audience_is_the_same_message(self, home, sent):
        call(**{**ARGS, "to": ["a@x.com", "b@x.com"]})
        call(**{**ARGS, "to": ["b@x.com", "a@x.com"]})
        assert len(sent) == 1

    def test_a_failed_send_does_not_report_success_or_block_forever(self, home, monkeypatch):
        class Failing:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                raise RuntimeError("smtp exploded")

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Failing)
        monkeypatch.setattr(
            "hermes_cli.google.compose.build_raw_message", lambda **kw: "raw"
        )
        assert errored(**ARGS)

        from hermes_cli.actions.idempotency import IdempotencyStore
        from hermes_constants import get_hermes_home
        from tools.gmail_send_tool import send_fingerprint

        fp = send_fingerprint(
            sender="marco@example.com", to=ARGS["to"],
            subject=ARGS["subject"], body=ARGS["body"],
        )
        store = IdempotencyStore(get_hermes_home() / "state" / "idempotency.sqlite3")
        # Recorded as failed, so a later duplicate can see the first attempt
        # failed rather than assuming it is the first.
        assert store.lookup(f"gmail_send:{fp}")["state"] == "failed"

    def test_a_failed_send_can_be_retried_once_the_problem_is_fixed(self, home, monkeypatch):
        """The failure path must not become a day-long ban on one message.

        Suppressing a *successful* send is the point of the key. Suppressing a
        failed one is the opposite: nothing was sent, and the owner is left
        unable to send that exact message at all until the key expires.
        """
        class Failing:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                raise RuntimeError("smtp exploded")

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Failing)
        monkeypatch.setattr(
            "hermes_cli.google.compose.build_raw_message", lambda **kw: "raw"
        )
        assert errored(**ARGS)

        outbox: list = []

        class Working:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                outbox.append(raw)
                return {"id": "msg-retry"}

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Working)

        out = call(**ARGS)
        assert out["sent"] is True
        assert out["message_id"] == "msg-retry"
        assert len(outbox) == 1
        # And it says what it is: a send that follows an attempt whose outcome
        # was never confirmed, not a clean first send.
        assert out["retry_after_failed_attempt"] is True
        assert "smtp exploded" in out["previous_error"]

    def test_a_retry_after_a_failure_is_still_suppressed_once_it_succeeds(
        self, home, monkeypatch
    ):
        class Failing:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                raise RuntimeError("smtp exploded")

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Failing)
        monkeypatch.setattr(
            "hermes_cli.google.compose.build_raw_message", lambda **kw: "raw"
        )
        assert errored(**ARGS)

        outbox: list = []

        class Working:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                outbox.append(raw)
                return {"id": "msg-retry"}

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Working)
        call(**ARGS)
        third = call(**ARGS)

        assert third["duplicate_suppressed"] is True
        assert len(outbox) == 1


class TestFingerprint:
    def test_any_change_to_the_message_changes_the_fingerprint(self):
        from tools.gmail_send_tool import send_fingerprint

        base = dict(sender="me@x.com", to=["a@x.com"], subject="S", body="B")
        original = send_fingerprint(**base)
        for field, value in [
            ("sender", "other@x.com"),
            ("to", ["b@x.com"]),
            ("subject", "T"),
            ("body", "C"),
        ]:
            assert send_fingerprint(**{**base, field: value}) != original, field

    def test_recipient_case_and_order_do_not_change_it(self):
        from tools.gmail_send_tool import send_fingerprint

        a = send_fingerprint(sender="me@x.com", to=["A@x.com", "b@x.com"], subject="S", body="B")
        b = send_fingerprint(sender="ME@x.com", to=["b@x.com", "a@x.com"], subject="S", body="B")
        assert a == b


class TestApprovalPreview:
    def test_it_shows_everything_the_owner_must_judge(self):
        from tools.gmail_send_tool import build_approval_preview

        p = build_approval_preview(
            sender="marco@example.com",
            to=["bob@example.com", "eve@example.com"],
            subject="Invoice",
            body="Paying today.",
        )
        assert p["from"] == "marco@example.com"
        # Every recipient, not a count — the owner must see who gets it.
        assert p["to"] == ["bob@example.com", "eve@example.com"]
        assert p["subject"] == "Invoice"
        assert "Paying today." in p["body_preview"]
        assert p["irreversible"] is True
        assert "cannot be recalled" in p["consequence"]

    def test_a_bounded_preview_says_it_is_bounded(self):
        from tools.gmail_send_tool import build_approval_preview

        long_body = "x" * 5000
        p = build_approval_preview(
            sender="m@x.com", to=["a@x.com"], subject="S", body=long_body
        )
        assert p["body_truncated"] is True
        assert p["body_length"] == 5000
        assert len(p["body_preview"]) < 5000

    def test_the_preview_carries_the_fingerprint_that_will_be_sent(self):
        from tools.gmail_send_tool import build_approval_preview, send_fingerprint

        args = dict(sender="m@x.com", to=["a@x.com"], subject="S", body="B")
        assert build_approval_preview(**args)["fingerprint"] == send_fingerprint(**args)


class TestNothingLeavesWithoutTheOwnersConsent:
    """The gate, wired — not registered and then never consulted.

    `register_tool_permission(ALWAYS_APPROVAL)` records a tier. Nothing in the
    dispatch path turned that tier into a human gate, so the strictest label in
    the system had no effect on whether mail went out. These tests are about
    the wiring, and they need no Google credential to run.
    """

    def test_a_denied_send_does_not_go_out(self, home, sent, denied):
        assert errored(**ARGS)
        assert sent == []

    def test_a_denied_send_leaves_the_message_sendable_later(self, home, sent, denied):
        # The claim must be released, not settled: nothing happened, so a
        # later approved attempt is a first attempt and not a duplicate.
        errored(**ARGS)

        from hermes_cli.actions.idempotency import IdempotencyStore
        from hermes_constants import get_hermes_home
        from tools.gmail_send_tool import send_fingerprint

        fp = send_fingerprint(
            sender="marco@example.com", to=ARGS["to"],
            subject=ARGS["subject"], body=ARGS["body"],
        )
        store = IdempotencyStore(get_hermes_home() / "state" / "idempotency.sqlite3")
        assert store.lookup(f"gmail_send:{fp}") is None

    def test_the_gate_is_asked_before_anything_is_sent(self, home, sent, approved):
        call(**ARGS)
        assert [c["tool"] for c in approved] == ["gmail_send"]

    def test_the_card_carries_the_message_the_owner_must_judge(self, home, sent, approved):
        call(**{**ARGS, "to": ["bob@example.com", "eve@example.com"],
                "body": "Paying today."})
        preview = approved[0]["preview"]

        assert preview["from"] == "marco@example.com"
        # Every recipient, not a count.
        assert preview["to"] == ["bob@example.com", "eve@example.com"]
        assert preview["subject"] == "Invoice"
        assert "Paying today." in preview["body_preview"]
        assert preview["irreversible"] is True

    def test_the_approval_is_once_only(self, home, sent, approved):
        # A session or permanent grant would let the agent send any mail
        # unprompted for the rest of that session — the exact thing
        # ALWAYS_APPROVAL exists to prevent.
        call(**ARGS)
        assert approved[0]["once_only"] is True

    def test_each_distinct_message_is_approved_separately(self, home, sent, approved):
        call(**ARGS)
        call(**{**ARGS, "body": "Actually, paying tomorrow."})
        keys = [c["rule_key"] for c in approved]
        assert len(keys) == 2
        assert keys[0] != keys[1], "one approval must not cover a different message"

    def test_the_approval_key_is_the_message_that_will_be_sent(self, home, sent, approved):
        from tools.gmail_send_tool import send_fingerprint

        call(**ARGS)
        fp = send_fingerprint(
            sender="marco@example.com", to=ARGS["to"],
            subject=ARGS["subject"], body=ARGS["body"],
        )
        assert approved[0]["rule_key"] == f"gmail_send:{fp}"
        assert approved[0]["preview"]["fingerprint"] == fp

    def test_a_suppressed_duplicate_does_not_ask_again(self, home, sent, approved):
        # Nothing is about to happen, so there is nothing to consent to.
        call(**ARGS)
        second = call(**ARGS)
        assert second["duplicate_suppressed"] is True
        assert len(approved) == 1


class TestAuditCarriesNoContent:
    def test_the_audit_row_records_counts_not_the_message(self, home, sent, monkeypatch):
        rows = []
        monkeypatch.setattr(
            "hermes_cli.audit_log.record", lambda **kw: rows.append(kw)
        )
        call(**{**ARGS, "body": "SECRET-BODY-TEXT"})

        assert rows, "the send must be audited"
        blob = json.dumps(rows)
        assert "SECRET-BODY-TEXT" not in blob
        assert "bob@example.com" not in blob
