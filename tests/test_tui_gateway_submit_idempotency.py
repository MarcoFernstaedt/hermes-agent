"""A resubmitted prompt is one prompt, not two.

The realtime path makes duplicate submission ordinary rather than exotic. A
socket drops between the gateway accepting a prompt and the acknowledgement
reaching the browser; the client reconnects and has to decide what to do with a
message whose fate it cannot determine. Both available answers are wrong —
dropping it loses what the owner typed, resending it runs the turn twice — and
there is no third one that does not involve guessing.

So the client mints a token per composed message and presents the same one on
every send of it, and the gateway decides which situation it is actually in.

Two of these classes cover failures the first version of this mechanism had,
and they are the reason it lives in `submit_ledger` rather than in a dictionary
on the session:

* `TestALiveClaimIsNeverForgotten` — the table evicted its oldest entry under
  pressure, and the oldest entry is frequently a long turn that is still
  running. Forgetting it turns the next resubmission of that message into a
  first submission.
* `TestAClaimOutlivesTheProcess` — the table lived in the live session dict, so
  an orphan reap, a restart, or a cold resume erased every record. That is
  exactly the window in which a client resends, because it reconnects
  *because* something died.
"""
from __future__ import annotations

import collections
import threading

import pytest

from tui_gateway import server, submit_ledger


@pytest.fixture(autouse=True)
def _fresh_store(tmp_path, monkeypatch):
    """A store under this test's own HERMES_HOME.

    The handle is cached by path, so the global HERMES_HOME redirection in
    `tests/conftest.py` is enough — this only asserts it, and drops any handle
    a previous test in the same process left behind.
    """
    submit_ledger._reset_for_tests()
    yield
    submit_ledger._reset_for_tests()


@pytest.fixture
def session() -> dict:
    return {"history_lock": threading.Lock(), "session_key": "durable-key-1"}


def entry(session: dict, token: str):
    return session["_submit_tokens"][token]


class TestTheFirstSubmissionGoesAhead:
    def test_an_unseen_token_does_not_replay_anything(self, session):
        assert server._claim_submit_token(session, "tok-1") is None

    def test_claiming_records_that_it_is_in_flight(self, session):
        server._claim_submit_token(session, "tok-1")
        assert entry(session, "tok-1")["state"] == "in_flight"


class TestARepeatDoesNotRunTwice:
    def test_a_repeat_while_the_first_is_running_is_told_it_is_queued(self, session):
        # Not "accepted": that would be a second promise about one message.
        # "Queued" is true — it is going to run, and it is not running yet.
        server._claim_submit_token(session, "tok-1")
        assert server._claim_submit_token(session, "tok-1") == {
            "status": "queued",
            "duplicate": True,
        }

    def test_a_repeat_after_the_first_finished_replays_its_outcome(self, session):
        server._claim_submit_token(session, "tok-1")
        server._record_submit_outcome(session, "tok-1", {"status": "streaming"})

        assert server._claim_submit_token(session, "tok-1") == {
            "status": "streaming",
            "duplicate": True,
        }

    def test_the_replay_says_it_is_one(self, session):
        """`duplicate` is the client's cue not to add a second bubble.

        Without it a resend looks exactly like a fresh acceptance, and the
        optimistic row the client already has would be joined by another.
        """
        server._claim_submit_token(session, "tok-1")
        server._record_submit_outcome(session, "tok-1", {"status": "queued"})
        assert server._claim_submit_token(session, "tok-1")["duplicate"] is True

    def test_recording_does_not_hand_out_the_stored_dict(self, session):
        # A caller mutating the response it was given would rewrite history.
        server._claim_submit_token(session, "tok-1")
        server._record_submit_outcome(session, "tok-1", {"status": "streaming"})
        first = server._claim_submit_token(session, "tok-1")
        first["status"] = "tampered"
        assert server._claim_submit_token(session, "tok-1")["status"] == "streaming"

    def test_different_messages_do_not_collide(self, session):
        server._claim_submit_token(session, "tok-1")
        assert server._claim_submit_token(session, "tok-2") is None


