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
            # Shaped like a real Gmail id (16 lowercase hex). The broker only
            # accepts an identifier the provider could actually have issued,
            # so a placeholder like "msg-1" is correctly read as no id at all.
            return {"id": f"18f2c9a0b7e4d3{len(outbox):02x}"}

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

    def test_a_provider_exception_is_ambiguous_not_failed(self, home, monkeypatch):
        """The duplicate-mail case, and the reason this is not `failed`.

        Gmail accepts the message, the response connection drops, and the
        client sees an exception. That is indistinguishable from a send that
        never left. Recording it as `failed` made it retryable, and an
        approved retry put a second copy in the recipient's inbox.
        """
        class Failing:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                raise ConnectionResetError("connection reset by peer")

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
        assert store.lookup(f"gmail_send:{fp}")["state"] == "ambiguous"

    def test_an_ambiguous_send_is_not_retried_into_a_duplicate(self, home, monkeypatch):
        class Failing:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                raise ConnectionResetError("connection reset by peer")

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
                return {"id": "msg-2"}

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Working)

        # Even with a healthy provider and a fresh approval, it refuses.
        assert errored(**ARGS)
        assert outbox == []

    def test_the_refusal_says_where_to_look(self, home, monkeypatch):
        # An unresolvable "blocked" would leave the owner with no move.
        import json as _json

        class Failing:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                raise ConnectionResetError("reset")

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Failing)
        monkeypatch.setattr(
            "hermes_cli.google.compose.build_raw_message", lambda **kw: "raw"
        )
        from tools.gmail_send_tool import _handle_gmail_send

        _handle_gmail_send(dict(ARGS))
        second = _json.loads(_handle_gmail_send(dict(ARGS)))["error"]
        assert "Sent folder" in second

    def test_a_failure_before_dispatch_stays_retryable(self, home, monkeypatch):
        """Composing the message is provably before the point of no return."""
        def boom(**kw):
            raise ValueError("bad header")

        monkeypatch.setattr("hermes_cli.google.compose.build_raw_message", boom)

        class Client:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):  # pragma: no cover - must not run
                raise AssertionError("dispatched despite a compose failure")

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Client)
        assert errored(**ARGS)

        from hermes_cli.actions.idempotency import IdempotencyStore
        from hermes_constants import get_hermes_home
        from tools.gmail_send_tool import send_fingerprint

        fp = send_fingerprint(
            sender="marco@example.com", to=ARGS["to"],
            subject=ARGS["subject"], body=ARGS["body"],
        )
        store = IdempotencyStore(get_hermes_home() / "state" / "idempotency.sqlite3")
        assert store.lookup(f"gmail_send:{fp}")["state"] == "failed"

        # And a repaired attempt then sends.
        outbox: list = []
        monkeypatch.setattr(
            "hermes_cli.google.compose.build_raw_message", lambda **kw: "raw"
        )

        class Working:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                outbox.append(raw)
                return {"id": "18f2c9a0b7e4d301"}

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Working)
        out = call(**ARGS)
        assert out["sent"] is True
        assert len(outbox) == 1


