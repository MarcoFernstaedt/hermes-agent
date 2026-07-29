"""The item store.

Two things are being defended: that an existing review database survives the
generalisation with its rows intact and correctly reinterpreted, and that two
clients deciding the same item cannot both win.
"""
from __future__ import annotations

import json
import sqlite3
import time

import pytest

from hermes_cli.items.lifecycle import IllegalTransition, NotificationClass, State
from hermes_cli.items.store import ItemConflict, ItemNotFound, ItemStore


@pytest.fixture
def store(tmp_path) -> ItemStore:
    return ItemStore(tmp_path / "items.sqlite3")


def make(store: ItemStore, **over):
    base = dict(kind="capability", title="Add a Recipes area")
    base.update(over)
    return store.create(**base)


class TestMigrationFromReview:
    def test_an_existing_review_database_keeps_its_rows(self, tmp_path):
        """This extends the review table in place; it must not orphan data."""
        path = tmp_path / "review.sqlite3"
        conn = sqlite3.connect(path)
        conn.execute(
            """CREATE TABLE proposals (
                 id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
                 summary TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'agent',
                 risk TEXT NOT NULL DEFAULT 'low', status TEXT NOT NULL DEFAULT 'pending',
                 payload TEXT NOT NULL DEFAULT '{}', preview TEXT NOT NULL DEFAULT '{}',
                 outcome TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL,
                 decided_at REAL, applied_at REAL)"""
        )
        conn.execute(
            "INSERT INTO proposals (id, kind, title, status, created_at) VALUES "
            "('a','capability','Old pending','pending',1.0),"
            "('b','skill','Old applied','applied',2.0),"
            "('c','skill','Old rejected','rejected',3.0)"
        )
        conn.commit()
        conn.close()

        store = ItemStore(path)

        # A pending proposal already meant "awaiting a decision" — same meaning,
        # new vocabulary, no reinterpretation.
        assert store.get("a")["state"] == State.AWAITING_DECISION.value
        # An applied one actually executed, so it is succeeded, not merely approved.
        assert store.get("b")["state"] == State.SUCCEEDED.value
        assert store.get("c")["state"] == State.DENIED.value
        assert store.get("a")["title"] == "Old pending"

    def test_migration_is_idempotent(self, tmp_path):
        path = tmp_path / "items.sqlite3"
        first = ItemStore(path)
        make(first, title="Keep me")
        second = ItemStore(path)  # re-running migrate must not disturb anything
        assert len(second.stream()) == 1

    def test_new_columns_do_not_clobber_a_hand_set_state(self, tmp_path):
        path = tmp_path / "items.sqlite3"
        store = ItemStore(path)
        item = make(store, state=State.OPEN.value)
        ItemStore(path)  # migrate again
        assert store.get(item["id"])["state"] == State.OPEN.value


class TestCreate:
    def test_defaults_to_an_actionable_item_awaiting_decision(self, store):
        item = make(store)
        assert item["klass"] == NotificationClass.ACTIONABLE.value
        assert item["state"] == State.AWAITING_DECISION.value
        assert item["version"] == 1
        assert item["seq"] >= 1

    def test_an_unknown_notification_class_is_refused(self, store):
        with pytest.raises(ValueError, match="unknown notification class"):
            make(store, klass="urgent-ish")

    def test_an_unknown_state_is_refused(self, store):
        with pytest.raises(ValueError):
            make(store, state="probably_fine")

    def test_a_blank_title_is_refused(self, store):
        with pytest.raises(ValueError, match="title is required"):
            make(store, title="   ")

    def test_provenance_answers_why_am_i_seeing_this(self, store):
        item = make(store, rule_id="news.relevance", provenance={"score": 0.82})
        assert item["rule_id"] == "news.relevance"
        assert item["provenance"] == {"score": 0.82}


class TestConcurrentDecisions:
    def test_two_tabs_cannot_both_win(self, store):
        item = make(store)
        store.approve(item["id"])
        with pytest.raises(ItemConflict) as exc:
            store.deny(item["id"], reason="changed my mind")
        # The loser is told what won, so the card can say "decided elsewhere"
        # rather than overwriting a real decision.
        assert exc.value.actual == State.APPROVED.value
        assert exc.value.expected == State.AWAITING_DECISION.value

    def test_the_winning_decision_survives_the_loser(self, store):
        item = make(store)
        store.approve(item["id"])
        with pytest.raises(ItemConflict):
            store.deny(item["id"])
        assert store.get(item["id"])["state"] == State.APPROVED.value

    def test_a_missing_item_is_distinguished_from_a_conflict(self, store):
        with pytest.raises(ItemNotFound):
            store.approve("nope")

    def test_version_increments_so_a_stale_frame_can_be_discarded(self, store):
        item = make(store)
        assert item["version"] == 1
        after = store.approve(item["id"])
        assert after["version"] == 2

    def test_seq_advances_across_items_for_replay(self, store):
        a = make(store, title="A")
        b = make(store, title="B")
        assert b["seq"] > a["seq"]
        moved = store.approve(a["id"])
        assert moved["seq"] > b["seq"]


class TestIllegalMovesAreRefusedBeforeTouchingTheDatabase:
    def test_approval_cannot_be_recorded_as_success(self, store):
        item = make(store)
        store.approve(item["id"])
        with pytest.raises(IllegalTransition):
            store.record_execution(
                item["id"], expect=State.APPROVED.value, to=State.SUCCEEDED.value
            )

    def test_the_item_is_untouched_after_an_illegal_move(self, store):
        item = make(store)
        with pytest.raises(IllegalTransition):
            store.transition(item["id"], expect=State.AWAITING_DECISION.value,
                             to=State.SUCCEEDED.value)
        fresh = store.get(item["id"])
        assert fresh["state"] == State.AWAITING_DECISION.value
        assert fresh["version"] == 1


