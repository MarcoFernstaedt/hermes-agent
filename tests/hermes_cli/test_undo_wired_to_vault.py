"""Undo, wired to a real action — through the production call graph.

The journal had tests and no production caller, which is not undo: the controls
could not honestly be shown, because nothing recorded anything to undo. These
tests never touch `UndoJournal.record` directly. They call the same
`hermes_cli.vault.notes` functions the tool handlers and the HTTP routes call,
then undo through `hermes_cli.undo.actions`, and check the file on disk.

A vault note is the first journal-backed action on purpose: internal, genuinely
reversible, smallest blast radius, and the backup that becomes the inverse
already exists on disk *before* the mutation.
"""
from __future__ import annotations

import pytest


@pytest.fixture
def vault(tmp_path, monkeypatch):
    """A real vault and a real hermes home, wired the way the app wires them."""
    home = tmp_path / "home"
    (home / "state").mkdir(parents=True)
    root = tmp_path / "vault"
    root.mkdir()

    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr("hermes_cli.config.get_hermes_home", lambda: home)
    monkeypatch.setattr("hermes_cli.secure_store.get_hermes_home", lambda: home)
    # The real seam the app reads, rather than an internal: a test that patches
    # a private resolver proves the code agrees with itself.
    monkeypatch.setenv("HERMES_VAULT_PATH", str(root))

    from hermes_cli.undo import actions

    actions.reset_journal_for_tests()
    yield root
    actions.reset_journal_for_tests()


def write(rel: str, content: str):
    from hermes_cli.vault import notes

    return notes.write_note(rel, content)


class TestAnOrdinaryWriteBecomesUndoable:
    def test_writing_a_note_records_an_entry(self, vault):
        from hermes_cli.undo import actions

        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")

        stack = actions.journal().stack()
        assert len(stack) == 1
        assert stack[0]["action_id"] == "vault.write"
        assert stack[0]["target"] == "note.md"

    def test_undo_puts_the_previous_content_back(self, vault):
        from hermes_cli.undo import actions

        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        assert (vault / "note.md").read_text(encoding="utf-8") == "changed"

        entry = actions.undo_last(root=vault)
        assert entry is not None
        assert entry["status"] == "undone"
        assert (vault / "note.md").read_text(encoding="utf-8") == "original"

    def test_the_reversal_is_verified_not_assumed(self, vault):
        # The write is outside the journal's transaction, so a clean return
        # from `apply` is not evidence. `outcome` records that it was checked.
        from hermes_cli.undo import actions

        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        assert actions.undo_last(root=vault)["outcome"] == "verified"

    def test_an_appended_note_is_undoable_too(self, vault):
        from hermes_cli.undo import actions
        from hermes_cli.vault import notes

        (vault / "log.md").write_text("line one\n", encoding="utf-8")
        notes.append_to_note("log.md", "line two")
        assert "line two" in (vault / "log.md").read_text(encoding="utf-8")

        actions.undo_last(root=vault)
        assert (vault / "log.md").read_text(encoding="utf-8") == "line one\n"

    def test_undoing_leaves_the_stack_empty(self, vault):
        from hermes_cli.undo import actions

        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        actions.undo_last(root=vault)
        assert actions.journal().stack() == []


class TestCreatingAndUndoingACreate:
    def test_a_create_is_reversed_by_removing_the_note(self, vault):
        # Reversing a create by writing an empty note would leave behind a note
        # the owner never made and cannot tell from one they did.
        from hermes_cli.undo import actions

        write("brand-new.md", "hello")
        assert (vault / "brand-new.md").exists()

        actions.undo_last(root=vault)
        assert not (vault / "brand-new.md").exists()

    def test_the_entry_knows_the_note_did_not_exist(self, vault):
        from hermes_cli.undo import actions

        write("brand-new.md", "hello")
        entry = actions.journal().stack()[0]
        assert entry["inverse_payload"]["existed"] is False


