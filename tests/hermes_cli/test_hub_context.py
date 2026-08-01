"""The volatile context tier.

The contract that matters here is not the exact wording of any line — it is
that the payload *always answers*. A context tool that raises, or that silently
drops a section it could not read, is a context tool the agent learns to stop
calling. Round-2 recon found zero calls across thirty days because the tool did
not exist; these tests exist so it never quietly stops being useful either.
"""
from __future__ import annotations

import pytest


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "state").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: h)
    # Modules that did `from hermes_constants import get_hermes_home` hold
    # their own binding, so patching the source module alone leaves them
    # pointing at the real home. That is not a theoretical concern: with the
    # life router unpatched, every test in this file shared one progress
    # database, so a test that completed a routine left the income gate open
    # for the next one and the failure appeared in a test that had done
    # nothing wrong.
    for module in ("hermes_cli.life.router",):
        try:
            monkeypatch.setattr(f"{module}.get_hermes_home", lambda: h)
        except AttributeError:
            pass
    return h


def test_payload_shape(home):
    from hermes_cli.hub_context import collect_hub_context

    out = collect_hub_context()
    assert isinstance(out["attention"], list) and out["attention"]
    assert set(out["sections"]) == {
        "jobs", "review", "guardrails", "capabilities", "progress", "health",
    }
    assert isinstance(out["generated_at"], str)


def test_a_broken_section_states_why_and_does_not_break_the_payload(home, monkeypatch):
    from hermes_cli import hub_context

    def boom() -> dict:
        raise RuntimeError("database is on fire")

    monkeypatch.setitem(hub_context._SECTION_FNS, "review", boom)
    out = hub_context.collect_hub_context()

    assert out["sections"]["review"]["available"] is False
    assert "database is on fire" in out["sections"]["review"]["reason"]
    # Every other section still reported.
    assert out["sections"]["health"]["available"] is True


def test_sections_argument_narrows_the_payload(home):
    from hermes_cli.hub_context import collect_hub_context

    out = collect_hub_context(["health"])
    assert set(out["sections"]) == {"health"}


def test_unknown_section_names_are_ignored_not_fatal(home):
    """A slightly-wrong tool call should still return useful context."""
    from hermes_cli.hub_context import collect_hub_context

    out = collect_hub_context(["health", "not_a_section"])
    assert set(out["sections"]) == {"health"}
    # All-unknown falls back to everything rather than returning nothing.
    from hermes_cli.hub_context import _SECTION_FNS

    assert len(collect_hub_context(["nope"])["sections"]) == len(_SECTION_FNS)


def test_halt_leads_the_attention_list(home, monkeypatch):
    """Nothing else can happen while the global stop is engaged, so it goes first."""
    from hermes_cli import agent_scopes, hub_context

    monkeypatch.setattr(agent_scopes, "is_agent_halted", lambda: True)
    out = hub_context.collect_hub_context()

    assert out["sections"]["guardrails"]["halted"] is True
    assert "halted" in out["sections"]["guardrails"]["note"].lower()
    assert "stop is engaged" in out["attention"][0]


def test_pending_approvals_are_surfaced(home):
    from hermes_cli.hub_context import collect_hub_context
    from hermes_cli.review.store import ReviewStore

    store = ReviewStore(home / "state" / "review.sqlite3")
    store.create(kind="capability", title="Add a Recipes area", payload={})

    out = collect_hub_context(["review"])
    assert out["sections"]["review"]["counts"]["pending"] == 1
    assert out["sections"]["review"]["pending"][0]["title"] == "Add a Recipes area"
    assert "waiting on your approval" in " ".join(out["attention"])


def test_quiet_state_says_so_rather_than_returning_an_empty_list():
    """An empty attention list renders as a blank surface. Say "nothing" instead."""
    from hermes_cli.hub_context import _attention

    quiet = {
        "guardrails": {"halted": False},
        "review": {"counts": {"pending": 0}},
        "jobs": {"next_actions": []},
        "capabilities": {"due_or_overdue": []},
        "health": {"status": "ok", "problems": []},
    }
    lines = _attention(quiet)
    assert lines == ["Nothing is waiting. No approvals pending, no overdue items."]


def test_attention_is_ordered_by_what_actually_blocks_the_owner():
    """Halt first (nothing else can run), then decisions, then income, then dates."""
    from hermes_cli.hub_context import _attention

    everything = {
        "guardrails": {"halted": True},
        "review": {"counts": {"pending": 3}},
        "jobs": {
            "counts": {"packet_ready": 7},
            "next_actions": [{"role": "Support Engineer", "company": "Acme"}],
        },
        "capabilities": {"due_or_overdue": [{"date": "2026-01-01"}]},
        "health": {"status": "warn", "problems": ["build: warn"]},
    }
    lines = _attention(everything)
    assert "stop is engaged" in lines[0]
    assert "3 proposals waiting" in lines[1]
    assert "7 packets ready to send" in lines[2]
    assert "Support Engineer at Acme" in lines[2]
    assert "1 tracked item due" in lines[3]
    assert "Platform health is warn" in lines[4]