class TestARefusalDoesNotStick:
    def test_a_released_token_can_be_submitted_again(self, session):
        """A submission that was refused did not happen.

        Holding the token would make the retry a no-op: the client would
        resend, be told "queued, duplicate", and wait forever for a turn nobody
        started. That is worse than the duplicate this whole mechanism exists
        to prevent, because it is silent.
        """
        server._claim_submit_token(session, "tok-1")
        server._release_submit_token(session, "tok-1")
        assert server._claim_submit_token(session, "tok-1") is None

    def test_a_release_is_durable_too(self, session):
        """A refusal must survive the restart, or the retry wedges forever.

        The durable row would otherwise still say "this was claimed", and a
        resubmission after a reconnect would be told it is queued behind a turn
        that was never started.
        """
        server._claim_submit_token(session, "tok-1")
        server._release_submit_token(session, "tok-1")
        assert server._claim_submit_token(cold_resume(session), "tok-1") is None

    def test_releasing_never_discards_a_recorded_outcome(self, session):
        # Release is only ever correct for a claim that produced nothing.
        server._claim_submit_token(session, "tok-1")
        server._record_submit_outcome(session, "tok-1", {"status": "streaming"})
        server._release_submit_token(session, "tok-1")
        assert server._claim_submit_token(session, "tok-1")["status"] == "streaming"

    def test_releasing_an_unknown_token_is_harmless(self, session):
        server._release_submit_token(session, "never-seen")
        server._release_submit_token(session, "")


def cold_resume(session: dict) -> dict:
    """The same conversation, after the process that held it went away.

    Same durable `session_key`, no in-memory table — which is precisely what a
    resume, an orphan reap, or a gateway restart produces.
    """
    return {
        "history_lock": threading.Lock(),
        "session_key": session["session_key"],
    }


class TestALiveClaimIsNeverForgotten:
    def test_pressure_evicts_settled_entries_and_leaves_live_ones(self, session):
        """The defect: `popitem(last=False)` dropped whatever was oldest.

        A long turn submitted before a burst of short ones was the first thing
        evicted, and the resubmission it was protecting then went through as a
        first submission.
        """
        server._claim_submit_token(session, "long-running")  # never settles
        for i in range(submit_ledger.SUBMIT_TOKEN_MEMORY + 20):
            server._claim_submit_token(session, f"short-{i}")
            server._record_submit_outcome(session, f"short-{i}", {"status": "done"})

        seen = session["_submit_tokens"]
        assert "long-running" in seen, "an in-flight claim was evicted"
        assert entry(session, "long-running")["state"] == "in_flight"
        # And the resubmission it protects is still recognised as one.
        assert server._claim_submit_token(session, "long-running") == {
            "status": "queued", "duplicate": True,
        }

    def test_settled_entries_are_still_trimmed(self, session):
        for i in range(submit_ledger.SUBMIT_TOKEN_MEMORY + 20):
            server._claim_submit_token(session, f"tok-{i}")
            server._record_submit_outcome(session, f"tok-{i}", {"status": "done"})
        assert len(session["_submit_tokens"]) <= submit_ledger.SUBMIT_TOKEN_MEMORY

    def test_a_trimmed_outcome_is_still_answered_from_the_store(self, session):
        """Trimming the cache must not turn a settled message into a new one."""
        server._claim_submit_token(session, "tok-old")
        server._record_submit_outcome(session, "tok-old", {"status": "streaming"})
        for i in range(submit_ledger.SUBMIT_TOKEN_MEMORY + 20):
            server._claim_submit_token(session, f"filler-{i}")
            server._record_submit_outcome(session, f"filler-{i}", {"status": "done"})

        assert "tok-old" not in session["_submit_tokens"]
        assert server._claim_submit_token(session, "tok-old") == {
            "status": "streaming", "duplicate": True,
        }

    def test_a_flood_of_live_claims_is_refused_rather_than_forgotten(self, session):
        """Refusing is the safe direction.

        The alternative is dropping a claim that is currently protecting a
        message, and a visible error the client can retry is much better than a
        silent duplicate.
        """
        for i in range(submit_ledger.MAX_LIVE_CLAIMS):
            server._claim_submit_token(session, f"live-{i}")
        with pytest.raises(submit_ledger.SubmitLedgerFull):
            server._claim_submit_token(session, "one-too-many")


class TestAClaimOutlivesTheProcess:
    def test_a_settled_outcome_survives_a_cold_resume(self, session):
        server._claim_submit_token(session, "tok-1")
        server._record_submit_outcome(session, "tok-1", {"status": "streaming"})

        replayed = server._claim_submit_token(cold_resume(session), "tok-1")
        assert replayed == {"status": "streaming", "duplicate": True}

    def test_an_unsettled_claim_survives_a_cold_resume(self, session):
        """The gateway died mid-turn. The message may already be in history.

        Resubmitting it silently is how one prompt becomes two, so the answer
        is explicitly unresolved rather than an acceptance.
        """
        server._claim_submit_token(session, "tok-1")

        replayed = server._claim_submit_token(cold_resume(session), "tok-1")
        assert replayed is not None
        assert replayed["duplicate"] is True
        assert replayed["status"] in ("queued", "unresolved")

    def test_a_different_conversation_is_not_the_same_message(self, session):
        # The key is scoped to the durable session, so the same client token in
        # another conversation is a different message and must go through.
        server._claim_submit_token(session, "tok-1")
        other = {"history_lock": threading.Lock(), "session_key": "durable-key-2"}
        assert server._claim_submit_token(other, "tok-1") is None

    def test_the_key_uses_the_durable_session_not_the_live_one(self, session):
        # A key derived from the regenerated live id would make every restart
        # look like a different conversation, which defeats persisting it.
        key = submit_ledger._durable_key(session, "tok-1")
        assert session["session_key"] in key
        assert key.startswith("prompt_submit:")