class TestTheUndoIsHonestWhenItCannotBeKept:
    def test_a_missing_backup_fails_rather_than_writing_something_else(self, vault):
        from hermes_cli.undo import actions

        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry = actions.journal().stack()[0]

        # The backup is pruned, or the disk was cleaned.
        from pathlib import Path

        Path(entry["inverse_payload"]["backup"]).unlink()

        with pytest.raises(FileNotFoundError):
            actions.undo_entry(entry["id"], root=vault)
        # And the note is untouched: a failed undo must not invent content.
        assert (vault / "note.md").read_text(encoding="utf-8") == "changed"

    def test_a_failed_undo_is_recorded_as_unknown_and_blocks(self, vault):
        # Per the fencing rule: `apply` runs outside the journal transaction,
        # so a raise is not proof nothing happened.
        from pathlib import Path

        from hermes_cli.undo import actions

        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry = actions.journal().stack()[0]
        Path(entry["inverse_payload"]["backup"]).unlink()

        with pytest.raises(FileNotFoundError):
            actions.undo_entry(entry["id"], root=vault)

        got = actions.journal().get(entry["id"])
        assert got["status"] == "reversal_unknown"
        assert got.needs_repair is True
        assert actions.journal().stack() == []

    def test_undoing_twice_is_refused(self, vault):
        from hermes_cli.undo.journal import UndoNotPossible
        from hermes_cli.undo import actions

        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry_id = actions.journal().stack()[0]["id"]

        actions.undo_entry(entry_id, root=vault)
        with pytest.raises(UndoNotPossible, match="already"):
            actions.undo_entry(entry_id, root=vault)


class TestJournalingNeverCostsTheOwnerASave:
    def test_a_broken_journal_does_not_block_the_write(self, vault, monkeypatch):
        """A journal that cannot record must not refuse the save.

        The failure mode is a lost undo, which shows up as a missing entry in
        the stack. The alternative is a refused write, which is worse and is
        not the journal's decision to make.
        """
        from hermes_cli.undo import actions

        def boom(**kwargs):
            raise RuntimeError("journal unavailable")

        monkeypatch.setattr(actions, "record_vault_write", boom)

        write("note.md", "content survives")
        assert (vault / "note.md").read_text(encoding="utf-8") == "content survives"

    def test_the_lost_undo_is_visible_as_an_absent_entry(self, vault, monkeypatch):
        from hermes_cli.undo import actions

        monkeypatch.setattr(
            actions, "record_vault_write",
            lambda **kw: (_ for _ in ()).throw(RuntimeError("nope")),
        )
        write("note.md", "content")
        assert actions.journal().stack() == []


class TestUndoLast:
    def test_it_reverses_the_most_recent_write(self, vault):
        from hermes_cli.undo import actions

        (vault / "a.md").write_text("a1", encoding="utf-8")
        (vault / "b.md").write_text("b1", encoding="utf-8")
        write("a.md", "a2")
        write("b.md", "b2")

        actions.undo_last(root=vault)
        assert (vault / "b.md").read_text(encoding="utf-8") == "b1"
        # The earlier one is untouched and still offerable.
        assert (vault / "a.md").read_text(encoding="utf-8") == "a2"
        assert len(actions.journal().stack()) == 1

    def test_it_returns_none_when_there_is_nothing_to_undo(self, vault):
        from hermes_cli.undo import actions

        assert actions.undo_last(root=vault) is None

    def test_it_walks_back_through_successive_writes(self, vault):
        from hermes_cli.undo import actions

        (vault / "note.md").write_text("v1", encoding="utf-8")
        write("note.md", "v2")
        write("note.md", "v3")

        actions.undo_last(root=vault)
        assert (vault / "note.md").read_text(encoding="utf-8") == "v2"
        actions.undo_last(root=vault)
        assert (vault / "note.md").read_text(encoding="utf-8") == "v1"


class TestTheProductionCallGraph:
    def test_the_tool_handler_path_journals_too(self, vault):
        """Not just the low-level function — the surface the agent calls.

        Journaling at `write_note` rather than in each handler is what makes
        this true for every caller, which is the property worth having.
        """
        import json

        from hermes_cli.undo import actions
        from tools import vault_tools

        result = json.loads(vault_tools._handle_create({"path": "agent-made.md", "content": "hi"}))
        assert "error" not in result

        stack = actions.journal().stack()
        assert len(stack) == 1
        assert stack[0]["target"] == "agent-made.md"

        actions.undo_last(root=vault)
        assert not (vault / "agent-made.md").exists()
