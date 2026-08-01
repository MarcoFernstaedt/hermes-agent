"""Phase 1 substrate: action registry, idempotency, cost attribution.

The contract worth defending here is that *forgetting* is impossible. An action
cannot be registered without saying how it is taken back; a retry cannot execute
twice; a model call cannot spend money without saying which feature caused it.
Each of those is enforced rather than documented.
"""
from __future__ import annotations

import pytest

from hermes_cli.actions.registry import (
    ActionRegistry,
    ActionSpec,
    Consequence,
    Rollback,
)


def spec(**over) -> ActionSpec:
    base = dict(
        id="mail.archive",
        label="Archive email",
        module="mail",
        consequence=Consequence.EXTERNAL_REVERSIBLE,
        rollback=Rollback.COMPENSATION,
        rollback_detail="mail.unarchive",
        handler=lambda **kw: None,
    )
    base.update(over)
    return ActionSpec(**base)  # type: ignore[arg-type]


class TestRollbackIsStructural:
    def test_an_action_cannot_register_without_saying_how_it_is_undone(self):
        r = ActionRegistry()
        with pytest.raises(ValueError, match="rollback_detail"):
            r.register(spec(rollback=Rollback.INVERSE, rollback_detail="  "))

    def test_irreversible_must_state_a_reason_not_just_the_flag(self):
        r = ActionRegistry()
        with pytest.raises(ValueError, match="rollback_detail"):
            r.register(
                spec(
                    id="mail.send",
                    consequence=Consequence.EXTERNAL_IRREVERSIBLE,
                    rollback=Rollback.IRREVERSIBLE,
                    rollback_detail="",
                )
            )

    def test_an_inverse_must_name_an_action_not_prose(self):
        # "restores the previous stage" is not something undo can call.
        r = ActionRegistry()
        with pytest.raises(ValueError, match="reversing action id"):
            r.register(
                spec(rollback=Rollback.INVERSE, rollback_detail="restores the previous stage")
            )

    def test_compensation_is_distinct_from_inverse(self):
        """The correction that matters: external mutations are not true undo.

        Collapsing compensation into inverse would let the UI promise an undo it
        cannot deliver for a calendar or third-party change.
        """
        r = ActionRegistry()
        archive = r.register(spec())
        r.register(
            spec(
                id="mail.unarchive",
                label="Unarchive",
                rollback=Rollback.COMPENSATION,
                rollback_detail="mail.archive",
            )
        )
        assert archive.rollback is Rollback.COMPENSATION
        assert archive.reversible is True
        assert Rollback.COMPENSATION != Rollback.INVERSE

    def test_a_read_declares_no_state_change_rather_than_a_fake_inverse(self):
        r = ActionRegistry()
        with pytest.raises(ValueError, match="consequence=none"):
            r.register(
                spec(
                    id="mail.list",
                    consequence=Consequence.NONE,
                    rollback=Rollback.INVERSE,
                    rollback_detail="mail.archive",
                )
            )
        ok = r.register(
            spec(
                id="mail.read",
                consequence=Consequence.NONE,
                rollback=Rollback.IRREVERSIBLE,
                rollback_detail="no state change",
            )
        )
        assert ok.mutating is False

    def test_the_build_guard_catches_an_inverse_pointing_at_nothing(self):
        """Declaring a reversing action is worthless if it does not exist."""
        r = ActionRegistry()
        r.register(spec(rollback_detail="mail.unarchive_typo"))
        problems = r.unresolved_rollbacks()
        assert len(problems) == 1
        assert "mail.unarchive_typo" in problems[0]
        assert "mail.archive" in problems[0]

    def test_a_fully_wired_registry_has_no_unresolved_rollbacks(self):
        r = ActionRegistry()
        r.register(spec())
        r.register(spec(id="mail.unarchive", rollback_detail="mail.archive"))
        r.register(
            spec(
                id="mail.send",
                consequence=Consequence.EXTERNAL_IRREVERSIBLE,
                rollback=Rollback.IRREVERSIBLE,
                rollback_detail="a sent message cannot be recalled",
            )
        )
        assert r.unresolved_rollbacks() == []


