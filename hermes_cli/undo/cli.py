"""`hermes undo` — the command that makes the journal reachable from a shell.

Thin over `hermes_cli.undo.surface`, deliberately: the gateway RPC is thin over
the same module, so a terminal and a browser cannot disagree about what an
entry means or what forcing does.

The one behaviour worth stating here rather than in the surface: a conflict
exits non-zero and prints the report, and `--force` is a separate invocation.
An `--undo-anyway-if-conflicted` flag on the first call would let a script
answer a question it never asked, which is the opposite of what the conflict
report is for.
"""
from __future__ import annotations

import argparse
import json


def _emit(payload, as_json: bool, lines=None) -> None:
    if as_json:
        print(json.dumps(payload, indent=2, default=str))
        return
    for line in lines or []:
        print(line)


def cmd_list(args: argparse.Namespace) -> int:
    from hermes_cli.undo import surface

    payload = surface.summary(
        session_id=getattr(args, "session", "") or "",
        limit=getattr(args, "limit", 50) or 50,
    )
    _emit(payload, getattr(args, "json", False), surface.render_lines(payload))
    return 0


def cmd_repairs(args: argparse.Namespace) -> int:
    """Only the entries a person has to look at.

    Its own subcommand because these never age out and are not scoped to a
    session: an action that could not be reversed still matters wherever the
    owner happens to be looking.
    """
    from hermes_cli.undo import surface

    rows = surface.repairs()
    if getattr(args, "json", False):
        print(json.dumps(rows, indent=2, default=str))
        return 0 if not rows else 1
    if not rows:
        print("Nothing needs attention.")
        return 0
    print(f"Needs attention ({len(rows)}):")
    for row in rows:
        print(f"  {row['id']}  {row['status']}  {row.get('target') or row['action']}")
        if row.get("outcome"):
            print(f"      {row['outcome']}")
    # Non-zero: this is the state where what the owner was told and what is
    # true may differ, so a script checking it should notice.
    return 1


def cmd_show(args: argparse.Namespace) -> int:
    from hermes_cli.undo import surface

    try:
        payload = surface.preview(args.entry_id)
    except Exception as exc:
        print(f"That entry could not be read: {exc}")
        return 1
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, default=str))
        return 0
    print(f"{payload['id']}  {payload['status']}")
    print(f"  action:  {payload['action']}")
    print(f"  target:  {payload.get('target') or '(none)'}")
    print(f"  actor:   {payload.get('actor')}")
    if payload.get("permanence"):
        print(f"  {payload['permanence']}")
    conflict = payload.get("conflict")
    if conflict:
        print(f"  conflict [{conflict.get('kind')}]: {conflict.get('message')}")
        print(
            "  Re-run with --force to overwrite anyway."
            if payload.get("can_force")
            else "  This cannot be forced; there is nothing to restore."
        )
    elif payload.get("can_undo"):
        print("  Ready to undo.")
    return 0


def cmd_apply(args: argparse.Namespace) -> int:
    from hermes_cli.undo import surface

    entry_id = getattr(args, "entry_id", "") or ""
    try:
        if entry_id:
            result = surface.apply(entry_id, force=bool(args.force))
        else:
            result = surface.apply_last(
                actor=getattr(args, "actor", "agent") or "agent",
                session_id=getattr(args, "session", "") or "",
                force=bool(args.force),
            )
            if result is None:
                print("Nothing to undo.")
                return 0
    except surface.UndoRefused as exc:
        # The undo working, not the undo breaking. The entry is untouched and
        # still offerable once the owner has looked.
        print(f"Refused: {exc}")
        report = exc.report or {}
        if report.get("kind") and report["kind"] != "backup_missing":
            print("Re-run with --force if you have looked and still want this.")
        return 2
    except surface.UndoFailed as exc:
        # A different answer: the reversal ran and did not take, so retrying is
        # not the next step — looking at it is.
        status = (exc.entry or {}).get("status") or "unknown"
        print(f"The reversal did not take ({status}): {exc}")
        print("See `hermes undo repairs`.")
        return 3
    except Exception as exc:
        print(f"The undo could not be run: {exc}")
        return 1

    if getattr(args, "json", False):
        print(json.dumps(result, indent=2, default=str))
        return 0
    print(f"Undone: {result.get('target') or result.get('action')} ({result['status']})")
    return 0 if result.get("status") == "undone" else 1


def register_cli(parser: argparse.ArgumentParser) -> None:
    """Wire subcommands onto the ``hermes undo`` parser."""
    parser.set_defaults(func=cmd_list)  # bare `hermes undo` → show the stack
    parser.add_argument("--json", action="store_true", help="Machine-readable output")
    subs = parser.add_subparsers(dest="undo_command", metavar="COMMAND")

    p_list = subs.add_parser(
        "list",
        help="Show what can be undone, what needs attention, and what is mid-reversal",
    )
    p_list.add_argument("--session", default="", help="Scope the stack to one session")
    p_list.add_argument("--limit", type=int, default=50)
    p_list.add_argument("--json", action="store_true")
    p_list.set_defaults(func=cmd_list)

    p_repairs = subs.add_parser(
        "repairs",
        help="Only the reversals that failed or whose outcome is unknown",
        description=(
            "Entries in compensation_failed, undo_failed or reversal_unknown. "
            "These never age out of view: retention governs whether an undo is "
            "still possible, not whether an unreversed action still matters. "
            "Exits non-zero when there is anything to look at."
        ),
    )
    p_repairs.add_argument("--json", action="store_true")
    p_repairs.set_defaults(func=cmd_repairs)

    p_show = subs.add_parser(
        "show",
        help="What undoing one entry would do, and what stands in the way",
    )
    p_show.add_argument("entry_id")
    p_show.add_argument("--json", action="store_true")
    p_show.set_defaults(func=cmd_show)

    p_apply = subs.add_parser(
        "apply",
        help="Reverse an entry (or the most recent one)",
        description=(
            "With no entry id, undoes the most recent offerable action. A "
            "conflict — the note changed since, or the saved previous version "
            "is gone — refuses and exits 2 with the reason; --force is how you "
            "carry your answer back after reading it."
        ),
    )
    p_apply.add_argument("entry_id", nargs="?", default="")
    p_apply.add_argument("--session", default="")
    p_apply.add_argument("--actor", default="agent")
    p_apply.add_argument(
        "--force", action="store_true",
        help="Overwrite a note that has changed since. Cannot restore a backup "
             "that is gone.",
    )
    p_apply.add_argument("--json", action="store_true")
    p_apply.set_defaults(func=cmd_apply)
