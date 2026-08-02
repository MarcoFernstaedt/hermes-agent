"""Undo, reachable — from the RPC and from the shell.

The journal was correct and unreachable. `record` was wired into vault writes,
so entries accumulated; nothing in production ever read them back, so the undo
stack was a data structure and the states that exist so a person can act on
them — `compensation_failed`, `undo_failed`, `reversal_unknown` — could not be
seen by any person.

These are integration tests in the sense that matters: they write a note the
way the tool handlers write it, then drive the *production surfaces* — the
gateway's `undo.list`/`undo.preview`/`undo.apply` handlers and the `hermes
undo` command — and check the file on disk. Nothing here calls
`UndoJournal.record` or `undo_entry` directly, because a surface that agrees
with a helper it calls directly proves nothing about the surface.
"""
from __future__ import annotations

import json

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
    monkeypatch.setenv("HERMES_VAULT_PATH", str(root))

    from hermes_cli.undo import actions

    actions.reset_journal_for_tests()
    # The surface resolves the vault root from the environment in production;
    # the tests that need an explicit root pass it, and the RPC path relies on
    # HERMES_VAULT_PATH being what it reads.
    yield root
    actions.reset_journal_for_tests()


def write(rel: str, content: str):
    from hermes_cli.vault import notes

    return notes.write_note(rel, content)


def rpc(method: str, params: dict):
    """Call a gateway handler the way the dispatcher does, and unwrap it."""
    from tui_gateway import server

    handler = server._methods[method]
    envelope = handler(1, params)
    if "error" in envelope:
        raise AssertionError(f"{method} errored: {envelope['error']}")
    return envelope["result"]


def rpc_envelope(method: str, params: dict):
    from tui_gateway import server

    return server._methods[method](1, params)


class TestTheStackIsReadableThroughTheRpc:
    def test_a_written_note_appears_on_the_stack(self, vault):
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")

        payload = rpc("undo.list", {})
        assert payload["counts"]["stack"] == 1
        row = payload["stack"][0]
        assert row["target"] == "note.md"
        assert row["action"] == "vault.write"
        assert row["reversible"] is True

    def test_the_three_lists_are_separate(self, vault):
        """They are three different claims about the world.

        "This can be taken back", "this could not be and needs somebody", and
        "this is being taken back right now" are not the same statement, and
        collapsing them means reporting one of the last two as a state it is
        not in.
        """
        payload = rpc("undo.list", {})
        assert set(payload) >= {"stack", "repairs", "in_flight", "counts"}
        assert payload["counts"] == {"stack": 0, "repairs": 0, "in_flight": 0}

    def test_the_row_never_carries_the_backup_path_or_hashes(self, vault):
        # A screen has no use for an absolute path into the hermes home, and it
        # should not travel to a browser.
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        blob = json.dumps(rpc("undo.list", {}))
        assert "preimage_sha256" not in blob
        assert "backup" not in blob


class TestUndoingThroughTheRpc:
    def test_it_puts_the_previous_content_back(self, vault):
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")

        result = rpc("undo.apply", {})
        assert result["undone"] is True
        assert result["entry"]["status"] == "undone"
        assert (vault / "note.md").read_text(encoding="utf-8") == "original"

    def test_undoing_a_create_removes_the_note(self, vault):
        write("new.md", "hello")
        assert (vault / "new.md").exists()

        rpc("undo.apply", {})
        assert not (vault / "new.md").exists()

    def test_a_named_entry_can_be_undone_out_of_order(self, vault):
        (vault / "a.md").write_text("a0", encoding="utf-8")
        (vault / "b.md").write_text("b0", encoding="utf-8")
        write("a.md", "a1")
        write("b.md", "b1")

        stack = rpc("undo.list", {})["stack"]
        older = next(r for r in stack if r["target"] == "a.md")
        rpc("undo.apply", {"entry_id": older["id"]})

        assert (vault / "a.md").read_text(encoding="utf-8") == "a0"
        assert (vault / "b.md").read_text(encoding="utf-8") == "b1"

    def test_nothing_to_undo_is_not_an_error(self, vault):
        result = rpc("undo.apply", {})
        assert result == {"undone": False, "reason": "nothing to undo"}


