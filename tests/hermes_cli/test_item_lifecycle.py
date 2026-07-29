"""The item lifecycle.

The defect this module exists to prevent: a card that reads "approved" for an
email that never sent. Approval is a decision; success is a verified outcome;
the state machine must not let the first masquerade as the second.
"""
from __future__ import annotations

import pytest

from hermes_cli.items.lifecycle import (
    NotificationClass,
    State,
    TRANSITIONS,
    IllegalTransition,
    assert_transition,
    can_transition,
    is_decided,
    is_executed,
    is_terminal,
    may_interrupt,
    needs_attention,
    sort_key,
)


class TestApprovalIsNotExecution:
    def test_approval_cannot_jump_straight_to_success(self):
        """The single most important rule in the module."""
        assert not can_transition(State.APPROVED, State.SUCCEEDED)
        with pytest.raises(IllegalTransition):
            assert_transition(State.APPROVED, State.SUCCEEDED)

    def test_success_is_reachable_only_from_executing(self):
        sources = [s for s, targets in TRANSITIONS.items() if State.SUCCEEDED in targets]
        assert sources == [State.EXECUTING]

    def test_an_approved_item_is_decided_but_not_executed(self):
        assert is_decided(State.APPROVED) is True
        assert is_executed(State.APPROVED) is False

    def test_the_full_happy_path_is_walkable(self):
        path = [
            State.OPEN, State.AWAITING_DECISION, State.APPROVED,
            State.QUEUED, State.EXECUTING, State.SUCCEEDED,
        ]
        for frm, to in zip(path, path[1:]):
            assert_transition(frm, to)

    def test_undecided_states_are_not_decided(self):
        for s in (State.OPEN, State.ACKNOWLEDGED, State.AWAITING_DECISION,
                  State.MODIFYING, State.SNOOZED):
            assert is_decided(s) is False


class TestModification:
    def test_modifying_returns_to_a_decision_not_to_execution(self):
        """The owner must approve the exact payload they last looked at."""
        assert can_transition(State.AWAITING_DECISION, State.MODIFYING)
        assert can_transition(State.MODIFYING, State.AWAITING_DECISION)
        assert not can_transition(State.MODIFYING, State.APPROVED)
        assert not can_transition(State.MODIFYING, State.QUEUED)


class TestFailureAndRetry:
    def test_a_failed_execution_retries_through_the_queue(self):
        assert can_transition(State.FAILED, State.QUEUED)
        # Never straight back to running — the queue is where idempotency and
        # backoff live.
        assert not can_transition(State.FAILED, State.EXECUTING)

    def test_failure_is_not_terminal_but_needs_attention(self):
        assert is_terminal(State.FAILED) is False
        assert needs_attention(State.FAILED) is True

    def test_a_failed_compensation_never_goes_quiet(self):
        """The world is in a state we tried and failed to undo."""
        assert is_terminal(State.COMPENSATION_FAILED) is False
        assert needs_attention(State.COMPENSATION_FAILED) is True
        assert can_transition(State.COMPENSATION_FAILED, State.COMPENSATING)


class TestCompensation:
    def test_undo_runs_only_against_something_that_happened(self):
        assert can_transition(State.SUCCEEDED, State.COMPENSATING)
        for s in (State.APPROVED, State.QUEUED, State.DENIED, State.OPEN):
            assert not can_transition(s, State.COMPENSATING)

    def test_compensated_is_terminal(self):
        assert is_terminal(State.COMPENSATED)
        assert TRANSITIONS[State.COMPENSATED] == frozenset()


class TestTerminalStates:
    @pytest.mark.parametrize(
        "state", [State.DENIED, State.EXPIRED, State.CANCELED, State.COMPENSATED]
    )
    def test_terminal_states_have_no_exits(self, state):
        assert TRANSITIONS[state] == frozenset()
        assert is_terminal(state)

    def test_success_is_terminal_but_still_reversible(self):
        """Terminal means 'needs nothing further', not 'frozen'."""
        assert is_terminal(State.SUCCEEDED)
        assert can_transition(State.SUCCEEDED, State.COMPENSATING)

    def test_a_denied_item_cannot_be_quietly_revived(self):
        with pytest.raises(IllegalTransition):
            assert_transition(State.DENIED, State.APPROVED)


class TestSnooze:
    def test_snooze_wakes_back_into_the_stream(self):
        assert can_transition(State.SNOOZED, State.OPEN)
        assert can_transition(State.SNOOZED, State.AWAITING_DECISION)

    def test_a_snoozed_item_can_still_expire(self):
        """Snoozing past an item's usefulness must not resurrect it."""
        assert can_transition(State.SNOOZED, State.EXPIRED)