def test_registered_as_an_auto_tool_and_actually_discoverable():
    """Loop-wrapped registration has silently hidden three tools before now."""
    from pathlib import Path

    from tools.registry import _module_registers_tools

    assert _module_registers_tools(Path("tools/hub_context_tools.py")) is True

    import tools.hub_context_tools  # noqa: F401
    from hermes_cli.module_permissions import Tier, get_tier

    assert get_tier("hub_context") is Tier.AUTO


def test_tool_returns_the_same_assembler_output(home):
    import json

    from tools.hub_context_tools import _handle_hub_context

    payload = json.loads(_handle_hub_context({"sections": ["health"]}))
    body = payload.get("result", payload)
    if isinstance(body, str):
        body = json.loads(body)
    assert "sections" in body
    assert set(body["sections"]) == {"health"}


class TestProgressIsWhatNowSaysAboutTheDay:
    """The routines the owner keeps had no representation in the payload.

    `hub_context` reported jobs, review, guardrails, capabilities and health,
    and said nothing about the day they had already written down — so a Now
    screen built on it answered "what needs me?" with everything except the
    part most likely to be acted on. There is exactly one record of those
    routines; this reads it rather than defining "done" a second time.
    """

    def test_an_uninitialised_store_says_so_rather_than_reporting_no_routines(
        self, home
    ):
        # "Never set up" and "set up and all done" are different facts, and a
        # screen that conflates them tells the owner their day is finished.
        from hermes_cli.hub_context import collect_hub_context

        section = collect_hub_context(["progress"])["sections"]["progress"]
        assert section["available"] is False
        assert "not initialised" in section["reason"]

    def test_it_reports_completion_from_the_progress_store(self, home, monkeypatch):
        from hermes_cli.life.repository import LifeRepository
        from hermes_cli.life.router import default_database_path
        from hermes_cli.hub_context import collect_hub_context

        repo = LifeRepository(default_database_path())
        repo.migrate()
        today = repo.today()
        total = today["totals"]["active"]
        assert total, "the seeded store should carry the default routines"

        section = collect_hub_context(["progress"])["sections"]["progress"]
        assert section["available"] is True
        assert section["routines"] == {"completed": 0, "total": total}
        assert len(section["incomplete"]) <= total

    def test_a_completed_routine_is_not_listed(self, home):
        from hermes_cli.life.repository import LifeRepository
        from hermes_cli.life.router import default_database_path
        from hermes_cli.hub_context import collect_hub_context

        repo = LifeRepository(default_database_path())
        repo.migrate()
        today = repo.today()
        habit = today["habits"][0]
        repo.set_entry(
            habit["id"], day=today["day"], value=float(habit["target"]), note="",
        )

        section = collect_hub_context(["progress"])["sections"]["progress"]
        listed = {item["id"] for item in section["incomplete"]}
        assert habit["id"] not in listed
        assert section["routines"]["completed"] == 1

    def test_the_income_gate_travels_with_it(self, home):
        # The gate is what constrains the day rather than merely filling it.
        from hermes_cli.life.repository import LifeRepository
        from hermes_cli.life.router import default_database_path
        from hermes_cli.hub_context import collect_hub_context

        LifeRepository(default_database_path()).migrate()
        section = collect_hub_context(["progress"])["sections"]["progress"]
        assert section["income_gate"]["open"] is False
        assert section["income_gate"]["message"]

    def test_a_closed_gate_leads_the_routine_line_in_attention(self, home):
        from hermes_cli.life.repository import LifeRepository
        from hermes_cli.life.router import default_database_path
        from hermes_cli.hub_context import collect_hub_context

        LifeRepository(default_database_path()).migrate()
        lines = collect_hub_context()["attention"]
        gate = next(i for i, line in enumerate(lines) if "Income gate" in line)
        routines = next(i for i, line in enumerate(lines) if "routines done today" in line)
        assert gate < routines

    def test_yesterdays_written_intention_is_carried_and_never_invented(
        self, home
    ):
        """Their words, or nothing. No placeholder, no derived stand-in."""
        from datetime import date, timedelta

        from hermes_cli.life.repository import LifeRepository
        from hermes_cli.life.router import default_database_path
        from hermes_cli.hub_context import collect_hub_context

        repo = LifeRepository(default_database_path())
        repo.migrate()
        assert collect_hub_context(["progress"])["sections"]["progress"]["intention"] is None

        yesterday = (date.today() - timedelta(days=1)).isoformat()
        repo.set_reflection(
            day=yesterday, wake_time="", bedtime="", energy=None, mood="",
            win="", obstacle="", lesson="", tomorrow="Finish the packet for Acme.",
        )
        section = collect_hub_context(["progress"])["sections"]["progress"]
        assert section["intention"] == "Finish the packet for Acme."

    def test_a_broken_progress_store_does_not_break_the_payload(
        self, home, monkeypatch
    ):
        from hermes_cli import hub_context

        monkeypatch.setitem(
            hub_context._SECTION_FNS, "progress",
            lambda: (_ for _ in ()).throw(RuntimeError("db is on fire")),
        )
        out = hub_context.collect_hub_context()
        assert out["sections"]["progress"]["available"] is False
        assert out["sections"]["health"]["available"] is True
