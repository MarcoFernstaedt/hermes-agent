"""A resubmitted prompt is one prompt, not two.

The realtime path makes duplicate submission ordinary rather than exotic. A
socket drops between the gateway accepting a prompt and the acknowledgement
reaching the browser; the client reconnects and has to decide what to do with a
message whose fate it cannot determine. Both available answers are wrong —
dropping it loses what the owner typed, resending it runs the turn twice — and
there is no third one that does not involve guessing.

So the client mints a token per composed message and presents the same one on
every send of it, and the gateway decides which situation it is actually in.
These tests exercise the claim/record/release helpers directly, because the
property is about what the gateway remembers rather than about how a turn runs.
"""
from __future__ import annotations

import collections
import threading

import pytest

from tui_gateway import server


@pytest.fixture
def session() -> dict:
    return {"history_lock": threading.Lock(), "session_key": "k"}


class TestTheFirstSubmissionGoesAhead:
    def test_an_unseen_token_does_not_replay_anything(self, session):
        assert server._claim_submit_token(session, "tok-1") is None

    def test_claiming_records_that_it_is_in_flight(self, session):
        server._claim_submit_token(session, "tok-1")
        assert session["_submit_tokens"]["tok-1"] is server._SUBMIT_IN_FLIGHT


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

    def test_releasing_never_discards_a_recorded_outcome(self, session):
        # Release is only ever correct for a claim that produced nothing.
        server._claim_submit_token(session, "tok-1")
        server._record_submit_outcome(session, "tok-1", {"status": "streaming"})
        server._release_submit_token(session, "tok-1")
        assert server._claim_submit_token(session, "tok-1")["status"] == "streaming"

    def test_releasing_an_unknown_token_is_harmless(self, session):
        server._release_submit_token(session, "never-seen")
        server._release_submit_token(session, "")


class TestTheTableIsBounded:
    def test_it_forgets_the_oldest_tokens_first(self, session):
        for i in range(server._SUBMIT_TOKEN_MEMORY + 10):
            server._claim_submit_token(session, f"tok-{i}")

        seen = session["_submit_tokens"]
        assert len(seen) == server._SUBMIT_TOKEN_MEMORY
        assert "tok-0" not in seen
        assert f"tok-{server._SUBMIT_TOKEN_MEMORY + 9}" in seen

    def test_a_recently_used_token_is_kept(self, session):
        # Recency, not insertion order: the token being resent is exactly the
        # one that must not have been evicted.
        server._claim_submit_token(session, "tok-old")
        server._record_submit_outcome(session, "tok-old", {"status": "streaming"})
        for i in range(server._SUBMIT_TOKEN_MEMORY - 1):
            server._claim_submit_token(session, f"filler-{i}")
        server._claim_submit_token(session, "tok-old")  # touched
        for i in range(5):
            server._claim_submit_token(session, f"later-{i}")

        assert "tok-old" in session["_submit_tokens"]


class TestConcurrency:
    def test_only_one_of_many_simultaneous_claims_wins(self, session):
        """Two tabs, or a retry racing the original. Exactly one submits."""
        results: list = []
        barrier = threading.Barrier(8)

        def claim():
            barrier.wait()
            results.append(server._claim_submit_token(session, "tok-1"))

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