class TestConsequence:
    @pytest.mark.parametrize(
        "consequence",
        [
            Consequence.EXTERNAL_IRREVERSIBLE,
            Consequence.INTERNAL_IRREVERSIBLE,
            Consequence.AUTHORITY,
        ],
    )
    def test_irreversible_and_authority_actions_can_never_go_autonomous(self, consequence):
        s = spec(
            id="mail.send",
            consequence=consequence,
            rollback=Rollback.IRREVERSIBLE,
            rollback_detail="cannot be recalled",
        )
        assert s.ladder_capped is True

    def test_reversible_internal_work_is_promotable(self):
        s = spec(
            id="notes.edit",
            consequence=Consequence.INTERNAL_REVERSIBLE,
            rollback=Rollback.INVERSE,
            rollback_detail="notes.restore",
        )
        assert s.ladder_capped is False

    def test_consequence_not_writing_decides_authority(self):
        """A tiny external send outranks a large internal edit."""
        send = spec(
            id="mail.send",
            consequence=Consequence.EXTERNAL_IRREVERSIBLE,
            rollback=Rollback.IRREVERSIBLE,
            rollback_detail="cannot be recalled",
        )
        edit = spec(
            id="notes.edit",
            consequence=Consequence.INTERNAL_REVERSIBLE,
            rollback=Rollback.INVERSE,
            rollback_detail="notes.restore",
        )
        assert send.ladder_capped and not edit.ladder_capped


class TestRegistryShape:
    def test_ids_are_namespaced(self):
        r = ActionRegistry()
        for bad in ("archive", "Mail.Archive", "mail-archive", "mail."):
            with pytest.raises(ValueError, match="module.verb"):
                r.register(spec(id=bad))

    def test_duplicate_registration_is_refused(self):
        r = ActionRegistry()
        r.register(spec())
        with pytest.raises(ValueError, match="already registered"):
            r.register(spec())

    def test_one_registration_feeds_every_surface(self):
        """Menu, palette and context menu read the same declaration."""
        r = ActionRegistry()
        r.register(spec(surfaces=("menu", "palette")))
        r.register(spec(id="mail.unarchive", rollback_detail="mail.archive",
                        surfaces=("palette",)))
        assert [s.id for s in r.for_surface("palette")] == ["mail.archive", "mail.unarchive"]
        assert [s.id for s in r.for_surface("menu")] == ["mail.archive"]
        assert r.for_surface("context") == []


