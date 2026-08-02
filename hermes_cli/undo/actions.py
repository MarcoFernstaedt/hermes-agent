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
from hermes_cli.undo.journal import JournalEntry, UndoJournal, UndoNotPossible

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


class VaultUndoConflict(UndoNotPossible):
    """The note is not what this undo was recorded against.

    A separate exception rather than a generic failure because it means
    something specific and recoverable: nothing has been written, the note on
    disk is newer than the change being reversed, and a person has to decide
    which version they want. ``report`` carries the detail a screen needs to
    say that in words.
    """

    def __init__(self, message: str, report: dict):
        super().__init__(message)
        self.report = report


def record_vault_write(
    *,
    rel: str,
    backup_path: Optional[str],
    existed: bool,
    action_id: str = ACTION_WRITE,
    actor: str = "agent",
    session_id: str = "",
    preimage_sha256: Optional[str] = None,
    postimage_sha256: Optional[str] = None,
) -> Optional[JournalEntry]:
    """Record how to take a note write back. Call *before* the write lands.

    ``backup_path`` is the copy the vault module made; ``existed`` says whether
    there was a note there at all. A create has no backup and its inverse is a
    delete, which is a different reversal, not a missing one.

    The two hashes are the contract the reversal is checked against:

    ``preimage_sha256`` — what the note contained before this write. The backup
    on disk is supposed to be exactly that, and checking says so rather than
    trusting a path. Backups are pruned, and a path that still resolves is not
    proof it resolves to the same bytes.

    ``postimage_sha256`` — what this write is about to put there. At undo time
    the note is re-read and hashed; if it does not match, something changed the
    note after this write, and restoring the backup would silently destroy that
    change. The vault is Obsidian's, and the most likely something is the owner
    typing in it. So the undo refuses and says why.

    Returns the entry, or None if journaling failed — a journal that cannot
    record must never stop the write it was only observing. The cost is a lost
    undo, which is visible; the alternative is a failed save, which is worse
    and is not this function's decision to make.
    """
    try:
        payload: dict[str, Any] = {"rel": rel, "existed": existed}
        if backup_path:
            payload["backup"] = str(backup_path)
        if preimage_sha256:
            payload["preimage_sha256"] = preimage_sha256
        if postimage_sha256:
            payload["postimage_sha256"] = postimage_sha256
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


def conflict_report(entry: JournalEntry, *, root: Path | None = None) -> Optional[dict]:
    """Why this note cannot be safely reverted, or None when it can.

    Returns the structured detail a screen needs to explain the refusal, rather
    than only an exception message: which note, what the undo expected to find
    there, what is actually there, and whether the backup is still the version
    it was recorded as.

    ``kind`` is one of:

    ``changed_since`` — the note is not what this write left behind. Something
    edited it afterwards, and the most likely something is the owner in
    Obsidian. Restoring would destroy that edit.

    ``backup_missing`` / ``backup_changed`` — the prior version is gone or is
    no longer the bytes it was recorded as, so there is nothing trustworthy to
    restore. Backups are pruned; a path that resolves is not proof it resolves
    to the same content.

    None of these is a failure of the undo machinery, which is why they are
    detected before anything is written and reported rather than raised from
    the middle of a reversal.
    """
    from hermes_cli.vault.notes import content_digest
    from hermes_cli.vault.paths import resolve_in_vault

    payload = entry.get("inverse_payload") or {}
    rel = payload.get("rel")
    if not rel:
        return None
    path = resolve_in_vault(rel, root=root)
    expected_post = payload.get("postimage_sha256")

    # Entries recorded before the hash contract carry neither hash. They are
    # still reversible on the old terms; there is nothing to compare, and
    # refusing them would break undo for everything already in the journal.
    if expected_post:
        actual = content_digest(path.read_text(encoding="utf-8")) if path.exists() else None
        if actual != expected_post:
            return {
                "kind": "changed_since",
                "rel": rel,
                "expected_sha256": expected_post,
                "actual_sha256": actual,
                "note_exists": path.exists(),
                "message": (
                    f"{rel} has changed since this was written. Undoing would "
                    "overwrite that change."
                    if path.exists()
                    else f"{rel} is no longer there."
                ),
            }

    if not payload.get("existed"):
        return None  # A create. Its reversal is a delete; no backup involved.

    backup = payload.get("backup")
    if not backup or not Path(backup).exists():
        return {
            "kind": "backup_missing",
            "rel": rel,
            "backup": backup,
            "message": (
                f"the saved previous version of {rel} is no longer on disk, so "
                "it cannot be restored"
            ),
        }
    expected_pre = payload.get("preimage_sha256")
    if expected_pre:
        got = content_digest(Path(backup).read_text(encoding="utf-8"))
        if got != expected_pre:
            return {
                "kind": "backup_changed",
                "rel": rel,
                "backup": backup,
                "expected_sha256": expected_pre,
                "actual_sha256": got,
                "message": (
                    f"the saved previous version of {rel} is not the one this "
                    "undo was recorded against"
                ),
            }
    return None


