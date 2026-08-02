"""The undo machinery, reachable.

Everything under `hermes_cli.undo` existed and nothing called it. `record` was
wired into vault writes, so the journal filled up correctly — and then no
production command, RPC, or screen ever read it back. An undo stack nobody can
reach is a data structure, not a feature, and the states that exist precisely
so a person can act on them (`compensation_failed`, `undo_failed`,
`reversal_unknown`) were unreachable by any person.

This module is the one place that turns journal entries into something a
surface can render, and turns a surface's decision back into a reversal. The
gateway RPC and the CLI command are both thin adapters over it, so the two
cannot disagree about what an entry means, what a conflict says, or what
forcing does.

Three things it deliberately does *not* do:

*It does not decide a conflict on the owner's behalf.* `apply` refuses and
returns the report; forcing is a separate call carrying the owner's answer
back. That is what makes the report worth rendering.

*It does not hide in-flight reversals.* A reversal that has been claimed and
is still running is neither done nor failed, and reporting it as either would
be a false statement about the world. It gets its own list.

*It does not age the repair list.* Retention governs whether an undo is still
*possible*. Whether an unreversed action still matters is not a function of
how long ago it happened.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from hermes_cli.undo.journal import JournalEntry

#: What a surface may ask for. Named so an RPC can validate before dispatching.
VIEWS = ("stack", "repairs", "in_flight")


def _view(entry: JournalEntry, *, root: Path | None = None) -> dict:
    """One entry, in the shape a list row needs.

    The inverse payload is summarised rather than passed through: it carries
    absolute backup paths and content hashes, which a screen has no use for and
    which should not travel to a browser.
    """
    payload = entry.get("inverse_payload") or {}
    return {
        "id": entry.get("id"),
        "action": entry.get("action_id"),
        "actor": entry.get("actor"),
        "session_id": entry.get("session_id"),
        "target": entry.get("target"),
        "status": entry.get("status"),
        "rollback": entry.get("rollback"),
        "rollback_detail": entry.get("rollback_detail"),
        "outcome": entry.get("outcome"),
        "created_at": entry.get("created_at"),
        "claimed_at": entry.get("claimed_at"),
        "undone_at": entry.get("undone_at"),
        "reversible": bool(entry.reversible),
        "needs_repair": bool(entry.needs_repair),
        "in_flight": bool(entry.in_flight),
        # Was this a create or a change? It is the difference between "the note
        # will be deleted" and "the note will go back to what it said", which
        # is the whole content of an undo confirmation.
        "creates_note": payload.get("existed") is False,
        "permanence": permanence(entry),
    }


def permanence(entry: JournalEntry) -> str:
    from hermes_cli.undo.journal import permanence_sentence

    try:
        return permanence_sentence(
            str(entry.get("rollback") or ""), str(entry.get("rollback_detail") or "")
        )
    except Exception:
        return ""


def stack(*, session_id: str = "", limit: int = 50) -> list[dict]:
    """What could be undone right now, newest first."""
    from hermes_cli.undo.actions import journal

    return [_view(e) for e in journal().stack(session_id=session_id, limit=limit)]


def repairs() -> list[dict]:
    """Everything a person has to look at, with why.

    `needing_repair` reconciles first, which is what makes a reversal abandoned
    by a killed process reachable at all — it has no other route to a screen.
    """
    from hermes_cli.undo.actions import journal

    return [_view(e) for e in journal().needing_repair()]


def in_flight() -> list[dict]:
    """Reversals claimed and still plausibly running."""
    from hermes_cli.undo.actions import journal

    return [_view(e) for e in journal().in_flight()]


def summary(*, session_id: str = "", limit: int = 50) -> dict:
    """Everything a screen needs in one call.

    The three lists are separate because they mean different things, and the
    counts are included so a nav badge does not have to fetch and length the
    lists to know whether there is anything to show.
    """
    entries = stack(session_id=session_id, limit=limit)
    needing = repairs()
    running = in_flight()
    return {
        "stack": entries,
        "repairs": needing,
        "in_flight": running,
        "counts": {
            "stack": len(entries),
            "repairs": len(needing),
            "in_flight": len(running),
        },
    }


def preview(entry_id: str, *, root: Path | None = None) -> dict:
    """What undoing this would do, and what stands in the way.

    Answered without changing anything, so a confirmation dialog can be built
    from it. ``conflict`` is None when the reversal would go straight through;
    otherwise it is the structured report — which note, what the undo expected
    to find, what is actually there — rather than only a message.
    """
    from hermes_cli.undo.actions import conflict_report, journal

    entry = journal().get(entry_id)
    view = _view(entry, root=root)
    report: Optional[dict] = None
    if entry.get("status") == "done":
        try:
            report = conflict_report(entry, root=root)
        except Exception as exc:
            # A preview that cannot look must not report "no conflict"; the
            # whole point of it is to be the thing that looked.
            report = {
                "kind": "unreadable",
                "message": f"this entry could not be checked: {exc}",
            }
    view["conflict"] = report
    view["can_undo"] = entry.get("status") == "done" and report is None
    # `backup_missing` is the one conflict force cannot answer: there is
    # nothing to restore, so offering the button would be offering a failure.
    view["can_force"] = (
        entry.get("status") == "done"
        and report is not None
        and report.get("kind") != "backup_missing"
    )
    return view


class UndoRefused(RuntimeError):
    """The reversal did not run, and the report says why.

    Carries the structured conflict so a caller can render it rather than
    parsing a sentence. A refusal leaves the entry exactly as it was — still
    `done`, still offerable — because a conflict is the undo working, not the
    undo breaking, and it must not consume what it declined to do.
    """

    def __init__(self, message: str, report: dict | None = None):
        super().__init__(message)
        self.report = report or {}


class UndoFailed(RuntimeError):
    """The reversal ran and did not take. The journal already knows.

    Distinct from `UndoRefused`, which means nothing was attempted. This one
    leaves the entry in a repair state — `undo_failed` when we looked and the
    change is still there, `reversal_unknown` when the inverse raised partway
    and we cannot say what happened — so the honest thing for a surface to do
    is report the recorded state and point at the repair list, not to claim a
    generic error.
    """

    def __init__(self, message: str, entry: dict | None = None):
        super().__init__(message)
        self.entry = entry or {}


def apply(
    entry_id: str,
    *,
    force: bool = False,
    root: Path | None = None,
) -> dict:
    """Reverse one recorded action.

    Raises `UndoRefused` when nothing was attempted (a conflict, or an entry
    that is not offerable), and `UndoFailed` when the reversal ran and did not
    take. The distinction is the whole point: the first leaves the entry still
    undoable, the second leaves it needing a person.

    ``force`` is not a way to skip the check. The check has already run and
    produced a report the caller was shown; this is the caller carrying that
    answer back. It cannot conjure a backup that is gone.
    """
    from hermes_cli.undo.actions import VaultUndoConflict, journal, undo_entry
    from hermes_cli.undo.journal import UndoNotPossible

    try:
        entry = undo_entry(entry_id, root=root, force=force)
    except VaultUndoConflict as exc:
        raise UndoRefused(str(exc), getattr(exc, "report", None)) from exc
    except UndoNotPossible as exc:
        # `undo()` raises this both for "not offerable" (nothing ran) and for
        # "attempted and could not be verified" (something may have). The
        # recorded status is what tells them apart, so read it rather than
        # guessing from the message.
        raise _classify(entry_id, exc, root=root) from exc
    except Exception as exc:
        # The inverse itself raised. The journal has already moved the entry to
        # a repair state; a surface reporting only "something went wrong" would
        # hide the one fact the owner can act on.
        raise _classify(entry_id, exc, root=root) from exc
    return _view(entry, root=root)


def _classify(entry_id: str, exc: Exception, *, root: Path | None = None):
    """Turn a reversal exception into the right kind of refusal.

    Reads the journal rather than the message: the status is the record of what
    happened, and a sentence is not.
    """
    from hermes_cli.undo.actions import journal

    try:
        entry = journal().get(entry_id)
    except Exception:
        return UndoRefused(str(exc))
    if entry.needs_repair:
        return UndoFailed(str(exc), _view(entry, root=root))
    return UndoRefused(str(exc))


def apply_last(
    *,
    actor: str = "agent",
    session_id: str = "",
    force: bool = False,
    root: Path | None = None,
) -> Optional[dict]:
    """"Undo the last thing you did." None when there is nothing offerable."""
    from hermes_cli.undo.actions import journal

    entry = journal().last_undoable(actor=actor, session_id=session_id)
    if entry is None:
        return None
    return apply(entry["id"], force=force, root=root)


def render_lines(payload: dict) -> list[str]:
    """The summary as plain lines, for a terminal.

    Shared with the CLI rather than formatted there, so the two surfaces cannot
    describe the same entry differently — the specific risk being that one of
    them quietly omits the repair list.
    """
    lines: list[str] = []
    repairs_list: list[dict[str, Any]] = payload.get("repairs") or []
    running: list[dict[str, Any]] = payload.get("in_flight") or []
    entries: list[dict[str, Any]] = payload.get("stack") or []

    if repairs_list:
        # First, and unconditionally. These are the states where what the owner
        # was told and what is true may differ, and burying them under a list
        # of successful undos is how they stay unnoticed.
        lines.append(f"Needs attention ({len(repairs_list)}):")
        for row in repairs_list:
            lines.append(
                f"  ! {row['id'][:8]}  {row['status']}  {row.get('target') or row['action']}"
                + (f"  — {row['outcome']}" if row.get("outcome") else "")
            )
        lines.append("")

    if running:
        lines.append(f"Reversals in progress ({len(running)}):")
        for row in running:
            lines.append(
                f"  ~ {row['id'][:8]}  {row['status']}  {row.get('target') or row['action']}"
            )
        lines.append("")

    if not entries:
        lines.append("Nothing to undo.")
        return lines

    lines.append(f"Undo stack ({len(entries)}, newest first):")
    for row in entries:
        lines.append(
            f"  {row['id'][:8]}  {row.get('target') or row['action']}"
            f"  [{row.get('actor')}]"
        )
    return lines