class TestIdempotency:
    def test_the_same_intent_produces_the_same_key(self):
        from hermes_cli.actions.idempotency import idempotency_key

        a = idempotency_key(actor="marco", action_id="mail.send", target="t1",
                            payload={"to": "a@b.c", "body": "hi"})
        b = idempotency_key(actor="marco", action_id="mail.send", target="t1",
                            payload={"body": "hi", "to": "a@b.c"})
        assert a == b  # key order must not matter

    def test_a_different_body_is_a_different_action(self):
        """Two sends to one recipient with different text must both run."""
        from hermes_cli.actions.idempotency import idempotency_key

        a = idempotency_key(actor="m", action_id="mail.send", target="t",
                            payload={"body": "one"})
        b = idempotency_key(actor="m", action_id="mail.send", target="t",
                            payload={"body": "two"})
        assert a != b

    def test_only_one_caller_wins_the_claim(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        first, prior = store.claim("k1")
        assert first is True and prior is None

        second, prior = store.claim("k1")
        assert second is False
        assert prior["state"] == "in_flight"

    def test_a_retry_after_success_replays_the_original_result(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        store.claim("k1")
        store.settle("k1", state="succeeded", result={"message_id": "abc"})

        won, prior = store.claim("k1")
        assert won is False
        assert prior["state"] == "succeeded"
        assert prior["result"] == {"message_id": "abc"}

    def test_a_failure_is_recorded_so_a_retry_knows_it_is_not_the_first(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        store.claim("k1")
        store.settle("k1", state="failed", result={"error": "smtp timeout"})
        assert store.lookup("k1")["state"] == "failed"

    def test_releasing_an_unstarted_claim_allows_a_genuine_retry(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        store.claim("k1")
        store.release("k1")
        won, _ = store.claim("k1")
        assert won is True

    def test_release_cannot_erase_a_settled_outcome(self, tmp_path):
        """Releasing after a side effect would re-enable a double send."""
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        store.claim("k1")
        store.settle("k1", state="succeeded", result={"id": 1})
        store.release("k1")
        assert store.lookup("k1")["state"] == "succeeded"

    def test_an_expired_claim_does_not_wedge_the_key_forever(self, tmp_path):
        """A process that died mid-action must not block the action for good."""
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3", ttl_seconds=60)
        store.claim("k1", now=1000.0)
        won, _ = store.claim("k1", now=1000.0 + 61)
        assert won is True


class TestCostAttribution:
    def test_a_call_is_tagged_with_the_feature_that_caused_it(self, tmp_path):
        from hermes_cli.cost_attribution import CostLedger, attributed

        ledger = CostLedger(tmp_path / "cost.sqlite3")
        with attributed("news.implication", module="news", tier=3, origin="background"):
            ledger.record(provider="anthropic", model="m", cost_usd=0.02, basis="billed")

        rows = ledger.spend_by("feature")
        assert rows[0]["bucket"] == "news.implication"
        assert rows[0]["known_usd"] == pytest.approx(0.02)

    def test_an_untagged_call_is_visible_rather_than_dropped(self, tmp_path):
        from hermes_cli.cost_attribution import CostLedger

        ledger = CostLedger(tmp_path / "cost.sqlite3")
        ledger.record(provider="p", model="m", cost_usd=0.01, basis="billed")
        assert ledger.spend_by("feature")[0]["bucket"] == "unattributed"

    def test_nesting_restores_the_outer_feature(self, tmp_path):
        from hermes_cli.cost_attribution import CostLedger, attributed, get_attribution

        ledger = CostLedger(tmp_path / "cost.sqlite3")
        with attributed("briefing.assemble"):
            with attributed("news.relevance"):
                ledger.record(cost_usd=0.001, basis="billed")
            assert get_attribution().feature == "briefing.assemble"
            ledger.record(cost_usd=0.002, basis="billed")

        buckets = {r["bucket"]: r["calls"] for r in ledger.spend_by("feature")}
        assert buckets == {"news.relevance": 1, "briefing.assemble": 1}
        assert get_attribution() is None

    def test_an_exception_does_not_leak_the_attribution(self, tmp_path):
        from hermes_cli.cost_attribution import attributed, get_attribution

        with pytest.raises(RuntimeError):
            with attributed("news.implication"):
                raise RuntimeError("boom")
        assert get_attribution() is None

    def test_estimates_are_labelled_as_estimates(self, tmp_path):
        """Never invent precision the provider did not supply."""
        from hermes_cli.cost_attribution import CostLedger

        ledger = CostLedger(tmp_path / "cost.sqlite3")
        ledger.record(cost_usd=0.05, basis="billed")
        ledger.record(cost_usd=0.05, basis="priced")
        total = ledger.total()
        assert total["calls"] == 2
        assert total["estimated_calls"] == 1
        assert total["fully_billed"] is False

    def test_unpriced_calls_are_counted_not_silently_zero(self, tmp_path):
        """Treating unknown cost as zero makes the budget wrong the bad way."""
        from hermes_cli.cost_attribution import CostLedger

        ledger = CostLedger(tmp_path / "cost.sqlite3")
        ledger.record(cost_usd=None, basis="unknown")
        ledger.record(cost_usd=0.10, basis="billed")
        total = ledger.total()
        assert total["known_usd"] == pytest.approx(0.10)
        assert total["unpriced_calls"] == 1

    def test_interactive_and_background_spend_are_separable(self, tmp_path):
        """The budget degrades background first, so origin must be recorded."""
        from hermes_cli.cost_attribution import CostLedger, attributed

        ledger = CostLedger(tmp_path / "cost.sqlite3")
        with attributed("chat.answer", origin="interactive"):
            ledger.record(cost_usd=0.03, basis="billed")
        with attributed("news.implication", origin="background"):
            ledger.record(cost_usd=0.07, basis="billed")

        by_origin = {r["bucket"]: r["known_usd"] for r in ledger.spend_by("origin")}
        assert by_origin["interactive"] == pytest.approx(0.03)
        assert by_origin["background"] == pytest.approx(0.07)

    def test_grouping_is_restricted_to_known_fields(self, tmp_path):
        from hermes_cli.cost_attribution import CostLedger

        ledger = CostLedger(tmp_path / "cost.sqlite3")
        with pytest.raises(ValueError, match="cannot group spend by"):
            ledger.spend_by("feature; DROP TABLE model_spend")