class TestTransitionGraphIntegrity:
    def test_every_state_has_an_entry(self):
        assert set(TRANSITIONS) == set(State)

    def test_every_target_is_a_real_state(self):
        for frm, targets in TRANSITIONS.items():
            for t in targets:
                assert isinstance(t, State), f"{frm} → {t!r}"

    def test_no_state_transitions_to_itself(self):
        for frm, targets in TRANSITIONS.items():
            assert frm not in targets, f"{frm.value} loops to itself"

    def test_every_non_initial_state_is_reachable_from_open(self):
        """An unreachable state is dead code pretending to be a contract."""
        seen = {State.OPEN}
        frontier = [State.OPEN]
        while frontier:
            for nxt in TRANSITIONS[frontier.pop()]:
                if nxt not in seen:
                    seen.add(nxt)
                    frontier.append(nxt)
        assert seen == set(State), f"unreachable: {sorted(s.value for s in set(State) - seen)}"


class TestNotificationPolicy:
    def test_blocking_sorts_ahead_of_everything(self):
        items = [
            {"id": "d", "klass": "informational", "created_at": 1},
            {"id": "c", "klass": "opportunity", "created_at": 2},
            {"id": "b", "klass": "actionable", "created_at": 3},
            {"id": "a", "klass": "blocking", "created_at": 4},
        ]
        assert [i["id"] for i in sorted(items, key=sort_key)] == ["a", "b", "c", "d"]

    def test_oldest_first_within_a_class(self):
        items = [
            {"id": "new", "klass": "actionable", "created_at": 20},
            {"id": "old", "klass": "actionable", "created_at": 10},
        ]
        assert [i["id"] for i in sorted(items, key=sort_key)] == ["old", "new"]

    def test_only_blocking_items_may_interrupt(self):
        for klass in ("actionable", "opportunity", "informational"):
            item = {"klass": klass, "state": State.OPEN.value}
            assert may_interrupt(item, stream_focused=False) is False
        blocking = {"klass": "blocking", "state": State.OPEN.value}
        assert may_interrupt(blocking, stream_focused=False) is True

    def test_nothing_toasts_while_the_owner_is_reading_the_stream(self):
        blocking = {"klass": "blocking", "state": State.OPEN.value}
        assert may_interrupt(blocking, stream_focused=True) is False

    def test_an_already_decided_item_does_not_toast(self):
        """A decision made in another tab must not pop up here."""
        decided = {"klass": "blocking", "state": State.APPROVED.value}
        assert may_interrupt(decided, stream_focused=False) is False

    def test_the_four_classes_are_exactly_the_taxonomy(self):
        assert [c.value for c in NotificationClass] == [
            "blocking", "actionable", "opportunity", "informational",
        ]


class TestClientMirrorHasNotDrifted:
    """`web/src/lib/itemState.ts` mirrors this enum so the card can render a
    state without a round trip. A state the client does not know renders as a
    blank card; one the server does not know produces a rejected transition the
    owner cannot explain. Either way the drift is invisible until it bites."""

    def test_every_state_exists_on_both_sides(self):
        import re
        from pathlib import Path

        source = Path("web/src/lib/itemState.ts").read_text(encoding="utf-8")
        block = re.search(r"export const State = \{(.*?)\} as const;", source, re.S)
        assert block, "could not find the State mirror in the frontend"
        client = set(re.findall(r':\s*"([a-z_]+)"', block.group(1)))
        server = {s.value for s in State}
        assert client == server, (
            f"only in client: {sorted(client - server)}; "
            f"only in server: {sorted(server - client)}"
        )

    def test_notification_classes_match(self):
        import re
        from pathlib import Path

        source = Path("web/src/lib/itemState.ts").read_text(encoding="utf-8")
        block = re.search(
            r"export const NOTIFICATION_CLASSES = \[(.*?)\] as const;", source, re.S
        )
        assert block
        client = re.findall(r'"([a-z]+)"', block.group(1))
        assert client == [c.value for c in NotificationClass]

    def test_class_rank_matches(self):
        import re
        from pathlib import Path
        from hermes_cli.items.lifecycle import CLASS_RANK

        source = Path("web/src/lib/itemState.ts").read_text(encoding="utf-8")
        block = re.search(
            r"export const CLASS_RANK: Record<NotificationClass, number> = \{(.*?)\};",
            source, re.S,
        )
        assert block
        client = {k: int(v) for k, v in re.findall(r"(\w+):\s*(\d+)", block.group(1))}
        assert client == CLASS_RANK