class TestReconciliationIdentity:
    def test_the_message_carries_a_deterministic_broker_id(self, home, sent):
        """So an ambiguous send can be answered by looking for one id."""
        from tools.gmail_send_tool import rfc_message_id, send_fingerprint

        fp = send_fingerprint(
            sender="marco@example.com", to=ARGS["to"],
            subject=ARGS["subject"], body=ARGS["body"],
        )
        out = call(**ARGS)
        assert out["rfc_message_id"] == rfc_message_id(fp)

    def test_the_id_is_stable_for_the_same_message(self):
        from tools.gmail_send_tool import rfc_message_id

        assert rfc_message_id("abc123") == rfc_message_id("abc123")

    def test_a_different_message_gets_a_different_id(self):
        from tools.gmail_send_tool import rfc_message_id

        assert rfc_message_id("a" * 40) != rfc_message_id("b" * 40)

    def test_it_is_a_well_formed_message_id(self):
        from tools.gmail_send_tool import rfc_message_id

        value = rfc_message_id("abc")
        assert value.startswith("<") and value.endswith(">") and "@" in value


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
    """An audit row outlives the message, so anything in it is retained content.

    A subject line is content. So is a recipient address, and so is whatever a
    provider chose to quote back in an exception — which for a mail API is
    frequently both.
    """

    def test_the_audit_row_records_counts_not_the_message(self, home, sent, monkeypatch):
        rows = []
        monkeypatch.setattr(
            "hermes_cli.audit_log.record", lambda **kw: rows.append(kw)
        )
        call(**{**ARGS, "body": "SECRET-BODY-TEXT", "subject": "SECRET-SUBJECT"})

        assert rows, "the send must be audited"
        blob = json.dumps(rows)
        assert "SECRET-BODY-TEXT" not in blob
        assert "bob@example.com" not in blob
        assert "SECRET-SUBJECT" not in blob

    def test_a_denial_records_no_subject_or_recipient(self, home, sent, denied, monkeypatch):
        rows = []
        monkeypatch.setattr("hermes_cli.audit_log.record", lambda **kw: rows.append(kw))
        errored(**{**ARGS, "subject": "SECRET-SUBJECT"})

        blob = json.dumps(rows)
        assert "SECRET-SUBJECT" not in blob
        assert "bob@example.com" not in blob

    def test_an_ambiguous_outcome_records_no_recipients(self, home, monkeypatch):
        rows = []
        monkeypatch.setattr("hermes_cli.audit_log.record", lambda **kw: rows.append(kw))

        class Failing:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                raise ConnectionResetError("reset")

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Failing)
        monkeypatch.setattr(
            "hermes_cli.google.compose.build_raw_message", lambda **kw: "raw"
        )
        errored(**{**ARGS, "subject": "SECRET-SUBJECT"})

        blob = json.dumps(rows)
        assert "bob@example.com" not in blob
        assert "SECRET-SUBJECT" not in blob

    def test_a_provider_error_is_bounded_and_typed_not_echoed(self, home, monkeypatch):
        """Raw provider diagnostics often quote the message back."""
        from tools.gmail_send_tool import _safe_error

        leaky = RuntimeError(
            "550 rejected for bob@example.com subject 'SECRET-SUBJECT' " + "x" * 500
        )
        safe = _safe_error(leaky)
        assert safe.startswith("RuntimeError:")
        assert len(safe) < 200

    def test_the_persisted_failure_record_is_bounded(self, home, monkeypatch):
        class Failing:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                raise ConnectionResetError("reset for bob@example.com " + "y" * 400)

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Failing)
        monkeypatch.setattr(
            "hermes_cli.google.compose.build_raw_message", lambda **kw: "raw"
        )
        errored(**ARGS)

        from hermes_cli.actions.idempotency import IdempotencyStore
        from hermes_constants import get_hermes_home
        from tools.gmail_send_tool import send_fingerprint

        fp = send_fingerprint(
            sender="marco@example.com", to=ARGS["to"],
            subject=ARGS["subject"], body=ARGS["body"],
        )
        store = IdempotencyStore(get_hermes_home() / "state" / "idempotency.sqlite3")
        stored = json.dumps(store.lookup(f"gmail_send:{fp}"))
        assert len(stored) < 600
        assert "y" * 200 not in stored


class TestAMalformedProviderResponseIsNotASend:
    """`{}` back from Gmail is not a confirmation.

    Reading it as success reported "sent" on the strength of the call
    returning — the same class of claim as reporting delivery because a request
    was made. And without the provider's own identifier there is nothing to
    reconcile against later, so it is unverified rather than done.
    """

    def _client_returning(self, monkeypatch, response):
        class Client:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                return response

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Client)
        monkeypatch.setattr(
            "hermes_cli.google.compose.build_raw_message", lambda **kw: "raw"
        )

    def _state(self):
        from hermes_cli.actions.idempotency import IdempotencyStore
        from hermes_constants import get_hermes_home
        from tools.gmail_send_tool import send_fingerprint

        fp = send_fingerprint(
            sender="marco@example.com", to=ARGS["to"],
            subject=ARGS["subject"], body=ARGS["body"],
        )
        store = IdempotencyStore(get_hermes_home() / "state" / "idempotency.sqlite3")
        return store.lookup(f"gmail_send:{fp}")["state"]

    @pytest.mark.parametrize("response", [{}, None, {"id": ""}, {"nothing": "useful"}])
    def test_it_does_not_report_success(self, home, monkeypatch, response):
        self._client_returning(monkeypatch, response)
        assert errored(**ARGS)

    @pytest.mark.parametrize("response", [{}, None, {"id": ""}])
    def test_it_is_recorded_as_ambiguous_not_succeeded(self, home, monkeypatch, response):
        self._client_returning(monkeypatch, response)
        errored(**ARGS)
        assert self._state() == "ambiguous"

    def test_a_confirmed_identity_does_produce_success(self, home, monkeypatch):
        self._client_returning(monkeypatch, {"id": "18f2c9a0b7e4d31c"})
        out = call(**ARGS)
        assert out["sent"] is True
        assert out["message_id"] == "18f2c9a0b7e4d31c"
        assert self._state() == "succeeded"

    def test_an_unconfirmed_send_is_not_retried_into_a_duplicate(self, home, monkeypatch):
        self._client_returning(monkeypatch, {})
        assert errored(**ARGS)
        # Even with a healthy provider afterwards, it stays blocked.
        self._client_returning(monkeypatch, {"id": "18f2c9a0b7e4d31d"})
        assert errored(**ARGS)


