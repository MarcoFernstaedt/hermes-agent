"""Capability status — the contract that refuses to call a lie a connection.

The live audit found Home Assistant running, its root URL returning 200, and
`HASS_URL` set, with no token and the API correctly answering 401. Three
signals said "working" and the integration was unusable. Every test here is
about keeping those signals separate.
"""
from __future__ import annotations

import json

import pytest

from hermes_cli.capability_status import (
    STATE_NO_CREDENTIAL,
    STATE_NOT_AUTHENTICATED,
    STATE_NOT_CONFIGURED,
    STATE_OPERATIONAL,
    STATE_UNPROVEN,
    STATE_UNREACHABLE,
    STATE_UNSUPPORTED,
    CapabilityStatus,
    summarize,
)


def cap(**over) -> CapabilityStatus:
    base = dict(key="k", label="Thing", supported=True, configured=True,
                has_credential=True, reachable=True, authenticated=True,
                proven_at=1000.0)
    base.update(over)
    return CapabilityStatus(**base)


class TestTheFirstFailingCheckWins:
    def test_everything_true_is_operational(self):
        assert cap().state == STATE_OPERATIONAL
        assert cap().usable is True

    def test_unsupported_beats_everything_else(self):
        assert cap(supported=False).state == STATE_UNSUPPORTED

    def test_unconfigured_is_not_connected(self):
        assert cap(configured=False).state == STATE_NOT_CONFIGURED

    def test_no_token_outranks_a_working_network(self):
        """The Home Assistant case, exactly.

        Reachable, running, configured — and unusable. Reporting this as
        "unreachable" would send the owner to debug a network that is fine.
        """
        status = cap(has_credential=False, reachable=True)
        assert status.state == STATE_NO_CREDENTIAL
        assert status.usable is False

    def test_unreachable_outranks_unauthenticated(self):
        assert cap(reachable=False, authenticated=False).state == STATE_UNREACHABLE

    def test_reachable_but_rejected_is_its_own_state(self):
        assert cap(authenticated=False).state == STATE_NOT_AUTHENTICATED


class TestUnknownIsNotSuccess:
    @pytest.mark.parametrize("field", ["reachable", "authenticated"])
    def test_a_probe_that_never_ran_is_unproven(self, field):
        # `None` means we did not look. Reading it as True is how a status page
        # comes to claim something it has no evidence for.
        assert cap(**{field: None}).state == STATE_UNPROVEN

    def test_authenticated_but_never_used_is_unproven(self):
        assert cap(proven_at=None).state == STATE_UNPROVEN

    def test_operational_requires_something_to_have_actually_worked(self):
        assert cap(proven_at=None).usable is False


class TestEveryProblemCarriesOneNextStep:
    def test_a_broken_state_without_a_remedy_is_incomplete(self):
        from hermes_cli.capability_adapters import all_capabilities

        for status in all_capabilities():
            if status.state != STATE_OPERATIONAL:
                assert status.next_action, f"{status.key} reports a problem and no remedy"

    def test_labels_are_distinct_so_two_states_never_read_alike(self):
        from hermes_cli.capability_status import STATE_LABELS, STATE_ORDER

        labels = [STATE_LABELS[s] for s in STATE_ORDER]
        assert len(set(labels)) == len(labels)


class TestSummaryPutsProblemsFirst:
    def test_worst_state_first(self):
        statuses = [
            cap(key="fine", label="Fine"),
            cap(key="broken", label="Broken", configured=False),
            cap(key="partial", label="Partial", proven_at=None),
        ]
        keys = [c["key"] for c in summarize(statuses)["capabilities"]]
        assert keys == ["broken", "partial", "fine"]

    def test_it_counts_what_actually_works(self):
        report = summarize([cap(), cap(key="b", configured=False)])
        assert report["operational_count"] == 1
        assert report["total_count"] == 2

    def test_needs_attention_excludes_unsupported(self):
        # An integration this build cannot do is not an outstanding task.
        report = summarize([cap(key="a", supported=False), cap(key="b", configured=False)])
        assert report["needs_attention"] == ["b"]


class TestNoSecretCrossesTheBoundary:
    def test_the_payload_carries_presence_not_values(self):
        status = cap()
        payload = status.to_dict()
        assert payload["has_credential"] is True
        # There is no field that could hold one.
        assert not any(
            key in payload for key in ("credential", "token", "secret", "api_key", "value")
        )

    def test_adapters_never_echo_an_env_secret(self, monkeypatch):
        from hermes_cli.capability_adapters import all_capabilities

        secrets = {
            "HASS_TOKEN": "hass-SECRET-TOKEN-VALUE",
            "STRIPE_API_KEY": "sk_live_STRIPE_SECRET_VALUE",
            "PLAID_SECRET": "plaid-SECRET-VALUE",
            "TWILIO_AUTH_TOKEN": "twilio-SECRET-VALUE",
        }
        for name, value in secrets.items():
            monkeypatch.setenv(name, value)
        monkeypatch.setenv("HASS_URL", "http://hp.local:8123")

        blob = json.dumps(summarize(all_capabilities()), default=str)
        for value in secrets.values():
            assert value not in blob