class TestReconcilingBeforeResending:
    def test_a_token_the_gateway_never_saw_is_safe_to_resend(self, session):
        report = submit_ledger.lookup(session, "never-sent")
        assert report["state"] == "unknown"
        assert report["resend"] is True

    def test_a_settled_token_must_not_be_resent(self, session):
        server._claim_submit_token(session, "tok-1")
        server._record_submit_outcome(session, "tok-1", {"status": "streaming"})
        report = submit_ledger.lookup(session, "tok-1")
        assert report["resend"] is False
        assert report["result"]["status"] == "streaming"

    def test_a_live_claim_must_not_be_resent(self, session):
        server._claim_submit_token(session, "tok-1")
        assert submit_ledger.lookup(session, "tok-1")["resend"] is False

    def test_a_settled_token_is_still_recognised_after_a_cold_resume(self, session):
        server._claim_submit_token(session, "tok-1")
        server._record_submit_outcome(session, "tok-1", {"status": "streaming"})
        report = submit_ledger.lookup(cold_resume(session), "tok-1")
        assert report["state"] == "settled"
        assert report["resend"] is False

    def test_a_store_that_cannot_be_read_never_says_resend(self, session, monkeypatch):
        """Not being able to look is not evidence that nothing landed."""
        class Broken:
            def lookup(self, key):
                raise RuntimeError("store unreadable")

        monkeypatch.setattr(submit_ledger, "_durable_store", lambda: Broken())
        report = submit_ledger.lookup(session, "tok-1")
        assert report["resend"] is False
        assert report["state"] == "unresolved"


class TestConcurrency:
    def test_only_one_of_many_simultaneous_claims_wins(self, session):
        """Two tabs, or a retry racing the original. Exactly one submits."""
        results: list = []
        results_lock = threading.Lock()
        barrier = threading.Barrier(8)

        def claim():
            barrier.wait()
            outcome = server._claim_submit_token(session, "tok-1")
            with results_lock:
                results.append(outcome)

        threads = [threading.Thread(target=claim) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert sum(1 for r in results if r is None) == 1

    def test_the_token_table_never_takes_the_history_lock(self, session):
        """It has its own lock, and the reason is a real deadlock.

        `history_lock` is a plain `threading.Lock`, and two of the release
        sites in `prompt.submit` sit inside a block already holding it. Reusing
        it would wedge the handler on its own error paths.
        """
        session["history_lock"].acquire()
        try:
            # Would hang forever if these reached for the session's lock.
            server._claim_submit_token(session, "tok-1")
            server._record_submit_outcome(session, "tok-1", {"status": "streaming"})
            server._release_submit_token(session, "tok-1")
        finally:
            session["history_lock"].release()
        assert isinstance(session["_submit_tokens"], collections.OrderedDict)


class TestDegradedStore:
    def test_an_unopenable_store_still_stops_an_in_process_duplicate(
        self, session, monkeypatch
    ):
        """Refusing every prompt because a database file is unwritable would be
        a much larger outage than the one being prevented."""
        monkeypatch.setattr(submit_ledger, "_durable_store", lambda: None)
        assert server._claim_submit_token(session, "tok-1") is None
        assert server._claim_submit_token(session, "tok-1") == {
            "status": "queued", "duplicate": True,
        }


class TestTheHandlerAcceptsTheParameter:
    def test_a_blank_or_absent_token_disables_the_check(self, session):
        # Nothing is remembered, and every submission goes ahead — the
        # behaviour every existing client already gets.
        assert server._claim_submit_token(session, "") is None
        assert session.get("_submit_tokens") is None or not session["_submit_tokens"]

    def test_the_parameter_is_read_and_bounded(self):
        import inspect

        source = inspect.getsource(server)
        assert 'params.get("client_token")' in source
        # Unbounded client-supplied keys are a memory-growth vector even with
        # an evicting table; the length cap is part of the contract.
        assert "[:128]" in source

    def test_a_full_ledger_becomes_an_error_not_a_silent_duplicate(self):
        import inspect

        source = inspect.getsource(server)
        assert "except SubmitLedgerFull" in source