class TestReconciliation:
    """Answering "did it send?" by looking, rather than by waiting.

    An ambiguous outcome blocks forever without this — correct while the answer
    is unknown, useless once it is knowable.
    """

    def _make_ambiguous(self, home, monkeypatch):
        class Failing:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                raise ConnectionResetError("reset")

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Failing)
        monkeypatch.setattr(
            "hermes_cli.google.compose.build_raw_message", lambda **kw: "raw"
        )
        errored(**ARGS)

        from tools.gmail_send_tool import send_fingerprint

        return send_fingerprint(
            sender="marco@example.com", to=ARGS["to"],
            subject=ARGS["subject"], body=ARGS["body"],
        )

    def _store(self):
        from hermes_cli.actions.idempotency import IdempotencyStore
        from hermes_constants import get_hermes_home

        return IdempotencyStore(get_hermes_home() / "state" / "idempotency.sqlite3")

    def test_finding_it_in_sent_settles_it_as_delivered(self, home, monkeypatch):
        from tools.gmail_send_tool import reconcile_ambiguous_send, rfc_message_id

        fp = self._make_ambiguous(home, monkeypatch)
        searched: list[str] = []

        def search(message_id):
            searched.append(message_id)
            return "18f2c9a0b7e4d31e"

        result = reconcile_ambiguous_send(fingerprint=fp, search=search)
        assert result["reconciled"] is True
        assert result["state"] == "succeeded"
        # Looked up by the deterministic id, not by content.
        assert searched == [rfc_message_id(fp)]
        assert self._store().lookup(f"gmail_send:{fp}")["state"] == "succeeded"

    def test_not_finding_it_is_not_proof_it_was_not_delivered(self, home, monkeypatch):
        """An empty search result must leave the row ambiguous.

        Gmail's `rfc822msgid:` index is eventually consistent and lags a send;
        a throttled query returns an empty page. Settling `failed` on that
        emptiness marks the message sendable again, and the case where it is
        wrong is the case that matters: the message already went out, and the
        owner sends a second copy of something irreversible.
        """
        from tools.gmail_send_tool import reconcile_ambiguous_send

        fp = self._make_ambiguous(home, monkeypatch)
        result = reconcile_ambiguous_send(fingerprint=fp, search=lambda _id: None)
        assert result["reconciled"] is False
        assert result["state"] == "ambiguous"
        assert self._store().lookup(f"gmail_send:{fp}")["state"] == "ambiguous"
        # And the message is still blocked from going out a second time.
        assert errored(**ARGS)

    @pytest.mark.parametrize(
        "malformed", [{"id": "x"}, ["x"], 1, True, {}, object()]
    )
    def test_a_malformed_search_result_is_not_a_find(
        self, home, monkeypatch, malformed
    ):
        # Coercing this to a string would settle the row `succeeded` and report
        # a delivery on the strength of a reply that named no message.
        from tools.gmail_send_tool import reconcile_ambiguous_send

        fp = self._make_ambiguous(home, monkeypatch)
        result = reconcile_ambiguous_send(
            fingerprint=fp, search=lambda _id: malformed
        )
        assert result["reconciled"] is False
        assert result["state"] == "ambiguous"
        assert self._store().lookup(f"gmail_send:{fp}")["state"] == "ambiguous"

    @pytest.mark.parametrize(
        "proof",
        [
            None,
            {},
            {"kind": "owner_confirmed"},                  # nobody attributed
            {"kind": "owner_confirmed", "actor": "  "},   # blank actor
            {"kind": "i_looked", "actor": "marco"},       # unrecognised kind
            {"actor": "marco"},                           # no kind
            "owner_confirmed",                            # not a mapping
            {"kind": True, "actor": "marco"},
        ],
    )
    def test_an_unusable_proof_does_not_unblock_the_send(
        self, home, monkeypatch, proof
    ):
        from tools.gmail_send_tool import reconcile_ambiguous_send

        fp = self._make_ambiguous(home, monkeypatch)
        result = reconcile_ambiguous_send(
            fingerprint=fp, search=lambda _id: None, proof=proof
        )
        assert result["reconciled"] is False
        assert self._store().lookup(f"gmail_send:{fp}")["state"] == "ambiguous"

    @pytest.mark.parametrize(
        "kind", ["owner_confirmed", "provider_permanent_failure"]
    )
    def test_authoritative_non_delivery_proof_makes_it_sendable_again(
        self, home, monkeypatch, kind
    ):
        from tools.gmail_send_tool import reconcile_ambiguous_send

        fp = self._make_ambiguous(home, monkeypatch)
        result = reconcile_ambiguous_send(
            fingerprint=fp, search=lambda _id: None,
            proof={"kind": kind, "actor": "owner:marco"},
        )
        assert result["state"] == "failed"
        # Who said so is recorded: this is the write that permits a second copy
        # of an irreversible action.
        record = self._store().lookup(f"gmail_send:{fp}")
        assert record["result"]["proof_kind"] == kind
        assert record["result"]["proof_actor"] == "owner:marco"

        outbox: list = []

        class Working:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                outbox.append(raw)
                return {"id": "18f2c9a0b7e4d321"}

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Working)
        assert call(**ARGS)["sent"] is True
        assert len(outbox) == 1

    def test_reconciling_twice_does_not_change_a_terminal_result(self, home, monkeypatch):
        from tools.gmail_send_tool import reconcile_ambiguous_send

        fp = self._make_ambiguous(home, monkeypatch)
        first = reconcile_ambiguous_send(fingerprint=fp, search=lambda _i: "18f2c9a0b7e4d31f")
        second = reconcile_ambiguous_send(fingerprint=fp, search=lambda _i: "18f2c9a0b7e4d320")

        assert first["state"] == "succeeded"
        assert second["reconciled"] is False
        record = self._store().lookup(f"gmail_send:{fp}")
        assert record["state"] == "succeeded"
        assert record["result"]["message_id"] == "18f2c9a0b7e4d31f"

    def test_an_unreachable_provider_leaves_it_ambiguous(self, home, monkeypatch):
        # Not being able to look is not evidence either way.
        from tools.gmail_send_tool import reconcile_ambiguous_send

        fp = self._make_ambiguous(home, monkeypatch)

        def boom(_id):
            raise ConnectionError("provider unreachable")

        result = reconcile_ambiguous_send(fingerprint=fp, search=boom)
        assert result["reconciled"] is False
        assert self._store().lookup(f"gmail_send:{fp}")["state"] == "ambiguous"

    def test_a_settled_send_is_not_re_decided(self, home, sent):
        from tools.gmail_send_tool import reconcile_ambiguous_send, send_fingerprint

        call(**ARGS)
        fp = send_fingerprint(
            sender="marco@example.com", to=ARGS["to"],
            subject=ARGS["subject"], body=ARGS["body"],
        )
        result = reconcile_ambiguous_send(
            fingerprint=fp, search=lambda _i: None,
            proof={"kind": "owner_confirmed", "actor": "owner:marco"},
        )
        assert result["reconciled"] is False
        assert self._store().lookup(f"gmail_send:{fp}")["state"] == "succeeded"

    def test_durable_state_carries_no_message_content(self, home, monkeypatch):
        from tools.gmail_send_tool import reconcile_ambiguous_send, send_fingerprint

        class Failing:
            def get_profile(self):
                return {"emailAddress": "marco@example.com"}

            def send_message(self, raw, **kw):
                raise ConnectionResetError(
                    "550 rejected for bob@example.com subject 'SECRET-SUBJECT'"
                )

        monkeypatch.setattr("hermes_cli.google.gmail.GmailClient", Failing)
        monkeypatch.setattr(
            "hermes_cli.google.compose.build_raw_message", lambda **kw: "raw"
        )
        errored(**{**ARGS, "subject": "SECRET-SUBJECT", "body": "SECRET-BODY"})

        fp = send_fingerprint(
            sender="marco@example.com", to=ARGS["to"],
            subject="SECRET-SUBJECT", body="SECRET-BODY",
        )
        reconcile_ambiguous_send(fingerprint=fp, search=lambda _i: "18f2c9a0b7e4d322")
        blob = json.dumps(self._store().lookup(f"gmail_send:{fp}"))
        for secret in ("SECRET-SUBJECT", "SECRET-BODY", "bob@example.com"):
            assert secret not in blob
