"""The journal, wired to a real mutating action.

`UndoJournal` had no production caller. It was a library with tests, which is
not undo — the controls could not honestly be shown, because nothing recorded
anything to undo. This connects it to the first real action, and the choice of
which action to go first is deliberate:

**A vault note write.** Internal, genuinely reversible, and the smallest blast
radius available. `hermes_cli.vault.notes` already copies the file to
`~/.hermes/vault-backups/` before every overwrite, so the inverse exists on
disk before the mutation happens — there is no window where we have promised an
undo we cannot perform. Nothing external, nothing irreversible, no provider to
half-fail.

The vault stays Obsidian's. What is recorded here is a pointer to a backup the
vault module was already making, plus the state needed to reverse — never note
content, and never a second copy of the vault.

Two properties the journal's own design demands of a caller, and which this
provides:

*The inverse is captured before the mutation.* Recording after would leave a
crash-shaped hole where the file changed and nothing knows how to change it
back.

*The reversal is verified.* Writing a file is outside the journal's
transaction, so `undo` cannot know from a clean return that the bytes landed.
The verifier re-reads the path and compares a hash. That is the same rule the
compensation path enforces, applied where it is equally true.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any, Optional

from hermes_cli.actions.registry import Rollback
from hermes_cli.undo.journal import JournalEntry, UndoJournal

#: The action ids these entries carry. Namespaced like every other action id.
ACTION_WRITE = "vault.write"
ACTION_APPEND = "vault.append"

_journal: Optional[UndoJournal] = None


def journal() -> UndoJournal:
    """The process-wide journal. One file, under the app's own state."""
    global _journal
    if _journal is None:
        from hermes_cli.config import get_hermes_home

        _journal = UndoJournal(Path(get_hermes_home()) / "state" / "undo.sqlite3")
    return _journal


def reset_journal_for_tests() -> None:
    global _journal
    _journal = None


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def record_vault_write(
    *,
    rel: str,
    backup_path: Optional[str],
    existed: bool,
    action_id: str = ACTION_WRITE,
    actor: str = "agent",
    session_id: str = "",
) -> Optional[JournalEntry]:
    """Record how to take a note write back. Call *before* the write lands.

    ``backup_path`` is the copy the vault module made; ``existed`` says whether
    there was a note there at all. A create has no backup and its inverse is a
    delete, which is a different reversal, not a missing one.

    Returns the entry, or None if journaling failed — a journal that cannot
    record must never stop the write it was only observing. The cost is a lost
    undo, which is visible; the alternative is a failed save, which is worse
    and is not this function's decision to make.
    """
    try:
        payload: dict[str, Any] = {"rel": rel, "existed": existed}
        if backup_path:
            payload["backup"] = str(backup_path)
        return journal().record(
            action_id=action_id,
            rollback=Rollback.INVERSE.value,
            rollback_detail="vault.restore",
            actor=actor,
            session_id=session_id,
            target=rel,
            inverse_payload=payload,
        )
    except Exception:
        return None


def apply_vault_inverse(entry: JournalEntry, *, root: Path | None = None) -> None:
    """Put the note back. The `apply` callable for a vault entry.

    Two shapes, because a create and an overwrite reverse differently: an
    overwrite restores the backup, and a create removes the file it made.
    Reversing a create by writing an empty note would leave a note behind that
    the owner never made and cannot tell from one they did.
    """
    from hermes_cli.vault.paths import resolve_in_vault

    payload = entry.get("inverse_payload") or {}
    rel = payload.get("rel")
    if not rel:
        raise ValueError("this entry does not say which note it changed")
    path = resolve_in_vault(rel, root=root)

    if not payload.get("existed"):
        # It was a create. Removing it is the reversal.
        if path.exists():
            path.unlink()
        return

    backup = payload.get("backup")
    if not backup or not Path(backup).exists():
        # The prior version is gone, so the promise cannot be kept. Saying so
        # is the whole point of `rollback_detail` being mandatory.
        raise FileNotFoundError(
            "the backup this undo needs is no longer on disk; the note cannot "
            "be restored"
        )
    content = Path(backup).read_text(encoding="utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".undotmp.{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def verify_vault_inverse(entry: JournalEntry, *, root: Path | None = None) -> bool:
    """Did the reversal actually land? Re-reads the source of truth.

    A file write is outside the journal's transaction, so a clean return from
    `apply` is not evidence. This compares what is on disk now against what
    should be there.
    """
    from hermes_cli.vault.paths import resolve_in_vault

    payload = entry.get("inverse_payload") or {}
    rel = payload.get("rel")
    if not rel:
        return False
    path = resolve_in_vault(rel, root=root)

    if not payload.get("existed"):
        return not path.exists()

    backup = payload.get("backup")
    if not backup or not Path(backup).exists() or not path.exists():
        return False
    return _digest(path.read_text(encoding="utf-8")) == _digest(
        Path(backup).read_text(encoding="utf-8")
    )


def undo_entry(entry_id: str, *, root: Path | None = None) -> JournalEntry:
    """The production entry point. Reverses a recorded action and verifies it.

    Verification is supplied even though this is an `inverse`: the journal only
    *requires* it for a compensation, but a file write it cannot see is not
    meaningfully more knowable than a provider call, and claiming success from
    a clean return would be the same lie in a smaller place.
    """
    return journal().undo(
        entry_id,
        apply=lambda e: apply_vault_inverse(e, root=root),
        verify=lambda e: verify_vault_inverse(e, root=root),
    )


def undo_last(
    *, actor: str = "agent", session_id: str = "", root: Path | None = None
) -> Optional[JournalEntry]:
    """What "undo the last thing you did" actually does. None when nothing is
    offerable."""
    entry = journal().last_undoable(actor=actor, session_id=session_id)
    if entry is None:
        return None
    return undo_entry(entry["id"], root=root)