def apply_vault_inverse(entry: JournalEntry, *, root: Path | None = None) -> None:
    """Put the note back. The `apply` callable for a vault entry.

    Two shapes, because a create and an overwrite reverse differently: an
    overwrite restores the backup, and a create removes the file it made.
    Reversing a create by writing an empty note would leave a note behind that
    the owner never made and cannot tell from one they did.

    The conflict check runs here as well as in `undo_entry`, and the
    duplication is deliberate. `undo_entry` checks first so the refusal happens
    before the journal claims anything and the entry stays offerable. This
    second check closes the window between that check and this write — narrow,
    but the whole point of the contract is that the note is not overwritten on
    an assumption, and a check that can be raced is an assumption.
    """
    from hermes_cli.vault.paths import resolve_in_vault

    payload = entry.get("inverse_payload") or {}
    rel = payload.get("rel")
    if not rel:
        raise ValueError("this entry does not say which note it changed")
    path = resolve_in_vault(rel, root=root)

    report = conflict_report(entry, root=root)
    if report is not None and report["kind"] != "backup_missing":
        raise VaultUndoConflict(report["message"], report)

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

    if not path.exists():
        return False
    now = _digest(path.read_text(encoding="utf-8"))

    # Prefer the recorded preimage hash over re-reading the backup. The hash is
    # what the note *was*; the backup is only where a copy of it was put, and a
    # backup that has been replaced or pruned since would make a wrong restore
    # verify as correct by comparing it against itself.
    expected = payload.get("preimage_sha256")
    if expected:
        return now == expected

    backup = payload.get("backup")
    if not backup or not Path(backup).exists():
        return False
    return now == _digest(Path(backup).read_text(encoding="utf-8"))


def undo_entry(
    entry_id: str, *, root: Path | None = None, force: bool = False
) -> JournalEntry:
    """The production entry point. Reverses a recorded action and verifies it.

    The conflict check runs before the journal claims anything, so a refusal
    leaves the entry exactly as it was — still `done`, still offerable, still
    undoable once the person has looked at it. A conflict is not a broken undo;
    it is the undo working, and it must not consume the thing it declined to do.

    ``force`` is the answer to "I have looked, and I do want the older
    version". It is not a way to skip the check — the check has already run and
    produced a report the caller was shown — it is the caller carrying that
    decision back. It cannot conjure a backup that is gone: a `backup_missing`
    conflict still fails, because there is nothing to restore.

    Verification is supplied even though this is an `inverse`: the journal only
    *requires* it for a compensation, but a file write it cannot see is not
    meaningfully more knowable than a provider call, and claiming success from
    a clean return would be the same lie in a smaller place.
    """
    entry = journal().get(entry_id)
    # Offerability first, state of the file second. An entry that has already
    # been undone leaves the note holding its *pre*-image, which is exactly
    # what "changed since the write" looks like — so checking the hash first
    # answered "you have already done this" with "someone edited the note",
    # which is both wrong and alarming.
    if not force and entry["status"] == "done":
        report = conflict_report(entry, root=root)
        if report is not None and report["kind"] != "backup_missing":
            raise VaultUndoConflict(report["message"], report)

    apply_fn = _forced_vault_inverse if force else apply_vault_inverse
    return journal().undo(
        entry_id,
        apply=lambda e: apply_fn(e, root=root),
        verify=lambda e: verify_vault_inverse(e, root=root),
    )


def _forced_vault_inverse(entry: JournalEntry, *, root: Path | None = None) -> None:
    """`apply_vault_inverse` with the conflict check answered rather than run.

    Split out instead of a flag threaded through so that the ordinary path has
    no branch that could be taken by accident: the only way to overwrite a note
    that has changed is to call a differently-named function.
    """
    from hermes_cli.vault.paths import resolve_in_vault

    payload = entry.get("inverse_payload") or {}
    rel = payload.get("rel")
    if not rel:
        raise ValueError("this entry does not say which note it changed")
    path = resolve_in_vault(rel, root=root)

    if not payload.get("existed"):
        if path.exists():
            path.unlink()
        return

    backup = payload.get("backup")
    if not backup or not Path(backup).exists():
        raise FileNotFoundError(
            "the backup this undo needs is no longer on disk; the note cannot "
            "be restored"
        )
    # The note about to be overwritten is itself backed up first. Forcing is a
    # decision the owner is allowed to change their mind about.
    if path.exists():
        try:
            from hermes_cli.vault.notes import _backup

            _backup(path)
        except Exception:
            pass
    content = Path(backup).read_text(encoding="utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".undotmp.{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def undo_last(
    *,
    actor: str = "agent",
    session_id: str = "",
    root: Path | None = None,
    force: bool = False,
) -> Optional[JournalEntry]:
    """What "undo the last thing you did" actually does. None when nothing is
    offerable.

    Raises `VaultUndoConflict` when the note has moved on since — the caller
    shows the report and asks, rather than this deciding on the owner's behalf.
    """
    entry = journal().last_undoable(actor=actor, session_id=session_id)
    if entry is None:
        return None
    return undo_entry(entry["id"], root=root, force=force)