class TestExecution:
    def test_the_full_path_records_attempts_and_outcome(self, store):
        item = make(store)
        i = item["id"]
        store.approve(i)
        store.record_execution(i, expect=State.APPROVED.value, to=State.QUEUED.value,
                               idempotency_key="k1")
        running = store.record_execution(i, expect=State.QUEUED.value,
                                         to=State.EXECUTING.value)
        assert running["attempt"] == 1
        done = store.record_execution(i, expect=State.EXECUTING.value,
                                      to=State.SUCCEEDED.value, outcome="sent")
        assert done["state"] == State.SUCCEEDED.value
        assert done["outcome"] == "sent"
        assert done["applied_at"] is not None
        assert done["idempotency_key"] == "k1"

    def test_a_retry_counts_a_second_attempt(self, store):
        i = make(store)["id"]
        store.approve(i)
        store.record_execution(i, expect=State.APPROVED.value, to=State.QUEUED.value)
        store.record_execution(i, expect=State.QUEUED.value, to=State.EXECUTING.value)
        store.record_execution(i, expect=State.EXECUTING.value, to=State.FAILED.value,
                               outcome="smtp timeout")
        store.record_execution(i, expect=State.FAILED.value, to=State.QUEUED.value)
        again = store.record_execution(i, expect=State.QUEUED.value,
                                       to=State.EXECUTING.value)
        assert again["attempt"] == 2


class TestDenialAndSnooze:
    def test_a_denial_reason_is_kept_as_feedback(self, store):
        i = make(store)["id"]
        denied = store.deny(i, reason="wrong recipient")
        assert denied["reason"] == "wrong recipient"

    def test_snooze_requires_a_time_or_a_condition(self, store):
        i = make(store)["id"]
        with pytest.raises(ValueError, match="time or a condition"):
            store.snooze(i)

    def test_a_due_snooze_is_found_and_woken_once(self, store):
        i = make(store)["id"]
        store.snooze(i, until=time.time() - 5)
        assert [d["id"] for d in store.due_snoozes()] == [i]

        store.wake(i)
        assert store.get(i)["state"] == State.AWAITING_DECISION.value
        assert store.due_snoozes() == []

        # Waking twice is refused rather than double-firing.
        with pytest.raises(ItemConflict):
            store.wake(i)

    def test_a_future_snooze_is_not_due(self, store):
        i = make(store)["id"]
        store.snooze(i, until=time.time() + 3600)
        assert store.due_snoozes() == []

    def test_waking_clears_the_snooze_fields(self, store):
        i = make(store)["id"]
        store.snooze(i, until=time.time() - 1, condition="")
        store.wake(i)
        assert store.get(i)["snoozed_until"] is None


class TestStreamProjection:
    def test_blocking_sorts_first_then_oldest(self, store):
        make(store, title="info", klass="informational")
        make(store, title="block", klass="blocking")
        make(store, title="act-old", klass="actionable")
        make(store, title="act-new", klass="actionable")

        titles = [i["title"] for i in store.stream()]
        assert titles[0] == "block"
        assert titles.index("act-old") < titles.index("act-new")
        assert titles[-1] == "info"

    def test_ordering_is_done_in_sql_so_pages_agree(self, store):
        """Sorting client-side would let page two disagree with page one."""
        for n in range(5):
            make(store, title=f"a{n}", klass="actionable")
        make(store, title="blocker", klass="blocking")
        assert store.stream(limit=1)[0]["title"] == "blocker"

    def test_the_review_queue_is_a_filter_not_a_second_store(self, store):
        make(store, title="waiting")
        done = make(store, title="finished")
        store.deny(done["id"])

        queue = store.stream(states=[State.AWAITING_DECISION.value])
        assert [i["title"] for i in queue] == ["waiting"]
        # Both rows still live in the one table.
        assert len(store.stream()) == 2

    def test_replay_returns_only_what_changed(self, store):
        a = make(store, title="A")
        marker = a["seq"]
        b = make(store, title="B")
        assert [i["id"] for i in store.since(marker)] == [b["id"]]

    def test_counts_group_by_state(self, store):
        make(store)
        store.deny(make(store)["id"])
        counts = store.counts_by_state()
        assert counts[State.AWAITING_DECISION.value] == 1
        assert counts[State.DENIED.value] == 1


class TestJsonColumns:
    def test_payload_round_trips(self, store):
        item = make(store, payload={"to": "a@b.c", "body": "hi"})
        assert store.get(item["id"])["payload"] == {"to": "a@b.c", "body": "hi"}

    def test_a_corrupt_json_column_degrades_to_empty_not_a_crash(self, store, tmp_path):
        item = make(store)
        conn = sqlite3.connect(tmp_path / "items.sqlite3")
        conn.execute("UPDATE proposals SET payload = 'not json' WHERE id = ?", (item["id"],))
        conn.commit()
        conn.close()
        assert store.get(item["id"])["payload"] == {}

    def test_a_dict_field_is_serialised_on_transition(self, store):
        i = make(store)["id"]
        updated = store.transition(
            i, expect=State.AWAITING_DECISION.value, to=State.DENIED.value,
            provenance={"rule": "manual"},
        )
        assert updated["provenance"] == {"rule": "manual"}
        assert isinstance(json.dumps(updated["provenance"]), str)
