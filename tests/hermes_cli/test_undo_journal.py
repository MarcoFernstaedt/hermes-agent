"""The undo journal.

One property matters more than the rest: undo is never claimed until it is
verified. Reporting "undone" because a reversal request was sent is the same
class of lie as reporting "sent" because an approval was clicked.
"""
from __future__ import annotations

import threading
import time

import pytest

from hermes_cli.actions.registry import Rollback
from hermes_cli.undo.journal import (
    DEFAULT_IN_FLIGHT_TIMEOUT_SECONDS,
    UndoJournal,
    UndoNotPossible,
    permanence_sentence,
)


@pytest.fixture
def journal(tmp_path) -> UndoJournal:
    return UndoJournal(tmp_path / "undo.sqlite3")


def record(journal: UndoJournal, **over):
    base = dict(
        action_id="notes.edit",
        rollback=Rollback.INVERSE.value,
        rollback_detail="notes.restore",
        inverse_payload={"prior_version": 3},
        session_id="s1",
    )
    base.update(over)
    return journal.record(**base)


def external(journal: UndoJournal, **over):
    return record(
        journal,
        action_id="calendar.update",
        rollback=Rollback.COMPENSATION.value,
        rollback_detail="calendar.restore",
        inverse_payload={"prior": {"start": "09:00"}},
        **over,
    )


class TestRecording:
    def test_a_reversible_entry_needs_something_to_reverse_with(self, journal):
        # A promise that breaks the moment someone tries to keep it.
        with pytest.raises(ValueError, match="inverse_payload"):
            record(journal, inverse_payload={})

    def test_an_irreversible_entry_is_still_recorded(self, journal):
        # The owner needs to see that the thing they cannot undo did happen.
        entry = journal.record(
            action_id="mail.send",
            rollback=Rollback.IRREVERSIBLE.value,
            rollback_detail="a sent message cannot be recalled",
        )
        assert entry["status"] == "done"
        assert entry.reversible is False

    def test_rollback_detail_is_mandatory(self, journal):
        with pytest.raises(ValueError, match="rollback_detail"):
            record(journal, rollback_detail="   ")

    def test_an_unknown_rollback_kind_is_refused(self, journal):
        with pytest.raises(ValueError, match="unknown rollback"):
            record(journal, rollback="probably_fine")


class TestStack:
    def test_irreversible_entries_never_appear_in_the_stack(self, journal):
        record(journal)
        journal.record(
            action_id="mail.send",
            rollback=Rollback.IRREVERSIBLE.value,
            rollback_detail="cannot be recalled",
        )
        assert [e["action_id"] for e in journal.stack()] == ["notes.edit"]

    def test_newest_first(self, journal):
        # Timestamps must be realistic: retention is measured against *now*, so
        # 1970-era values fall outside the window and vanish from the stack.
        base = time.time()
        record(journal, action_id="a.one", now=base - 60)
        record(journal, action_id="a.two", now=base - 10)
        assert [e["action_id"] for e in journal.stack()] == ["a.two", "a.one"]

    def test_scoped_by_session(self, journal):
        record(journal, session_id="s1")
        record(journal, session_id="s2")
        assert len(journal.stack(session_id="s1")) == 1
        assert len(journal.stack()) == 2

    def test_entries_past_retention_drop_out(self, journal):
        # Offering undo past the window promises something we cannot deliver:
        # a soft-deleted row may be purged, a prior version pruned.
        old = time.time() - (20 * 24 * 3600)
        record(journal, now=old)
        assert journal.stack() == []

    def test_undo_last_agent_action_skips_the_owners_own_edits(self, journal):
        base = time.time()
        record(journal, actor="owner", action_id="owner.edit", now=base - 10)
        record(journal, actor="agent", action_id="agent.edit", now=base - 60)
        assert journal.last_undoable(actor="agent")["action_id"] == "agent.edit"

    def test_last_undoable_is_none_when_there_is_nothing(self, journal):
        assert journal.last_undoable() is None


