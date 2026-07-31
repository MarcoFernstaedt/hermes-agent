"""The undo journal.

One property matters more than the rest: undo is never claimed until it is
verified. Reporting "undone" because a reversal request was sent is the same
class of lie as reporting "sent" because an approval was clicked.
"""
from __future__ import annotations

import time

import pytest

from hermes_cli.actions.registry import Rollback
from hermes_cli.undo.journal import (
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
