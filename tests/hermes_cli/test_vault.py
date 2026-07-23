"""Tests for the Obsidian vault module — path safety and safe writes."""

import importlib

import pytest


@pytest.fixture()
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    root.mkdir()
    monkeypatch.setenv("HERMES_VAULT_PATH", str(root))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    import hermes_cli.vault.config as config
    import hermes_cli.vault.paths as paths
    import hermes_cli.vault.notes as notes

    importlib.reload(config)
    importlib.reload(paths)
    importlib.reload(notes)
    return root, paths, notes


# --- path safety -----------------------------------------------------------

def test_valid_path_resolves(vault):
    root, paths, _ = vault
    p = paths.resolve_in_vault("notes/a.md")
    assert str(p).startswith(str(root.resolve()))


def test_dotdot_traversal_rejected(vault):
    _, paths, _ = vault
    with pytest.raises(paths.VaultPathError):
        paths.resolve_in_vault("../secret.md")
    with pytest.raises(paths.VaultPathError):
        paths.resolve_in_vault("notes/../../etc/passwd")


def test_absolute_outside_rejected(vault):
    _, paths, _ = vault
    with pytest.raises(paths.VaultPathError):
        paths.resolve_in_vault("/etc/passwd")


def test_symlink_escape_rejected(vault, tmp_path):
    root, paths, _ = vault
    outside = tmp_path / "outside.md"
    outside.write_text("secret")
    link = root / "link.md"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks unsupported")
    with pytest.raises(paths.VaultPathError):
        paths.resolve_in_vault("link.md")


# --- parsing ---------------------------------------------------------------

def test_parse_note_extracts_everything(vault):
    _, _, notes = vault
    text = (
        "---\ntitle: My Note\ntags: [alpha, beta]\n---\n"
        "# Heading One\n\nSome #inline-tag and a [[Other Note#Section|Alias]] link.\n"
        "![[Embed Note]]\n## Sub\n"
    )
    parsed = notes.parse_note("my.md", text)
    assert parsed["title"] == "My Note"
    assert "alpha" in parsed["tags"] and "inline-tag" in parsed["tags"]
    assert parsed["links"][0]["target"] == "Other Note"
    assert parsed["links"][0]["heading"] == "Section"
    assert parsed["links"][0]["alias"] == "Alias"
    assert parsed["embeds"][0]["target"] == "Embed Note"
    assert [h["level"] for h in parsed["headings"]] == [1, 2]


# --- safe writes -----------------------------------------------------------

def test_create_then_read(vault):
    root, _, notes = vault
    notes.create_note("daily/2026-07-24.md", "# Today\n")
    assert (root / "daily/2026-07-24.md").read_text() == "# Today\n"
    parsed = notes.read_note("daily/2026-07-24.md")
    assert parsed["title"] == "Today"


def test_create_never_overwrites(vault):
    _, _, notes = vault
    notes.create_note("a.md", "one")
    with pytest.raises(notes.VaultExists):
        notes.create_note("a.md", "two")


def test_write_backs_up_and_is_atomic(vault, tmp_path):
    root, _, notes = vault
    notes.create_note("a.md", "v1")
    notes.write_note("a.md", "v2")
    assert (root / "a.md").read_text() == "v2"
    # A backup of the previous content exists outside the vault.
    backups = list((tmp_path / "home" / "vault-backups").glob("a.*.bak"))
    assert backups and backups[0].read_text() == "v1"
    # No temp files left behind in the vault.
    assert not list(root.glob("*.imptmp*"))


def test_write_conflict_when_disk_is_newer(vault):
    root, _, notes = vault
    notes.create_note("a.md", "v1")
    old_mtime = (root / "a.md").stat().st_mtime
    # Simulate an external (Obsidian) edit making the file newer.
    import os
    os.utime(root / "a.md", (old_mtime + 10, old_mtime + 10))
    with pytest.raises(notes.VaultConflict):
        notes.write_note("a.md", "v3", expected_mtime=old_mtime)


def test_append_creates_and_appends(vault):
    root, _, notes = vault
    notes.append_to_note("log.md", "line 1")
    notes.append_to_note("log.md", "line 2")
    assert (root / "log.md").read_text() == "line 1\nline 2"


def test_list_notes_skips_obsidian_internals(vault):
    root, _, notes = vault
    (root / ".obsidian").mkdir()
    (root / ".obsidian" / "app.json").write_text("{}")
    notes.create_note("real.md", "x")
    listed = [n["path"] for n in notes.list_notes()]
    assert "real.md" in listed
    assert not any(".obsidian" in p for p in listed)