class TestInverseUndo:
    def test_an_internal_inverse_needs_no_separate_verification(self, journal):
        entry = record(journal)
        applied = []
        done = journal.undo(entry["id"], apply=lambda e: applied.append(e["id"]))
        assert applied == [entry["id"]]
        assert done["status"] == "undone"
        assert done["undone_at"] is not None

    def test_an_undone_entry_leaves_the_stack(self, journal):
        entry = record(journal)
        journal.undo(entry["id"], apply=lambda e: None)
        assert journal.stack() == []

    def test_undoing_twice_is_refused(self, journal):
        entry = record(journal)
        journal.undo(entry["id"], apply=lambda e: None)
        with pytest.raises(UndoNotPossible, match="already"):
            journal.undo(entry["id"], apply=lambda e: None)

    def test_a_failed_inverse_stays_undoable_for_a_retry(self, journal):
        entry = record(journal)

        def boom(_e):
            raise RuntimeError("disk full")

        with pytest.raises(RuntimeError):
            journal.undo(entry["id"], apply=boom)
        # Our own transaction did not complete, so nothing changed and the
        # entry is still offerable.
        assert journal.get(entry["id"])["status"] == "done"
        assert "disk full" in journal.get(entry["id"])["outcome"]


class TestIrreversible:
    def test_it_refuses_with_the_stated_reason(self, journal):
        entry = journal.record(
            action_id="mail.send",
            rollback=Rollback.IRREVERSIBLE.value,
            rollback_detail="a sent message cannot be recalled",
        )
        with pytest.raises(UndoNotPossible, match="cannot be recalled"):
            journal.undo(entry["id"], apply=lambda e: None)

    def test_past_retention_refuses_honestly(self, journal):
        entry = record(journal, now=time.time() - (20 * 24 * 3600))
        with pytest.raises(UndoNotPossible, match="undo window"):
            journal.undo(entry["id"], apply=lambda e: None)


class TestCompensationMustBeVerified:
    def test_a_compensation_without_a_verifier_is_refused(self, journal):
        # The whole point: a compensation whose success is assumed is exactly
        # the "undone" that isn't.
        entry = external(journal)
        with pytest.raises(UndoNotPossible, match="must be verified"):
            journal.undo(entry["id"], apply=lambda e: None)

    def test_a_verified_compensation_is_reported_as_compensated(self, journal):
        entry = external(journal)
        done = journal.undo(
            entry["id"], apply=lambda e: None, verify=lambda e: True
        )
        assert done["status"] == "compensated"
        assert done["outcome"] == "verified"

    def test_a_reversal_that_did_not_take_effect_is_not_success(self, journal):
        entry = external(journal)
        with pytest.raises(UndoNotPossible, match="did not take effect"):
            journal.undo(entry["id"], apply=lambda e: None, verify=lambda e: False)
        assert journal.get(entry["id"])["status"] == "compensation_failed"

    def test_an_unverifiable_reversal_is_not_success_either(self, journal):
        entry = external(journal)

        def cannot_check(_e):
            raise ConnectionError("provider unreachable")

        with pytest.raises(UndoNotPossible, match="could not be verified"):
            journal.undo(entry["id"], apply=lambda e: None, verify=cannot_check)
        assert journal.get(entry["id"])["status"] == "compensation_failed"

    def test_a_failed_compensation_request_is_marked_failed(self, journal):
        entry = external(journal)

        def boom(_e):
            raise RuntimeError("provider rejected the update")

        with pytest.raises(RuntimeError):
            journal.undo(entry["id"], apply=boom, verify=lambda e: True)
        assert journal.get(entry["id"])["status"] == "compensation_failed"


class TestFailedCompensationsStayVisible:
    def test_they_are_listed_for_repair(self, journal):
        entry = external(journal)
        with pytest.raises(UndoNotPossible):
            journal.undo(entry["id"], apply=lambda e: None, verify=lambda e: False)

        repair = journal.needing_repair()
        assert [e["id"] for e in repair] == [entry["id"]]
        assert repair[0].needs_repair is True

    def test_they_do_not_age_out_of_view(self, journal):
        """Retention governs whether an undo is still *possible*, not whether a
        failed one stops mattering.

        The failure has to happen inside the window — an entry already past
        retention is refused before it can be attempted, so it could never
        reach `compensation_failed` in the first place. What ages here is the
        clock afterwards, not the entry beforehand.
        """
        entry = external(journal)
        with pytest.raises(UndoNotPossible):
            journal.undo(entry["id"], apply=lambda e: None, verify=lambda e: False)

        # Long past the retention window, the unrepaired failure is still shown.
        assert len(journal.needing_repair()) == 1
        assert journal.stack(now=time.time() + (60 * 24 * 3600)) == []

    def test_they_are_not_offered_as_ordinary_undo(self, journal):
        entry = external(journal)
        with pytest.raises(UndoNotPossible):
            journal.undo(entry["id"], apply=lambda e: None, verify=lambda e: False)
        assert journal.stack() == []