class TestAConflictIsReportedRatherThanDecided:
    def test_a_note_edited_since_refuses_and_says_why(self, vault):
        """The vault is Obsidian's, and the most likely editor is the owner."""
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "agent wrote this")
        (vault / "note.md").write_text("owner typed this", encoding="utf-8")

        result = rpc("undo.apply", {})
        assert result["undone"] is False
        assert result["refused"] is True
        assert result["conflict"]["kind"] == "changed_since"
        assert result["can_force"] is True
        # Untouched: a conflict is the undo working, not the undo breaking.
        assert (vault / "note.md").read_text(encoding="utf-8") == "owner typed this"

    def test_the_refusal_does_not_consume_the_entry(self, vault):
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "agent wrote this")
        (vault / "note.md").write_text("owner typed this", encoding="utf-8")

        rpc("undo.apply", {})
        assert rpc("undo.list", {})["counts"]["stack"] == 1

    def test_forcing_carries_the_owners_answer_back(self, vault):
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "agent wrote this")
        (vault / "note.md").write_text("owner typed this", encoding="utf-8")

        assert rpc("undo.apply", {})["refused"] is True
        result = rpc("undo.apply", {"force": True})
        assert result["undone"] is True
        assert (vault / "note.md").read_text(encoding="utf-8") == "original"

    def test_forcing_cannot_conjure_a_backup_that_is_gone(self, vault):
        from hermes_cli.undo import actions

        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry = actions.journal().stack()[0]
        backup = entry["inverse_payload"].get("backup")
        assert backup
        __import__("pathlib").Path(backup).unlink()

        result = rpc("undo.apply", {"entry_id": entry["id"], "force": True})
        assert result["undone"] is False
        # It ran and could not complete, so the entry needs a person rather
        # than another attempt.
        assert result["needs_repair"] is True

    def test_a_preview_reports_the_conflict_without_changing_anything(self, vault):
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "agent wrote this")
        (vault / "note.md").write_text("owner typed this", encoding="utf-8")

        entry_id = rpc("undo.list", {})["stack"][0]["id"]
        preview = rpc("undo.preview", {"entry_id": entry_id})
        assert preview["can_undo"] is False
        assert preview["can_force"] is True
        assert preview["conflict"]["kind"] == "changed_since"
        assert (vault / "note.md").read_text(encoding="utf-8") == "owner typed this"

    def test_a_clean_preview_says_it_is_ready(self, vault):
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry_id = rpc("undo.list", {})["stack"][0]["id"]
        preview = rpc("undo.preview", {"entry_id": entry_id})
        assert preview["conflict"] is None
        assert preview["can_undo"] is True

    def test_a_preview_that_cannot_look_does_not_report_all_clear(
        self, vault, monkeypatch
    ):
        # The whole point of a preview is to be the thing that looked.
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry_id = rpc("undo.list", {})["stack"][0]["id"]

        def boom(entry, **kw):
            raise RuntimeError("vault unreadable")

        monkeypatch.setattr("hermes_cli.undo.actions.conflict_report", boom)
        preview = rpc("undo.preview", {"entry_id": entry_id})
        assert preview["can_undo"] is False
        assert preview["conflict"]["kind"] == "unreadable"

    def test_a_missing_entry_id_is_a_parameter_error(self, vault):
        envelope = rpc_envelope("undo.preview", {"entry_id": "  "})
        assert "error" in envelope


class TestTheRepairListIsReachable:
    def test_a_failed_reversal_shows_up_and_never_ages_out(self, vault, monkeypatch):
        """The states that exist so a person can act on them.

        Before this surface there was no production caller of
        `needing_repair()`, so an entry in `undo_failed` sat in the database
        being seen by nobody.
        """
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry_id = rpc("undo.list", {})["stack"][0]["id"]

        def boom(entry, **kw):
            raise OSError("disk went away mid-restore")

        monkeypatch.setattr("hermes_cli.undo.actions.apply_vault_inverse", boom)
        result = rpc("undo.apply", {"entry_id": entry_id})
        assert result["undone"] is False
        assert result["failed"] is True

        payload = rpc("undo.list", {})
        assert payload["counts"]["repairs"] == 1
        row = payload["repairs"][0]
        assert row["needs_repair"] is True
        assert row["status"] in ("undo_failed", "reversal_unknown", "compensation_failed")

    def test_the_repair_list_is_not_scoped_to_a_session(self, vault, monkeypatch):
        # An unreversed action still matters in whatever session the owner
        # happens to be looking at.
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry_id = rpc("undo.list", {})["stack"][0]["id"]
        monkeypatch.setattr(
            "hermes_cli.undo.actions.apply_vault_inverse",
            lambda e, **kw: (_ for _ in ()).throw(OSError("gone")),
        )
        rpc("undo.apply", {"entry_id": entry_id})

        payload = rpc("undo.list", {"session_id": "some-other-session"})
        assert payload["counts"]["stack"] == 0
        assert payload["counts"]["repairs"] == 1

    def test_an_abandoned_reversal_is_reconciled_into_view(self, vault):
        """A process killed mid-reversal leaves an entry nothing else reaches.

        `needing_repair()` reconciles first, which is the only route such an
        entry has to a screen.
        """
        from hermes_cli.undo import actions

        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry_id = actions.journal().stack()[0]["id"]

        # Claim it and then vanish, the way a killed worker does.
        import time

        j = actions.journal()
        with j._lock, j._connect() as conn:
            conn.execute(
                "UPDATE undo_journal SET status = 'undoing', claimed_at = ?, "
                "reversal_owner = 'ghost' WHERE id = ?",
                (time.time() - 3600, entry_id),
            )

        payload = rpc("undo.list", {})
        assert payload["counts"]["repairs"] == 1
        assert payload["repairs"][0]["status"] == "reversal_unknown"


