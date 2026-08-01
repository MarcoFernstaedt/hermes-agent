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

        a = idempotency_key(actor="m", action_id="mail.send", target="t",
                            payload={"body": "one"})
        b = idempotency_key(actor="m", action_id="mail.send", target="t",
                            payload={"body": "one"})
        assert a == b

    def test_a_different_payload_is_a_different_key(self):
        from hermes_cli.actions.idempotency import idempotency_key

        a = idempotency_key(actor="m", action_id="mail.send", target="t",
                            payload={"body": "one"})
        b = idempotency_key(actor="m", action_id="mail.send", target="t",
                            payload={"body": "two"})
        assert a != b

    def test_only_one_caller_wins_the_claim(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        first, prior, attempt = store.claim("k1")
        assert first is True and prior is None and attempt

        second, prior, lost = store.claim("k1")
        assert second is False
        assert prior["state"] == "in_flight"
        # A loser gets no token, so it cannot write anything at all.
        assert lost is None

    def test_a_retry_after_success_replays_the_original_result(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, attempt = store.claim("k1")
        store.mark_dispatching("k1", attempt)
        store.settle_dispatched("k1", attempt, state="succeeded", result={"message_id": "abc"})

        won, prior, _ = store.claim("k1")
        assert won is False
        assert prior["state"] == "succeeded"
        assert prior["result"] == {"message_id": "abc"}

    def test_a_failure_is_recorded_so_a_retry_knows_it_is_not_the_first(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, attempt = store.claim("k1")
        store.settle_pre_dispatch("k1", attempt, result={"error": "smtp timeout"})
        assert store.lookup("k1")["state"] == "failed"

    def test_a_failed_attempt_can_be_retried_and_carries_the_first_failure(self, tmp_path):
        """Recording a failure must not wedge the key.

        Idempotency exists to stop something happening *twice*. A proven
        pre-dispatch failure means it did not happen once, so refusing the
        retry converts a transient provider error into a whole day in which
        that exact message can never be sent.
        """
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, attempt = store.claim("k1")
        store.settle_pre_dispatch("k1", attempt, result={"error": "smtp timeout"})

        won, prior, retry_attempt = store.claim("k1")
        assert won is True
        assert retry_attempt and retry_attempt != attempt
        assert prior["state"] == "failed"
        assert prior["result"] == {"error": "smtp timeout"}

    def test_reacquiring_after_a_failure_is_itself_exclusive(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        store.settle_pre_dispatch("k1", a, result={"error": "smtp timeout"})

        assert store.claim("k1")[0] is True
        won, prior, _ = store.claim("k1")
        assert won is False
        assert prior["state"] == "in_flight"

    def test_a_success_is_never_reacquired(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        store.mark_dispatching("k1", a)
        store.settle_dispatched("k1", a, state="succeeded", result={"id": 1})
        won, prior, _ = store.claim("k1")
        assert won is False
        assert prior["state"] == "succeeded"

    def test_releasing_an_unstarted_claim_allows_a_genuine_retry(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        assert store.release("k1", a) is True
        won, _, _ = store.claim("k1")
        assert won is True

    def test_release_cannot_erase_a_settled_outcome(self, tmp_path):
        """Releasing after a side effect would re-enable a double send."""
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        store.mark_dispatching("k1", a)
        store.settle_dispatched("k1", a, state="succeeded", result={"id": 1})
        assert store.release("k1", a) is False
        assert store.lookup("k1")["state"] == "succeeded"

    def test_an_expired_pre_dispatch_claim_does_not_wedge_the_key(self, tmp_path):
        """A process that died before acting must not block the action forever."""
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3", ttl_seconds=60)
        store.claim("k1", now=1000.0)
        won, _, _ = store.claim("k1", now=1000.0 + 61)
        assert won is True


class TestAStaleClaimantCannotWriteOverALiveOne:
    """The adversarial case the review demonstrated.

    A claimed, expired, then re-claimed by someone else, and stale A settled
    B's row as a success. Settling by key alone made that possible.
    """

    def test_a_stale_attempt_cannot_settle_the_current_holders_row(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3", ttl_seconds=60)
        _, _, a = store.claim("k1", now=1000.0)
        won_b, _, b = store.claim("k1", now=1000.0 + 61)
        assert won_b is True and b != a

        # A returns late and tries to record its outcome.
        assert store.settle_dispatched("k1", a, state="succeeded", result={"id": "A"}) is False
        assert store.lookup("k1")["state"] == "in_flight"

        # B's own settlement still works, through the two-phase path.
        assert store.mark_dispatching("k1", b) is True
        assert store.settle_dispatched("k1", b, state="succeeded", result={"id": "B"}) is True
        assert store.lookup("k1")["result"] == {"id": "B"}

    def test_a_stale_attempt_cannot_release_the_current_holders_row(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3", ttl_seconds=60)
        _, _, a = store.claim("k1", now=1000.0)
        _, _, b = store.claim("k1", now=1000.0 + 61)
        assert store.release("k1", a) is False
        assert store.lookup("k1")["attempt"] == b

    def test_a_loser_holds_no_token_and_can_write_nothing(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        store.claim("k1")
        _, _, lost = store.claim("k1")
        assert lost is None
        assert store.settle_dispatched("k1", "invented", state="succeeded") is False


class TestAmbiguousOutcomesStayBlocked:
    """An external effect that may have landed is not a failure.

    Gmail accepts the send, the response connection drops, and the send is
    recorded as failed — then an approved retry sends a second copy. The state
    between "we decided to act" and "we know what happened" has to have a name.
    """

    def test_a_dispatching_claim_is_recorded_before_the_request_leaves(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        assert store.mark_dispatching("k1", a) is True
        assert store.lookup("k1")["state"] == "dispatching"

    def test_only_the_owner_can_mark_it_dispatching(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        store.claim("k1")
        assert store.mark_dispatching("k1", "invented") is False

    def test_an_ambiguous_outcome_is_not_retryable(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        store.mark_dispatching("k1", a)
        store.settle_dispatched("k1", a, state="ambiguous", result={"error": "connection reset"})

        won, prior, token = store.claim("k1")
        assert won is False
        assert prior["state"] == "ambiguous"
        assert token is None

    def test_elapsed_time_never_unblocks_an_ambiguous_outcome(self, tmp_path):
        # Time is not evidence about an external system.
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3", ttl_seconds=60)
        _, _, a = store.claim("k1", now=1000.0)
        store.mark_dispatching("k1", a)
        store.settle_dispatched("k1", a, state="ambiguous", result={"error": "reset"})

        won, prior, _ = store.claim("k1", now=1000.0 + 10_000)
        assert won is False
        assert prior["state"] == "ambiguous"

    def test_an_abandoned_dispatch_becomes_ambiguous_rather_than_retryable(self, tmp_path):
        """A process that died *after* dispatching may already have sent."""
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3", ttl_seconds=60)
        _, _, a = store.claim("k1", now=1000.0)
        store.mark_dispatching("k1", a)

        won, prior, _ = store.claim("k1", now=1000.0 + 61)
        assert won is False
        assert prior["state"] == "ambiguous"

    def test_a_success_survives_the_claim_ttl(self, tmp_path):
        """Forgetting a success is how a duplicate gets authorised."""
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3", ttl_seconds=60)
        _, _, a = store.claim("k1", now=1000.0)
        store.mark_dispatching("k1", a)
        store.settle_dispatched("k1", a, state="succeeded", result={"id": "x"})

        won, prior, _ = store.claim("k1", now=1000.0 + 10_000)
        assert won is False
        assert prior["state"] == "succeeded"

    def test_an_unknown_settle_state_is_refused(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        store.mark_dispatching("k1", a)
        with pytest.raises(ValueError, match="not a post-dispatch outcome"):
            store.settle_dispatched("k1", a, state="probably_fine")


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


class TestReconciliationCannotBeOverwritten:
    """The exact sequence the review reproduced.

    A claim enters `dispatching`; reconciliation moves it to `ambiguous`; the
    stale worker returns and settles `succeeded`. Ownership alone did not stop
    it, because reconciliation left the attempt token in place — so the worker
    matched its own token and overwrote an outcome that existed precisely
    because nobody knew what had happened.
    """

    def _abandoned_then_reconciled(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3", ttl_seconds=60)
        _, _, stale = store.claim("k1", now=1000.0)
        store.mark_dispatching("k1", stale)
        store.claim("k1", now=1000.0 + 61)  # reconciles the abandoned dispatch
        assert store.lookup("k1")["state"] == "ambiguous"
        return store, stale

    def test_a_stale_worker_cannot_claim_success_over_ambiguous(self, tmp_path):
        store, stale = self._abandoned_then_reconciled(tmp_path)
        assert store.settle_dispatched("k1", stale, state="succeeded",
                                       result={"id": "X"}) is False
        assert store.lookup("k1")["state"] == "ambiguous"

    def test_reconciliation_drops_the_old_owner(self, tmp_path):
        store, stale = self._abandoned_then_reconciled(tmp_path)
        assert store.lookup("k1")["attempt"] is None
        assert stale is not None

    def test_a_stale_worker_cannot_write_any_outcome(self, tmp_path):
        store, stale = self._abandoned_then_reconciled(tmp_path)
        for state in ("succeeded", "ambiguous"):
            assert store.settle_dispatched("k1", stale, state=state) is False
        assert store.settle_pre_dispatch("k1", stale) is False
        assert store.lookup("k1")["state"] == "ambiguous"


class TestSettlementNamesTheStateItExpects:
    def test_a_pre_dispatch_failure_cannot_be_written_after_dispatch(self, tmp_path):
        # "It never left" is only sayable before it left.
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        store.mark_dispatching("k1", a)
        assert store.settle_pre_dispatch("k1", a) is False
        assert store.lookup("k1")["state"] == "dispatching"

    def test_a_post_dispatch_outcome_cannot_be_written_before_dispatch(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        assert store.settle_dispatched("k1", a, state="succeeded") is False
        assert store.lookup("k1")["state"] == "in_flight"

    def test_only_reconciliation_may_record_a_post_dispatch_failure(self, tmp_path):
        # An exception is not a look; a search of Sent is.
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        store.mark_dispatching("k1", a)
        with pytest.raises(ValueError, match="not a post-dispatch outcome"):
            store.settle_dispatched("k1", a, state="failed")
        assert store.settle_reconciled("k1", a, state="failed") is True


class TestAdoptingAnAmbiguousRow:
    def test_only_one_reconciler_can_adopt(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        store.mark_dispatching("k1", a)
        store.settle_dispatched("k1", a, state="ambiguous")

        first = store.adopt_ambiguous("k1")
        assert first is not None
        assert store.adopt_ambiguous("k1") is None

    def test_a_terminal_row_cannot_be_adopted(self, tmp_path):
        from hermes_cli.actions.idempotency import IdempotencyStore

        store = IdempotencyStore(tmp_path / "idem.sqlite3")
        _, _, a = store.claim("k1")
        store.mark_dispatching("k1", a)
        store.settle_dispatched("k1", a, state="succeeded", result={"id": 1})
        assert store.adopt_ambiguous("k1") is None