class TestTheClaimIsAtomic:
    """Two callers, one reversal.

    "Undo" is reachable from more than one place — the item card, the keyboard
    shortcut, a second tab — and a read-then-write claim lets both callers pass
    the status check before either writes. For an external compensation that is
    two reversal requests to a provider; for a calendar restore it is the event
    moved back twice.
    """

    def test_two_concurrent_callers_produce_exactly_one_reversal(self, journal):
        entry = record(journal)

        start = threading.Barrier(2)
        applied: list[str] = []
        applied_lock = threading.Lock()
        refused: list[BaseException] = []

        def apply(e):
            with applied_lock:
                applied.append(e["id"])
            # Hold the reversal open so the second caller is inside `undo`
            # while the first has claimed but not yet finished.
            time.sleep(0.05)

        def attempt():
            start.wait(timeout=5)
            try:
                journal.undo(entry["id"], apply=apply)
            except BaseException as exc:  # noqa: BLE001 - recorded, not swallowed
                refused.append(exc)

        threads = [threading.Thread(target=attempt) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert applied == [entry["id"]], "the inverse ran more than once"
        assert len(refused) == 1
        assert isinstance(refused[0], UndoNotPossible)

    def test_the_loser_is_told_it_is_already_in_progress(self, journal):
        entry = record(journal)

        seen: list[BaseException] = []

        def apply(_e):
            # Re-entering from inside the reversal is the same race, serialised.
            try:
                journal.undo(entry["id"], apply=lambda _x: None)
            except BaseException as exc:  # noqa: BLE001
                seen.append(exc)

        journal.undo(entry["id"], apply=apply)
        assert len(seen) == 1
        assert isinstance(seen[0], UndoNotPossible)
        assert "undoing" in str(seen[0])


class TestCrashDuringReversalStaysVisible:
    """A process that dies mid-reversal must not take the entry with it.

    The killed entry is left `undoing` or `compensating`: not `done`, so it is
    gone from the stack, and not `compensation_failed`, so it is absent from
    the repair list too. That is the worst of the three states — a possible
    half-reversed external change that nothing surfaces.
    """

    def _abandon(self, journal, entry, *, at):
        """Simulate process death after the claim and before the outcome."""
        def die(_e):
            raise SystemExit("killed")

        with pytest.raises(SystemExit):
            journal.undo(entry["id"], apply=die, verify=lambda e: True, now=at)
        # Force the abandoned in-flight state: the claim landed, the outcome
        # never did.
        journal._set_status(entry["id"], "compensating" if entry["rollback"]
                            == Rollback.COMPENSATION.value else "undoing")
        return entry

    def test_an_in_flight_reversal_is_reported_while_it_is_fresh(self, journal):
        entry = external(journal)
        now = time.time()
        self._abandon(journal, entry, at=now)

        in_flight = journal.in_flight(now=now)
        assert [e["id"] for e in in_flight] == [entry["id"]]
        # Still fresh, so not yet declared unknown — a live reversal is allowed
        # to take a moment.
        assert journal.needing_repair(now=now) == []

    def test_a_stale_compensation_becomes_an_explicit_unknown(self, journal):
        entry = external(journal)
        now = time.time()
        self._abandon(journal, entry, at=now)

        later = now + DEFAULT_IN_FLIGHT_TIMEOUT_SECONDS + 1
        repair = journal.needing_repair(now=later)
        assert [e["id"] for e in repair] == [entry["id"]]
        assert repair[0]["status"] == "reversal_unknown"
        assert repair[0].needs_repair is True
        # The words have to say what is actually true: we do not know.
        assert "do not know" in repair[0]["outcome"]

    def test_a_stale_inverse_becomes_unknown_too(self, journal):
        entry = record(journal)
        now = time.time()
        self._abandon(journal, entry, at=now)

        later = now + DEFAULT_IN_FLIGHT_TIMEOUT_SECONDS + 1
        assert [e["id"] for e in journal.needing_repair(now=later)] == [entry["id"]]

    def test_reconciling_does_not_steal_a_live_reversal(self, journal):
        entry = external(journal)
        now = time.time()
        self._abandon(journal, entry, at=now)

        assert journal.reconcile(now=now + 1) == []
        assert journal.get(entry["id"])["status"] == "compensating"

    def test_an_unknown_reversal_is_not_offered_as_ordinary_undo(self, journal):
        entry = record(journal)
        now = time.time()
        self._abandon(journal, entry, at=now)
        journal.reconcile(now=now + DEFAULT_IN_FLIGHT_TIMEOUT_SECONDS + 1)

        assert journal.stack() == []
        with pytest.raises(UndoNotPossible, match="reversal unknown"):
            journal.undo(entry["id"], apply=lambda e: None)

    def test_reconciling_is_idempotent(self, journal):
        entry = external(journal)
        now = time.time()
        self._abandon(journal, entry, at=now)
        later = now + DEFAULT_IN_FLIGHT_TIMEOUT_SECONDS + 1

        assert len(journal.reconcile(now=later)) == 1
        assert journal.reconcile(now=later + 1) == []
        assert len(journal.needing_repair(now=later + 1)) == 1


class TestFailureIsClassifiedByRollbackKind:
    """An inverse that fails is not a failed compensation.

    The distinction is the whole reason the registry makes an action declare
    which of the three it is. Filing an internal restore under
    `compensation_failed` tells the owner an external system is in a state we
    could not reverse, which sends them looking at a provider that was never
    involved.
    """

    def test_an_inverse_whose_verifier_says_it_did_not_take_is_undo_failed(self, journal):
        entry = record(journal)
        with pytest.raises(UndoNotPossible, match="did not take effect"):
            journal.undo(entry["id"], apply=lambda e: None, verify=lambda e: False)

        got = journal.get(entry["id"])
        assert got["status"] == "undo_failed"
        assert got["status"] != "compensation_failed"

    def test_an_inverse_that_cannot_be_verified_is_unknown_not_failed(self, journal):
        entry = record(journal)

        def cannot_check(_e):
            raise ConnectionError("state db unreadable")

        with pytest.raises(UndoNotPossible, match="could not be verified"):
            journal.undo(entry["id"], apply=lambda e: None, verify=cannot_check)

        assert journal.get(entry["id"])["status"] == "reversal_unknown"

    def test_both_inverse_failure_kinds_still_demand_repair(self, journal):
        failed = record(journal, action_id="a.failed")
        unknown = record(journal, action_id="a.unknown")
        with pytest.raises(UndoNotPossible):
            journal.undo(failed["id"], apply=lambda e: None, verify=lambda e: False)
        with pytest.raises(UndoNotPossible):
            journal.undo(
                unknown["id"],
                apply=lambda e: None,
                verify=lambda e: (_ for _ in ()).throw(ConnectionError("nope")),
            )

        ids = {e["id"] for e in journal.needing_repair()}
        assert ids == {failed["id"], unknown["id"]}
        assert all(e.needs_repair for e in journal.needing_repair())

    def test_a_compensation_is_still_classified_as_a_compensation(self, journal):
        entry = external(journal)
        with pytest.raises(UndoNotPossible):
            journal.undo(entry["id"], apply=lambda e: None, verify=lambda e: False)
        assert journal.get(entry["id"])["status"] == "compensation_failed"


class TestPermanenceWording:
    def test_it_matches_what_undo_can_actually_deliver(self):
        assert permanence_sentence(Rollback.INVERSE.value) == "This can be undone."
        # Never the same sentence as a true inverse.
        comp = permanence_sentence(Rollback.COMPENSATION.value)
        assert "not guaranteed" in comp
        assert comp != permanence_sentence(Rollback.INVERSE.value)

    def test_irreversible_carries_the_reason(self):
        assert "cannot be recalled" in permanence_sentence(
            Rollback.IRREVERSIBLE.value, "cannot be recalled"
        )