class TestTheCommandLineSurface:
    def run(self, capsys, *argv):
        from hermes_cli.undo import cli

        parser = __import__("argparse").ArgumentParser()
        cli.register_cli(parser)
        args = parser.parse_args(list(argv))
        code = args.func(args)
        return code, capsys.readouterr().out

    def test_a_bare_invocation_lists_the_stack(self, vault, capsys):
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        code, out = self.run(capsys)
        assert code == 0
        assert "note.md" in out

    def test_nothing_to_undo_is_said_plainly(self, vault, capsys):
        code, out = self.run(capsys)
        assert code == 0
        assert "Nothing to undo." in out

    def test_apply_reverses_the_note(self, vault, capsys):
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        code, out = self.run(capsys, "apply")
        assert code == 0
        assert (vault / "note.md").read_text(encoding="utf-8") == "original"

    def test_a_conflict_exits_two_and_prints_the_reason(self, vault, capsys):
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "agent wrote this")
        (vault / "note.md").write_text("owner typed this", encoding="utf-8")

        code, out = self.run(capsys, "apply")
        assert code == 2
        assert "Refused" in out
        assert "--force" in out
        assert (vault / "note.md").read_text(encoding="utf-8") == "owner typed this"

    def test_force_is_a_separate_invocation(self, vault, capsys):
        # Not a flag on the first call: that would let a script answer a
        # question it never asked.
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "agent wrote this")
        (vault / "note.md").write_text("owner typed this", encoding="utf-8")

        assert self.run(capsys, "apply")[0] == 2
        code, _ = self.run(capsys, "apply", "--force")
        assert code == 0
        assert (vault / "note.md").read_text(encoding="utf-8") == "original"

    def test_repairs_exits_non_zero_when_there_is_something_to_see(
        self, vault, capsys, monkeypatch
    ):
        assert self.run(capsys, "repairs") == (0, "Nothing needs attention.\n")

        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        monkeypatch.setattr(
            "hermes_cli.undo.actions.apply_vault_inverse",
            lambda e, **kw: (_ for _ in ()).throw(OSError("gone")),
        )
        assert self.run(capsys, "apply")[0] == 3

        code, out = self.run(capsys, "repairs")
        assert code == 1
        assert "Needs attention" in out

    def test_the_listing_leads_with_what_needs_attention(
        self, vault, capsys, monkeypatch
    ):
        """Burying it under a list of successful undos is how it goes unseen."""
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        write("other.md", "hello")
        monkeypatch.setattr(
            "hermes_cli.undo.actions.apply_vault_inverse",
            lambda e, **kw: (_ for _ in ()).throw(OSError("gone")),
        )
        entry_id = rpc("undo.list", {})["stack"][-1]["id"]
        rpc("undo.apply", {"entry_id": entry_id})

        _code, out = self.run(capsys)
        assert out.index("Needs attention") < out.index("Undo stack")

    def test_show_describes_one_entry(self, vault, capsys):
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry_id = rpc("undo.list", {})["stack"][0]["id"]
        code, out = self.run(capsys, "show", entry_id)
        assert code == 0
        assert "note.md" in out
        assert "Ready to undo." in out

    def test_json_output_is_parseable(self, vault, capsys):
        (vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        _code, out = self.run(capsys, "list", "--json")
        assert json.loads(out)["counts"]["stack"] == 1


class TestTheCommandIsRegistered:
    def test_undo_is_a_known_subcommand(self):
        # Missing from `_BUILTIN_SUBCOMMANDS` costs a plugin-discovery import
        # on every `hermes undo`; the entry is part of the wiring.
        from hermes_cli.main import _BUILTIN_SUBCOMMANDS

        assert "undo" in _BUILTIN_SUBCOMMANDS