class TestHomeAssistantAdapter:
    def test_a_url_without_a_token_is_no_credential(self, monkeypatch):
        from hermes_cli.capability_adapters import home_assistant_status

        monkeypatch.setenv("HASS_URL", "http://hp.local:8123")
        monkeypatch.delenv("HASS_TOKEN", raising=False)
        monkeypatch.delenv("HOMEASSISTANT_TOKEN", raising=False)

        status = home_assistant_status()
        assert status.state == STATE_NO_CREDENTIAL
        assert "token" in status.next_action.lower()

    def test_no_url_at_all_is_not_connected(self, monkeypatch):
        from hermes_cli.capability_adapters import home_assistant_status

        for name in ("HASS_URL", "HOMEASSISTANT_URL", "HASS_TOKEN", "HOMEASSISTANT_TOKEN"):
            monkeypatch.delenv(name, raising=False)
        assert home_assistant_status().state == STATE_NOT_CONFIGURED

    def test_it_is_read_only_in_this_release(self, monkeypatch):
        from hermes_cli.capability_adapters import home_assistant_status

        monkeypatch.setenv("HASS_URL", "http://hp.local:8123")
        monkeypatch.setenv("HASS_TOKEN", "t")
        status = home_assistant_status()
        assert status.read_only is True
        assert any("read-only" in n.lower() for n in status.notes)

    def test_a_token_alone_does_not_make_it_operational(self, monkeypatch):
        # No call was made. Claiming "operational" from configuration is the
        # whole class of defect this module exists for.
        from hermes_cli.capability_adapters import home_assistant_status

        monkeypatch.setenv("HASS_URL", "http://hp.local:8123")
        monkeypatch.setenv("HASS_TOKEN", "t")
        assert home_assistant_status().state == STATE_UNPROVEN


class TestUnconnectedVendors:
    @pytest.mark.parametrize(
        "builder,envs",
        [
            ("stripe_status", ("STRIPE_API_KEY", "STRIPE_SECRET_KEY")),
            ("plaid_status", ("PLAID_SECRET", "PLAID_CLIENT_ID")),
            ("twilio_status", ("TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID")),
        ],
    )
    def test_they_say_not_connected_rather_than_showing_nothing(
        self, monkeypatch, builder, envs
    ):
        import hermes_cli.capability_adapters as adapters

        for name in envs:
            monkeypatch.delenv(name, raising=False)
        status = getattr(adapters, builder)()
        assert status.state == STATE_NOT_CONFIGURED
        assert status.next_action

    def test_finance_never_claims_a_figure(self, monkeypatch):
        """Prose may say "balances"; the payload may not carry one.

        The property is structural, not lexical — there must be no *field* a
        number could arrive in, because an invented balance on a dashboard is
        worse than no dashboard.
        """
        import hermes_cli.capability_adapters as adapters

        for name in ("STRIPE_API_KEY", "STRIPE_SECRET_KEY", "PLAID_SECRET", "PLAID_CLIENT_ID"):
            monkeypatch.delenv(name, raising=False)

        for payload in (adapters.stripe_status().to_dict(), adapters.plaid_status().to_dict()):
            for field in ("balance", "amount", "currency", "total", "revenue", "value"):
                assert field not in payload
            # And nothing already there is a number that could be read as money.
            numeric = {
                k: v for k, v in payload.items()
                if isinstance(v, (int, float)) and not isinstance(v, bool)
            }
            assert numeric == {}, f"unexpected numeric field(s): {numeric}"

    def test_they_are_marked_read_only(self):
        import hermes_cli.capability_adapters as adapters

        assert adapters.stripe_status().read_only is True
        assert adapters.plaid_status().read_only is True


class TestBrowserOwnedCapabilities:
    @pytest.mark.parametrize("key", ["camera", "location"])
    def test_they_are_session_bound_and_never_claimed_proven(self, key):
        from hermes_cli.capability_adapters import all_capabilities

        status = next(s for s in all_capabilities() if s.key == key)
        # The server cannot know whether a device exists or a permission was
        # granted — only the page can, when the owner asks.
        assert status.proven_at is None
        assert status.state == STATE_UNPROVEN
        assert any("session" in n.lower() for n in status.notes)


class TestTheWholeSet:
    def test_every_capability_has_a_stable_key_and_a_label(self):
        from hermes_cli.capability_adapters import all_capabilities

        statuses = all_capabilities()
        keys = [s.key for s in statuses]
        assert len(set(keys)) == len(keys)
        assert all(s.label for s in statuses)

    def test_one_failing_adapter_does_not_blank_the_page(self, monkeypatch):
        # The page is how the owner finds out something is wrong; it must
        # survive the thing that is wrong.
        import hermes_cli.capability_adapters as adapters

        def boom():
            raise RuntimeError("adapter exploded")

        monkeypatch.setattr(adapters, "home_assistant_status", boom)
        statuses = adapters.all_capabilities()
        assert len(statuses) == 8
        assert any(s.state == STATE_UNSUPPORTED for s in statuses)

    def test_nothing_is_operational_without_evidence(self):
        """A fresh container has proven nothing, and must say so."""
        from hermes_cli.capability_adapters import all_capabilities

        assert all(s.proven_at is None for s in all_capabilities())
        assert not any(s.usable for s in all_capabilities())
