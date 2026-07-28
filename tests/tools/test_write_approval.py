"""Tests for the memory/skill write-approval gate (tools/write_approval.py)
and the shared slash-command handlers (hermes_cli/write_approval_commands.py).

Covers the boolean write_approval gate (off by default = write freely; on =
require approval) for both subsystems, the foreground-vs-background staging
split, pending store CRUD, and the list/approve/reject/diff/approval
subcommand dispatch.
"""

import json
import os
import tempfile
import shutil
import threading
from types import SimpleNamespace

import pytest


@pytest.fixture
def hermes_home(monkeypatch):
    d = tempfile.mkdtemp(prefix="hermes_wa_test_")
    home = os.path.join(d, ".hermes")
    os.makedirs(home)
    monkeypatch.setenv("HERMES_HOME", home)
    yield home
    shutil.rmtree(d, ignore_errors=True)


def _set_approval(subsystem, enabled):
    import hermes_cli.config as cfg
    c = cfg.load_config()
    c.setdefault(subsystem, {})["write_approval"] = enabled
    cfg.save_config(c)


def test_atomic_json_cleanup_failure_after_publication_is_non_authoritative(
    monkeypatch,
):
    from pathlib import Path
    from tools import write_approval as wa

    destination = wa.get_hermes_home() / "pending" / "unit" / "state.json"
    original_unlink = Path.unlink

    def fail_missing_temp_cleanup(path, *args, **kwargs):
        if path.name.startswith(".state.json.") and path.name.endswith(".tmp"):
            raise OSError("simulated post-publication cleanup failure")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_missing_temp_cleanup)
    wa._atomic_json_write(destination, {"state": "applying"})

    assert json.loads(destination.read_text(encoding="utf-8")) == {
        "state": "applying"
    }


# ---------------------------------------------------------------------------
# Config resolution
# ---------------------------------------------------------------------------

def test_default_gate_is_off(hermes_home):
    from tools import write_approval as wa
    # Default: gate off → writes flow freely.
    assert wa.write_approval_enabled("memory") is False
    assert wa.write_approval_enabled("skills") is False


def test_invalid_subsystem_is_off(hermes_home):
    from tools import write_approval as wa
    assert wa.write_approval_enabled("bogus") is False


def test_normalize_enabled_coerces_values():
    from tools import write_approval as wa
    # Real bools pass through.
    assert wa._normalize_enabled(True) is True
    assert wa._normalize_enabled(False) is False
    # Truthy strings → True (incl. legacy 'approve').
    assert wa._normalize_enabled("on") is True
    assert wa._normalize_enabled("approve") is True
    assert wa._normalize_enabled("true") is True
    # Everything else → False (gate off is the safe default).
    assert wa._normalize_enabled("off") is False
    assert wa._normalize_enabled("garbage") is False
    assert wa._normalize_enabled(None) is False


# ---------------------------------------------------------------------------
# Memory gate
# ---------------------------------------------------------------------------

def test_memory_gate_off_allows_write(hermes_home):
    # Default (gate off) → write straight through, no staging.
    from tools.memory_tool import memory_tool, MemoryStore
    from tools import write_approval as wa
    store = MemoryStore(); store.load_from_disk()
    r = json.loads(memory_tool("add", "user", "save me", store=store))
    assert r["success"] is True
    assert r["entry_count"] == 1
    assert wa.pending_count("memory") == 0


def test_memory_gate_on_no_interactive_stages(hermes_home):
    # Gate on, no approval callback / not a gateway context → stage.
    from tools.memory_tool import memory_tool, MemoryStore
    from tools import write_approval as wa
    _set_approval("memory", True)
    store = MemoryStore(); store.load_from_disk()
    r = json.loads(memory_tool("add", "memory", "stage me", store=store))
    assert r.get("staged") is True
    assert r.get("pending_id")
    # Not written to the live store yet.
    assert store.memory_entries == []
    pend = wa.list_pending("memory")
    assert len(pend) == 1
    assert pend[0]["id"] == r["pending_id"]


def test_memory_gate_on_then_apply(hermes_home):
    from tools.memory_tool import memory_tool, MemoryStore, apply_memory_pending
    from tools import write_approval as wa
    _set_approval("memory", True)
    store = MemoryStore(); store.load_from_disk()
    r = json.loads(memory_tool("add", "user", "approved entry", store=store))
    pid = r["pending_id"]
    rec = wa.get_pending("memory", pid)
    result = apply_memory_pending(rec["payload"], store)
    assert result["success"] is True
    assert "approved entry" in store.user_entries[0]


def test_cli_memory_approve_without_live_agent_uses_fresh_store(hermes_home, capsys):
    """#46783: ``/memory approve`` from a context with no live agent (e.g. the
    Desktop GUI) passed ``memory_store=None`` into the shared handler, which
    returned "memory store unavailable" and applied nothing. The CLI handler must
    fall back to a freshly loaded on-disk store, like the gateway path does."""
    import json
    from tools.memory_tool import memory_tool, MemoryStore
    from tools import write_approval as wa
    from hermes_cli.cli_commands_mixin import CLICommandsMixin

    _set_approval("memory", True)
    staging = MemoryStore(); staging.load_from_disk()
    r = json.loads(memory_tool("add", "memory", "remember the launch date", store=staging))
    assert r.get("pending_id"), r
    assert wa.pending_count("memory") == 1

    # Bare CLI handler with no live agent → store resolves to None pre-fix.
    handler = CLICommandsMixin.__new__(CLICommandsMixin)
    handler.agent = None
    handler._handle_memory_command("/memory approve all")

    out = capsys.readouterr().out
    assert "memory store unavailable" not in out, out
    assert "Approved 1" in out, out
    assert wa.pending_count("memory") == 0
    # The approved write landed in a freshly loaded on-disk store (MEMORY.md).
    reloaded = MemoryStore(); reloaded.load_from_disk()
    assert any("remember the launch date" in e for e in reloaded.memory_entries)


def test_load_on_disk_store_honors_configured_char_limits(hermes_home, monkeypatch):
    """load_on_disk_store() must read memory.memory_char_limit /
    user_char_limit from config so approvals applied without a live agent
    enforce the SAME caps as the live agent (agent_init.py). Falls back to
    defaults when config can't be loaded.
    """
    from tools.memory_tool import load_on_disk_store

    # Config override path: helper picks up the configured limits.
    monkeypatch.setattr(
        "hermes_cli.config.load_config",
        lambda: {"memory": {"memory_char_limit": 999, "user_char_limit": 444}},
    )
    store = load_on_disk_store()
    assert store.memory_char_limit == 999
    assert store.user_char_limit == 444

    # Failure path: config raises → defaults, never blows up.
    def _boom():
        raise RuntimeError("no config")

    monkeypatch.setattr("hermes_cli.config.load_config", _boom)
    fallback = load_on_disk_store()
    assert fallback.memory_char_limit == 2200
    assert fallback.user_char_limit == 1375


# ---------------------------------------------------------------------------
# Skill gate
# ---------------------------------------------------------------------------

_SKILL = (
    "---\nname: test-skill\ndescription: A test skill\nversion: 1.0.0\n---\n"
    "# Test\nbody\n"
)


def test_skill_gate_off_allows_create(hermes_home):
    # Default (gate off) → skill is created normally, not staged.
    import importlib
    import tools.skill_manager_tool as smt
    importlib.reload(smt)
    from tools import write_approval as wa
    r = json.loads(smt.skill_manage("create", "free-skill", content=_SKILL))
    assert r.get("success") is True
    assert wa.pending_count("skills") == 0


def test_skill_gate_on_always_stages(hermes_home):
    # Skills stage even in the foreground (too big to review inline).
    from tools.skill_manager_tool import skill_manage
    from tools import write_approval as wa
    _set_approval("skills", True)
    r = json.loads(skill_manage("create", "staged-skill", content=_SKILL))
    assert r.get("staged") is True
    assert "staged-skill" in r.get("gist", "")
    assert wa.pending_count("skills") == 1


def test_skill_gate_on_then_apply_writes_file(hermes_home):
    # SKILLS_DIR is resolved at import time, so reload the skill module under
    # this test's HERMES_HOME to exercise the real on-disk write path.
    import importlib
    import tools.skill_manager_tool as smt
    importlib.reload(smt)
    from tools import write_approval as wa
    _set_approval("skills", True)
    r = json.loads(smt.skill_manage("create", "applied-skill", content=_SKILL))
    rec = wa.get_pending("skills", r["pending_id"])
    res = json.loads(smt.apply_skill_pending(rec["payload"]))
    assert res["success"] is True
    assert smt._find_skill("applied-skill") is not None


def test_approved_background_skill_delete_preserves_origin_and_archives(
    hermes_home, monkeypatch, tmp_path
):
    import importlib
    from hermes_cli.write_approval_commands import resolve_pending_write
    from tools import write_approval as wa
    import tools.skill_manager_tool as smt
    import tools.skill_usage as skill_usage
    from tools.skill_provenance import get_current_write_origin

    importlib.reload(smt)
    skill_dir = tmp_path / "skills" / "review-created"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(_SKILL, encoding="utf-8")
    monkeypatch.setattr(smt, "_find_skill", lambda _name: {"path": skill_dir})
    monkeypatch.setattr(smt, "_background_review_write_guard", lambda *_args: None)
    monkeypatch.setattr(smt, "_curator_consolidation_delete_guard", lambda *_args: None)
    monkeypatch.setattr(smt, "_pinned_guard", lambda *_args: None)
    monkeypatch.setattr(smt, "_validate_delete_target", lambda *_args: None)
    observed_origins = []

    def archive_skill(_name):
        observed_origins.append(get_current_write_origin())
        return True, "recoverable archive"

    monkeypatch.setattr(skill_usage, "archive_skill", archive_skill)
    original_rmtree = smt.shutil.rmtree

    def reject_target_rmtree(path, *args, **kwargs):
        if path == skill_dir:
            pytest.fail("background delete hard-deleted skill")
        return original_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(smt.shutil, "rmtree", reject_target_rmtree)
    rec = wa.stage_write(
        wa.SKILLS,
        {"action": "delete", "name": "review-created", "absorbed_into": ""},
        summary="delete review-created",
        origin="background_review",
    )

    result = resolve_pending_write(wa.SKILLS, rec["id"], "approve")

    assert result["success"] is True
    assert observed_origins == ["background_review"]
    assert get_current_write_origin() == "foreground"


def test_invalid_staged_origin_fails_closed_without_apply(hermes_home, monkeypatch):
    from hermes_cli import write_approval_commands as commands
    from tools import write_approval as wa

    rec = wa.stage_write(
        wa.SKILLS,
        {"action": "create", "name": "unsafe-origin", "content": _SKILL},
        summary="create unsafe-origin",
        origin="foreground",
    )
    path = wa._pending_dir(wa.SKILLS) / f"{rec['id']}.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    value["origin"] = "attacker_controlled"
    path.write_text(json.dumps(value), encoding="utf-8")
    calls = []
    monkeypatch.setattr(
        commands, "_apply_one", lambda *_args: calls.append(True) or (True, "", True)
    )

    result = commands.resolve_pending_write(wa.SKILLS, rec["id"], "approve")

    assert result == {"success": False, "error": "invalid_origin"}
    assert calls == []
    assert wa.get_pending(wa.SKILLS, rec["id"]) is None
    assert not (wa._claim_dir(wa.SKILLS) / f"{rec['id']}.json").exists()
    assert wa.get_resolution_receipt(wa.SKILLS, rec["id"]) == {
        "subsystem": wa.SKILLS,
        "pending_id": rec["id"],
        "decision": "reject",
        "reason": "invalid_origin",
    }


def test_stage_write_rejects_unknown_origin_before_publication(hermes_home):
    from tools import write_approval as wa

    with pytest.raises(wa.StagingError):
        wa.stage_write(
            wa.SKILLS,
            {"action": "create", "name": "unsafe-origin", "content": _SKILL},
            summary="create unsafe-origin",
            origin="attacker_controlled",
        )

    assert wa.pending_count(wa.SKILLS) == 0


def test_runtime_assistant_tool_origin_normalizes_to_foreground(hermes_home):
    from tools import write_approval as wa
    from tools.skill_provenance import (
        reset_current_write_origin,
        set_current_write_origin,
    )

    token = set_current_write_origin("assistant_tool")
    try:
        assert wa.current_origin() == "foreground"
        rec = wa.stage_write(
            wa.SKILLS,
            {"action": "create", "name": "normal-origin", "content": _SKILL},
            summary="create normal-origin",
            origin=wa.current_origin(),
        )
    finally:
        reset_current_write_origin(token)

    assert rec["origin"] == "foreground"


def test_apply_origin_context_resets_after_exception(hermes_home, monkeypatch):
    from hermes_cli import write_approval_commands as commands
    from tools import write_approval as wa
    from tools.skill_provenance import get_current_write_origin

    rec = wa.stage_write(
        wa.SKILLS,
        {"action": "create", "name": "raises", "content": _SKILL},
        summary="create raises",
        origin="background_review",
    )
    monkeypatch.setattr(
        "tools.skill_manager_tool.apply_skill_pending",
        lambda _payload: (_ for _ in ()).throw(RuntimeError("apply failed")),
    )

    result = commands.resolve_pending_write(wa.SKILLS, rec["id"], "approve")

    assert result == {"success": False, "error": "apply_failed"}
    assert get_current_write_origin() == "foreground"


def test_skill_create_diff_is_full_content(hermes_home):
    from tools.skill_manager_tool import skill_manage
    from tools import write_approval as wa
    _set_approval("skills", True)
    r = json.loads(skill_manage("create", "diff-skill", content=_SKILL))
    rec = wa.get_pending("skills", r["pending_id"])
    diff = wa.skill_pending_diff(rec)
    assert "name: test-skill" in diff


# ---------------------------------------------------------------------------
# Pending store CRUD
# ---------------------------------------------------------------------------

def test_pending_store_roundtrip(hermes_home):
    from tools import write_approval as wa
    rec = wa.stage_write("memory", {"action": "add", "target": "user", "content": "x"},
                         summary="add x", origin="foreground")
    assert wa.pending_count("memory") == 1
    got = wa.get_pending("memory", rec["id"])
    assert got["payload"]["content"] == "x"
    assert wa.discard_pending("memory", rec["id"]) is True
    assert wa.pending_count("memory") == 0
    assert wa.get_pending("memory", rec["id"]) is None


@pytest.mark.parametrize("failure", ["write", "link", "directory_fsync"])
def test_stage_write_publication_failures_are_explicit_and_payload_free(
    hermes_home, monkeypatch, failure
):
    from tools import write_approval as wa

    secret = "PRIVATE-STAGING-PAYLOAD"
    if failure == "write":
        monkeypatch.setattr(
            wa.json,
            "dump",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk full")),
        )
    elif failure == "link":
        monkeypatch.setattr(
            wa.os,
            "link",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("link failed")),
        )
    else:
        original = wa._fsync_dir
        for directory in (
            wa._pending_dir(wa.MEMORY),
            wa._claim_dir(wa.MEMORY),
            wa._receipt_dir(wa.MEMORY),
            wa._lock_dir(wa.MEMORY),
        ):
            directory.mkdir(parents=True, exist_ok=True)

        def fail_publication_fsync(path):
            if path == wa._pending_dir(wa.MEMORY):
                raise OSError("directory fsync failed")
            return original(path)

        monkeypatch.setattr(wa, "_fsync_dir", fail_publication_fsync)

    with pytest.raises(wa.StagingError) as exc:
        wa.stage_write(
            wa.MEMORY,
            {"action": "add", "target": "memory", "content": secret},
            summary=secret,
            origin="foreground",
        )

    assert secret not in str(exc.value)
    assert wa.list_pending(wa.MEMORY) == []


def test_memory_gate_reports_failure_when_pending_publication_fails(
    hermes_home, monkeypatch
):
    from tools.memory_tool import MemoryStore, memory_tool
    from tools import write_approval as wa

    _set_approval("memory", True)
    monkeypatch.setattr(
        wa,
        "stage_write",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(wa.StagingError()),
    )
    result = json.loads(
        memory_tool("add", "memory", "PRIVATE-NOT-STAGED", store=MemoryStore())
    )

    assert result["success"] is False
    assert result.get("staged") is not True
    assert "pending_id" not in result


def test_skill_gate_reports_failure_when_pending_publication_fails(
    hermes_home, monkeypatch
):
    import tools.skill_manager_tool as smt
    from tools import write_approval as wa

    _set_approval("skills", True)
    monkeypatch.setattr(
        wa,
        "stage_write",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(wa.StagingError()),
    )
    result = json.loads(smt.skill_manage("create", "not-staged", content=_SKILL))

    assert result["success"] is False
    assert result.get("staged") is not True
    assert "pending_id" not in result


def test_memory_gate_fails_closed_when_approval_module_unavailable(
    hermes_home, monkeypatch
):
    import tools.memory_tool as memory_module

    monkeypatch.setattr(memory_module, "_load_write_approval_module", lambda: None)
    result = json.loads(
        memory_module.memory_tool(
            "add", "memory", "MUST-NOT-PERSIST", store=memory_module.MemoryStore()
        )
    )

    assert result["success"] is False
    assert "blocked safely" in result["error"]


def test_memory_batch_gate_fails_closed_without_persistence(
    hermes_home, monkeypatch
):
    import tools.memory_tool as memory_module

    store = memory_module.MemoryStore()
    memory_path = memory_module.get_memory_dir() / "MEMORY.md"
    user_path = memory_module.get_memory_dir() / "USER.md"
    monkeypatch.setattr(memory_module, "_load_write_approval_module", lambda: None)

    result = json.loads(
        memory_module.memory_tool(
            target="memory",
            operations=[{"action": "add", "content": "MUST-NOT-PERSIST"}],
            store=store,
        )
    )

    assert result["success"] is False
    assert store.memory_entries == []
    assert store.user_entries == []
    assert not memory_path.exists()
    assert not user_path.exists()


def test_mutations_fail_closed_on_malformed_config_after_absent_defaults_cache(
    hermes_home,
):
    from pathlib import Path
    import hermes_cli.config as cfg
    import tools.memory_tool as memory_module
    import tools.skill_manager_tool as smt

    # Reproduce the dangerous sequence: defaults cached before config exists.
    cfg.load_config()
    Path(hermes_home, "config.yaml").write_text(
        "memory: [unterminated", encoding="utf-8"
    )
    store = memory_module.MemoryStore()

    single = json.loads(
        memory_module.memory_tool(
            "add", "memory", "MUST-NOT-PERSIST", store=store
        )
    )
    batch = json.loads(
        memory_module.memory_tool(
            target="memory",
            operations=[{"action": "add", "content": "ALSO-NOT-PERSIST"}],
            store=store,
        )
    )
    skill = json.loads(
        smt.skill_manage("create", "malformed-config-blocked", content=_SKILL)
    )

    assert single["success"] is False
    assert batch["success"] is False
    assert skill["success"] is False
    assert store.memory_entries == []
    assert not (memory_module.get_memory_dir() / "MEMORY.md").exists()
    assert not (smt.SKILLS_DIR / "malformed-config-blocked").exists()


@pytest.mark.parametrize("user_config_present", [False, True])
@pytest.mark.parametrize("failure_mode", ["malformed", "unreadable"])
def test_managed_gate_lkg_survives_policy_failure_for_all_mutations(
    hermes_home, tmp_path, monkeypatch, user_config_present, failure_mode
):
    import builtins
    from pathlib import Path
    import hermes_cli.config as cfg
    from hermes_cli import managed_scope
    import tools.memory_tool as memory_module
    import tools.skill_manager_tool as smt

    managed_dir = tmp_path / "managed"
    managed_dir.mkdir()
    managed_path = managed_dir / "config.yaml"
    managed_path.write_text(
        "memory:\n  write_approval: true\nskills:\n  write_approval: true\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed_dir))
    managed_scope.invalidate_managed_cache()
    if user_config_present:
        Path(hermes_home, "config.yaml").write_text(
            "memory:\n  write_approval: false\nskills:\n  write_approval: false\n",
            encoding="utf-8",
        )
    loaded = cfg.load_config()
    assert loaded["memory"]["write_approval"] is True
    assert loaded["skills"]["write_approval"] is True

    if failure_mode == "malformed":
        managed_path.write_text("memory: [broken", encoding="utf-8")
    else:
        managed_path.write_text("memory:\n  write_approval: true\n# changed\n", encoding="utf-8")
        managed_scope.invalidate_managed_cache()
        real_open = builtins.open

        def denied_open(file, *args, **kwargs):
            if Path(file) == managed_path:
                raise PermissionError("managed policy denied")
            return real_open(file, *args, **kwargs)

        monkeypatch.setattr(builtins, "open", denied_open)

    store = memory_module.MemoryStore()
    single = json.loads(
        memory_module.memory_tool("add", "memory", "MANAGED-SINGLE", store=store)
    )
    batch = json.loads(
        memory_module.memory_tool(
            target="memory",
            operations=[{"action": "add", "content": "MANAGED-BATCH"}],
            store=store,
        )
    )
    skill = json.loads(
        smt.skill_manage("create", "managed-policy-lkg", content=_SKILL)
    )

    assert single.get("staged") is True
    assert batch.get("staged") is True
    assert skill.get("staged") is True
    assert store.memory_entries == []
    assert not (memory_module.get_memory_dir() / "MEMORY.md").exists()
    assert not (smt.SKILLS_DIR / "managed-policy-lkg").exists()


@pytest.mark.parametrize("user_config_present", [False, True])
@pytest.mark.parametrize("failure_mode", ["malformed", "unreadable"])
def test_fresh_failed_managed_policy_blocks_all_mutations(
    hermes_home, tmp_path, monkeypatch, user_config_present, failure_mode
):
    import builtins
    from pathlib import Path
    from hermes_cli import managed_scope
    import tools.memory_tool as memory_module
    import tools.skill_manager_tool as smt

    managed_dir = tmp_path / "managed-fresh"
    managed_dir.mkdir()
    managed_path = managed_dir / "config.yaml"
    managed_path.write_text(
        "skills: [broken" if failure_mode == "malformed" else "skills: {}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed_dir))
    managed_scope.invalidate_managed_cache()
    if failure_mode == "unreadable":
        real_open = builtins.open

        def denied_open(file, *args, **kwargs):
            if Path(file) == managed_path:
                raise PermissionError("fresh managed policy denied")
            return real_open(file, *args, **kwargs)

        monkeypatch.setattr(builtins, "open", denied_open)
    if user_config_present:
        Path(hermes_home, "config.yaml").write_text(
            "memory:\n  write_approval: false\n", encoding="utf-8"
        )

    store = memory_module.MemoryStore()
    single = json.loads(
        memory_module.memory_tool("add", "memory", "BLOCK-MANAGED", store=store)
    )
    batch = json.loads(
        memory_module.memory_tool(
            target="memory",
            operations=[{"action": "add", "content": "BLOCK-BATCH"}],
            store=store,
        )
    )
    skill = json.loads(
        smt.skill_manage("create", "fresh-managed-blocked", content=_SKILL)
    )

    assert single["success"] is False
    assert batch["success"] is False
    assert skill["success"] is False
    assert store.memory_entries == []
    assert not (memory_module.get_memory_dir() / "MEMORY.md").exists()
    assert not (smt.SKILLS_DIR / "fresh-managed-blocked").exists()


@pytest.mark.parametrize("failure_mode", ["malformed", "unreadable"])
def test_removed_managed_policy_cannot_be_resurrected_after_failed_replacement(
    hermes_home, tmp_path, monkeypatch, failure_mode
):
    import builtins
    from pathlib import Path
    import hermes_cli.config as cfg
    from hermes_cli import managed_scope
    import tools.memory_tool as memory_module
    import tools.skill_manager_tool as smt

    Path(hermes_home, "config.yaml").write_text(
        "memory:\n  write_approval: true\nskills:\n  write_approval: true\n",
        encoding="utf-8",
    )
    managed_dir = tmp_path / "managed-removal"
    managed_dir.mkdir()
    managed_path = managed_dir / "config.yaml"
    managed_path.write_text(
        "memory:\n  write_approval: false\nskills:\n  write_approval: false\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed_dir))
    managed_scope.invalidate_managed_cache()

    initial = cfg.load_config()
    assert initial["memory"]["write_approval"] is False
    assert initial["skills"]["write_approval"] is False

    managed_path.unlink()
    absent = cfg.load_config()
    assert absent["memory"]["write_approval"] is True
    assert absent["skills"]["write_approval"] is True

    if failure_mode == "malformed":
        managed_path.write_text("memory: [broken", encoding="utf-8")
    else:
        managed_path.write_text("memory: {}\n# replacement\n", encoding="utf-8")
        managed_scope.invalidate_managed_cache()
        real_open = builtins.open

        def denied_open(file, *args, **kwargs):
            if Path(file) == managed_path:
                raise PermissionError("replacement managed policy denied")
            return real_open(file, *args, **kwargs)

        monkeypatch.setattr(builtins, "open", denied_open)
    store = memory_module.MemoryStore()
    single = json.loads(
        memory_module.memory_tool("add", "memory", "STALE-MANAGED", store=store)
    )
    batch = json.loads(
        memory_module.memory_tool(
            target="memory",
            operations=[{"action": "add", "content": "STALE-BATCH"}],
            store=store,
        )
    )
    skill = json.loads(
        smt.skill_manage("create", "stale-managed-blocked", content=_SKILL)
    )

    assert single["success"] is False
    assert batch["success"] is False
    assert skill["success"] is False
    assert store.memory_entries == []
    assert not (memory_module.get_memory_dir() / "MEMORY.md").exists()
    assert not (smt.SKILLS_DIR / "stale-managed-blocked").exists()


def test_managed_removal_does_not_contaminate_user_lkg_during_user_failure(
    hermes_home, tmp_path, monkeypatch
):
    from pathlib import Path
    import hermes_cli.config as cfg
    from hermes_cli import managed_scope
    import tools.memory_tool as memory_module

    user_path = Path(hermes_home, "config.yaml")
    user_path.write_text("memory:\n  write_approval: true\n", encoding="utf-8")
    managed_dir = tmp_path / "managed-split-lkg"
    managed_dir.mkdir()
    managed_path = managed_dir / "config.yaml"
    managed_path.write_text(
        "memory:\n  write_approval: false\n", encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed_dir))
    managed_scope.invalidate_managed_cache()
    assert cfg.load_config()["memory"]["write_approval"] is False

    user_path.write_text("memory: [broken", encoding="utf-8")
    managed_path.unlink()
    store = memory_module.MemoryStore()
    result = json.loads(
        memory_module.memory_tool("add", "memory", "USER-LKG-STAGED", store=store)
    )

    assert result.get("staged") is True
    assert store.memory_entries == []
    assert not (memory_module.get_memory_dir() / "MEMORY.md").exists()


def test_save_strips_stale_managed_values_after_source_removal(
    hermes_home, tmp_path, monkeypatch
):
    from pathlib import Path
    import yaml
    import hermes_cli.config as cfg
    from hermes_cli import managed_scope

    managed_dir = tmp_path / "managed-save-removed"
    managed_dir.mkdir()
    managed_path = managed_dir / "config.yaml"
    managed_path.write_text(
        "memory:\n  write_approval: false\n", encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed_dir))
    managed_scope.invalidate_managed_cache()

    user_path = Path(hermes_home) / "config.yaml"
    user_path.write_text(
        "memory:\n  write_approval: true\n", encoding="utf-8"
    )
    retained = cfg.load_config()
    assert retained["memory"]["write_approval"] is False

    managed_path.unlink()
    retained["memory"]["user_char_limit"] = 1234
    cfg.save_config(retained)

    persisted = yaml.safe_load(user_path.read_text(encoding="utf-8"))
    assert persisted["memory"]["write_approval"] is True
    assert persisted["memory"]["user_char_limit"] == 1234


def test_save_rejects_retained_merged_config_when_managed_source_failed(
    hermes_home, tmp_path, monkeypatch
):
    from pathlib import Path
    import hermes_cli.config as cfg
    from hermes_cli import managed_scope

    managed_dir = tmp_path / "managed-save-failed"
    managed_dir.mkdir()
    managed_path = managed_dir / "config.yaml"
    managed_path.write_text(
        "memory:\n  write_approval: false\n", encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed_dir))
    managed_scope.invalidate_managed_cache()

    user_path = Path(hermes_home) / "config.yaml"
    original = "memory:\n  write_approval: true\n"
    user_path.write_text(original, encoding="utf-8")
    retained = cfg.load_config()
    assert retained["memory"]["write_approval"] is False

    managed_path.write_text("memory: [broken", encoding="utf-8")
    retained["memory"]["user_char_limit"] = 1234
    with pytest.raises(RuntimeError, match="managed configuration"):
        cfg.save_config(retained)

    assert user_path.read_text(encoding="utf-8") == original


def test_cli_write_approval_toggle_refreshes_security_lkg_before_corruption(
    hermes_home,
):
    from pathlib import Path
    import hermes_cli.config as cfg
    from hermes_cli.cli_commands_mixin import CLICommandsMixin
    from tools import write_approval as wa

    config_path = Path(hermes_home) / "config.yaml"
    config_path.write_text(
        "memory:\n  write_approval: false\nskills:\n  write_approval: false\n",
        encoding="utf-8",
    )
    cfg.load_config()

    CLICommandsMixin._save_write_approval(object(), "memory", True)
    config_path.write_text("memory: [broken\n", encoding="utf-8")

    assert wa.write_approval_enabled(wa.MEMORY) is True
    assert wa.evaluate_gate(wa.MEMORY).allow is False


def test_legacy_atomic_config_writer_preserves_gates_and_refreshes_lkg(
    hermes_home
):
    from pathlib import Path
    import yaml
    import hermes_cli.config as cfg
    from tools import write_approval as wa

    config_path = Path(hermes_home) / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(
            {
                "memory": {"write_approval": True},
                "skills": {"write_approval": True},
            }
        ),
        encoding="utf-8",
    )
    cfg.load_config()

    cfg.atomic_config_write(
        config_path,
        {
            "model": {"default": "new-model"},
            "memory": {"write_approval": False},
            "skills": {"write_approval": False},
        },
    )
    persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert persisted["memory"]["write_approval"] is True
    assert persisted["skills"]["write_approval"] is True

    config_path.write_text("memory: [broken\n", encoding="utf-8")
    assert wa.write_approval_enabled("memory") is True
    assert wa.write_approval_enabled("skills") is True


def test_config_transaction_lock_serializes_independent_processes(
    hermes_home, tmp_path
):
    from pathlib import Path
    import subprocess
    import sys
    import time
    import hermes_cli.config as cfg

    config_path = Path(hermes_home) / "config.yaml"
    config_path.write_text(
        "memory:\n  write_approval: false\n", encoding="utf-8"
    )
    ready = tmp_path / "child-ready"
    script = (
        "from pathlib import Path\n"
        "import sys\n"
        "from hermes_cli.config import set_config_value\n"
        "Path(sys.argv[1]).write_text('ready', encoding='utf-8')\n"
        "set_config_value('memory.write_approval', 'true')\n"
    )

    with cfg._config_transaction_lock():
        child = subprocess.Popen(
            [sys.executable, "-c", script, str(ready)],
            cwd=str(Path(__file__).resolve().parents[2]),
            env=os.environ.copy(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ready.exists()
        time.sleep(0.15)
        assert child.poll() is None

    stdout, stderr = child.communicate(timeout=10)
    assert child.returncode == 0, (stdout, stderr)
    assert cfg.load_config()["memory"]["write_approval"] is True


def test_full_config_mutation_serializes_read_modify_save_across_processes(
    hermes_home, tmp_path
):
    from pathlib import Path
    import subprocess
    import sys
    import time
    import hermes_cli.config as cfg

    config_path = Path(hermes_home) / "config.yaml"
    config_path.write_text(
        "memory:\n  write_approval: false\nplatforms: {}\n", encoding="utf-8"
    )
    ready = tmp_path / "mutation-ready"
    script = (
        "from pathlib import Path\n"
        "import sys, time\n"
        "from hermes_cli.config import mutate_config\n"
        "def apply(config):\n"
        "    Path(sys.argv[1]).write_text('ready', encoding='utf-8')\n"
        "    time.sleep(0.4)\n"
        "    config.setdefault('platforms', {})['test'] = {'enabled': True}\n"
        "mutate_config(apply)\n"
    )
    stale_writer = subprocess.Popen(
        [sys.executable, "-c", script, str(ready)],
        cwd=str(Path(__file__).resolve().parents[2]),
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.monotonic() + 5
    while not ready.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert ready.exists()

    gate_writer = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "from hermes_cli.config import set_config_value; "
            "set_config_value('memory.write_approval', 'true')",
        ],
        cwd=str(Path(__file__).resolve().parents[2]),
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    time.sleep(0.1)
    assert gate_writer.poll() is None

    stale_out, stale_err = stale_writer.communicate(timeout=10)
    gate_out, gate_err = gate_writer.communicate(timeout=10)
    assert stale_writer.returncode == 0, (stale_out, stale_err)
    assert gate_writer.returncode == 0, (gate_out, gate_err)
    loaded = cfg.load_config()
    assert loaded["memory"]["write_approval"] is True
    assert loaded["platforms"]["test"]["enabled"] is True


def test_concurrent_config_setters_cannot_overwrite_newly_enabled_gate(
    hermes_home, monkeypatch
):
    from pathlib import Path
    import yaml
    import hermes_cli.config as cfg

    config_path = Path(hermes_home) / "config.yaml"
    config_path.write_text(
        "memory:\n  write_approval: false\nmodel:\n  default: old/model\n",
        encoding="utf-8",
    )
    cfg.load_config()

    original_save = cfg.save_config
    unrelated_ready = threading.Event()
    gate_saved = threading.Event()
    errors = []

    def coordinated_save(config, **kwargs):
        if threading.current_thread().name == "unrelated-setter":
            unrelated_ready.set()
            if not cfg._CONFIG_LOCK._is_owned():
                assert gate_saved.wait(timeout=5)
        result = original_save(config, **kwargs)
        if threading.current_thread().name == "gate-setter":
            gate_saved.set()
        return result

    monkeypatch.setattr(cfg, "save_config", coordinated_save)

    def run_setter(name, key, value):
        try:
            cfg.set_config_value(key, value)
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append((name, exc))

    unrelated = threading.Thread(
        target=run_setter,
        args=("unrelated", "model.default", "new/model"),
        name="unrelated-setter",
    )
    gate = threading.Thread(
        target=run_setter,
        args=("gate", "memory.write_approval", "true"),
        name="gate-setter",
    )
    unrelated.start()
    assert unrelated_ready.wait(timeout=5)
    gate.start()
    unrelated.join(timeout=10)
    gate.join(timeout=10)

    assert not unrelated.is_alive()
    assert not gate.is_alive()
    assert errors == []
    persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert persisted["memory"]["write_approval"] is True
    assert cfg.load_config_for_security_gate()["memory"]["write_approval"] is True


def test_set_config_value_refreshes_security_lkg_before_immediate_corruption(
    hermes_home
):
    from pathlib import Path
    import hermes_cli.config as cfg
    import tools.memory_tool as memory_module
    import tools.skill_manager_tool as smt

    config_path = Path(hermes_home) / "config.yaml"
    config_path.write_text(
        "memory:\n  write_approval: false\nskills:\n  write_approval: false\n",
        encoding="utf-8",
    )
    loaded = cfg.load_config()
    assert loaded["memory"]["write_approval"] is False
    assert loaded["skills"]["write_approval"] is False

    cfg.set_config_value("memory.write_approval", "true")
    cfg.set_config_value("skills.write_approval", "true")
    config_path.write_text("memory: [broken", encoding="utf-8")

    store = memory_module.MemoryStore()
    single = json.loads(
        memory_module.memory_tool("add", "memory", "SET-GATE-SINGLE", store=store)
    )
    batch = json.loads(
        memory_module.memory_tool(
            target="memory",
            operations=[{"action": "add", "content": "SET-GATE-BATCH"}],
            store=store,
        )
    )
    skill = json.loads(
        smt.skill_manage("create", "set-gate-skill", content=_SKILL)
    )

    assert single.get("staged") is True
    assert batch.get("staged") is True
    assert skill.get("staged") is True
    assert store.memory_entries == []
    assert not (smt.SKILLS_DIR / "set-gate-skill").exists()


def test_successful_save_refreshes_user_policy_lkg_before_next_load(
    hermes_home
):
    from pathlib import Path
    import hermes_cli.config as cfg
    import tools.memory_tool as memory_module
    import tools.skill_manager_tool as smt

    config_path = Path(hermes_home) / "config.yaml"
    config_path.write_text(
        "memory:\n  write_approval: false\nskills:\n  write_approval: false\n",
        encoding="utf-8",
    )
    loaded = cfg.load_config()
    assert loaded["memory"]["write_approval"] is False
    assert loaded["skills"]["write_approval"] is False

    loaded["memory"]["write_approval"] = True
    loaded["skills"]["write_approval"] = True
    cfg.save_config(loaded)
    config_path.write_text("memory: [broken", encoding="utf-8")

    store = memory_module.MemoryStore()
    single = json.loads(
        memory_module.memory_tool("add", "memory", "POST-SAVE-GATE", store=store)
    )
    batch = json.loads(
        memory_module.memory_tool(
            target="memory",
            operations=[{"action": "add", "content": "POST-SAVE-BATCH"}],
            store=store,
        )
    )
    skill = json.loads(
        smt.skill_manage("create", "post-save-gate", content=_SKILL)
    )

    assert single.get("staged") is True
    assert batch.get("staged") is True
    assert skill.get("staged") is True
    assert store.memory_entries == []
    assert not (memory_module.get_memory_dir() / "MEMORY.md").exists()
    assert not (smt.SKILLS_DIR / "post-save-gate").exists()


def test_genuinely_parsed_config_remains_security_lkg(hermes_home):
    from pathlib import Path
    import hermes_cli.config as cfg
    from tools import write_approval as wa

    config_path = Path(hermes_home) / "config.yaml"
    config_path.write_text(
        "memory:\n  write_approval: true\n", encoding="utf-8"
    )
    assert cfg.load_config()["memory"]["write_approval"] is True
    config_path.write_text("memory: [broken", encoding="utf-8")

    assert wa.write_approval_enabled(wa.MEMORY) is True
    assert str(config_path) not in cfg._CONFIG_LOAD_FAILURE_WITHOUT_LKG


def test_gate_fails_closed_on_unreadable_existing_config(
    hermes_home, monkeypatch
):
    import builtins
    from pathlib import Path
    import hermes_cli.config as cfg
    from tools import write_approval as wa

    config_path = Path(hermes_home) / "config.yaml"
    config_path.write_text("memory:\n  write_approval: true\n", encoding="utf-8")
    path_key = str(config_path)
    cfg._LOAD_CONFIG_CACHE.pop(path_key, None)
    cfg._LAST_EXPANDED_CONFIG_BY_PATH.pop(path_key, None)
    cfg._SECURITY_LKG_CONFIG_BY_PATH.pop(path_key, None)
    cfg._SECURITY_LKG_PROVENANCE_BY_PATH.pop(path_key, None)
    cfg._SECURITY_MANAGED_LKG_BY_PATH.pop(path_key, None)
    cfg._CONFIG_LOAD_FAILURE_WITHOUT_LKG.discard(path_key)
    real_open = builtins.open

    def denied_open(file, *args, **kwargs):
        if Path(file) == config_path:
            raise PermissionError("denied")
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", denied_open)

    decision = wa.evaluate_gate(wa.MEMORY)
    assert decision.blocked is True
    assert decision.allow is False
    assert "blocked safely" in decision.message


def test_skill_gate_fails_closed_when_approval_module_unavailable(
    hermes_home, monkeypatch
):
    import tools.skill_manager_tool as smt

    monkeypatch.setattr(smt, "_load_write_approval_module", lambda: None)
    result = json.loads(smt.skill_manage("create", "must-not-exist", content=_SKILL))

    assert result["success"] is False
    assert "blocked safely" in result["error"]
    assert not (smt.SKILLS_DIR / "must-not-exist").exists()


def test_pending_lock_uses_windows_backend(hermes_home, monkeypatch):
    from tools import write_approval as wa

    class FakeMsvcrt:
        LK_LOCK = 1
        LK_UNLCK = 2

        def __init__(self):
            self.calls = []

        def locking(self, fd, mode, size):
            self.calls.append((mode, size, os.lseek(fd, 0, os.SEEK_CUR)))

    backend = FakeMsvcrt()
    monkeypatch.setattr(wa, "fcntl", None)
    monkeypatch.setattr(wa, "msvcrt", backend)

    with wa._pending_lock(wa.MEMORY, "windows-lock"):
        assert backend.calls == [(backend.LK_LOCK, 1, 0)]

    assert backend.calls[-1] == (backend.LK_UNLCK, 1, 0)


def test_windows_simulated_stage_claim_reject_lifecycle(hermes_home, monkeypatch):
    from tools import write_approval as wa

    class FakeMsvcrt:
        LK_LOCK = 1
        LK_UNLCK = 2

        def __init__(self):
            self.calls = []

        def locking(self, fd, mode, size):
            self.calls.append((mode, size))

    backend = FakeMsvcrt()
    secured = []
    monkeypatch.setattr(wa, "_WINDOWS", True)
    monkeypatch.setattr(wa, "_restrict_windows_acl", lambda path: secured.append(path))
    monkeypatch.setattr(wa, "fcntl", None)
    monkeypatch.setattr(wa, "msvcrt", backend)

    rec = wa.stage_write(
        wa.MEMORY,
        {"action": "add", "target": "memory", "content": "windows-safe"},
        summary="windows-safe",
        origin="foreground",
    )
    status, claim = wa.claim_pending(wa.MEMORY, rec["id"], "reject")

    assert status == "claimed"
    assert claim is not None
    assert wa.finish_pending_claim(
        wa.MEMORY, rec["id"], "reject", claim["_claim_nonce"]
    )
    assert wa.get_pending(wa.MEMORY, rec["id"]) is None
    assert wa.get_resolution_receipt(wa.MEMORY, rec["id"])["decision"] == "reject"
    assert any(mode == backend.LK_LOCK for mode, _size in backend.calls)
    assert secured
    assert any(".tmp" in path.name for path in secured)


def test_windows_acl_failure_blocks_staging(hermes_home, monkeypatch):
    from tools import write_approval as wa

    monkeypatch.setattr(wa, "_WINDOWS", True)
    monkeypatch.setattr(
        wa,
        "_restrict_windows_acl",
        lambda _path: (_ for _ in ()).throw(PermissionError("ACL denied")),
    )

    with pytest.raises(wa.StagingError):
        wa.stage_write(
            wa.MEMORY,
            {"action": "add", "target": "memory", "content": "PRIVATE"},
            summary="must fail",
            origin="foreground",
        )
    from pathlib import Path

    pending_root = Path(hermes_home) / "pending"
    assert not pending_root.exists() or not list(pending_root.rglob("*.json"))


@pytest.mark.skipif(os.name != "nt", reason="requires native Windows security APIs")
def test_native_windows_owner_only_acl_lifecycle(hermes_home):
    from tools import write_approval as wa

    rec = wa.stage_write(
        wa.MEMORY,
        {"action": "add", "target": "memory", "content": "PRIVATE"},
        summary="native Windows ACL",
        origin="foreground",
    )
    pending_path = wa._pending_dir(wa.MEMORY) / f"{rec['id']}.json"
    wa._restrict_windows_acl(pending_path)  # applies and reads back the DACL


def test_stage_write_fails_closed_without_lock_backend(hermes_home, monkeypatch):
    from tools import write_approval as wa

    monkeypatch.setattr(wa, "fcntl", None)
    monkeypatch.setattr(wa, "msvcrt", None)

    with pytest.raises(wa.StagingError):
        wa.stage_write(
            wa.MEMORY,
            {"action": "add", "target": "memory", "content": "blocked"},
            summary="blocked",
            origin="foreground",
        )

    assert wa.list_pending(wa.MEMORY) == []


def test_new_state_directories_fsync_each_parent(hermes_home, monkeypatch):
    from tools import write_approval as wa

    synced = []
    original = wa._fsync_dir

    def record_fsync(path):
        synced.append(path)
        return original(path)

    monkeypatch.setattr(wa, "_fsync_dir", record_fsync)
    wa.stage_write(
        wa.MEMORY,
        {"action": "add", "target": "memory", "content": "durable"},
        summary="durable",
        origin="foreground",
    )
    home = wa.get_hermes_home()

    assert home in synced
    assert home / "pending" in synced
    assert home / "pending" / "locks" in synced


def test_private_state_permissions_ignore_permissive_umask(hermes_home):
    if os.name == "nt":
        pytest.skip("POSIX mode bits are not Windows ACLs")

    from pathlib import Path
    from tools import write_approval as wa

    previous_umask = os.umask(0o022)
    try:
        rec = wa.stage_write(
            wa.MEMORY,
            {"action": "add", "target": "memory", "content": "PRIVATE"},
            summary="private modes",
            origin="foreground",
        )
        pending_path = wa._pending_dir(wa.MEMORY) / f"{rec['id']}.json"
        assert pending_path.stat().st_mode & 0o777 == 0o600

        status, claim = wa.claim_pending(wa.MEMORY, rec["id"], "reject")
        assert status == "claimed"
        assert claim is not None
        claim_path = wa._claim_dir(wa.MEMORY) / f"{rec['id']}.json"
        assert claim_path.stat().st_mode & 0o777 == 0o600
        assert wa.finish_pending_claim(
            wa.MEMORY, rec["id"], "reject", claim["_claim_nonce"]
        )

        receipt_path = wa._receipt_dir(wa.MEMORY) / f"{rec['id']}.json"
        lock_path = wa._lock_dir(wa.MEMORY) / f"{rec['id']}.lock"
        assert receipt_path.stat().st_mode & 0o777 == 0o600
        assert lock_path.stat().st_mode & 0o777 == 0o600
        pending_root = Path(hermes_home) / "pending"
        assert all(
            path.stat().st_mode & 0o777 == 0o700
            for path in [pending_root, *(p for p in pending_root.rglob("*") if p.is_dir())]
        )
    finally:
        os.umask(previous_umask)


@pytest.mark.parametrize("operation", ["list", "get", "count", "resolve"])
def test_legacy_permissive_state_is_migrated_before_access(
    hermes_home, operation
):
    if os.name == "nt":
        pytest.skip("POSIX legacy-mode migration")

    import json
    from pathlib import Path
    from tools import write_approval as wa

    root = Path(hermes_home) / "pending"
    directories = [
        root,
        root / wa.MEMORY,
        root / "claims" / wa.MEMORY,
        root / "receipts" / wa.MEMORY,
        root / "locks" / wa.MEMORY,
    ]
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(0o755)
    pending_id = "legacy"
    pending_path = root / wa.MEMORY / f"{pending_id}.json"
    pending_path.write_text(
        json.dumps(
            {
                "id": pending_id,
                "subsystem": wa.MEMORY,
                "action": "add",
                "summary": "legacy private payload",
                "origin": "foreground",
                "created_at": 1,
                "payload": {"content": "LEGACY SECRET"},
            }
        ),
        encoding="utf-8",
    )
    legacy_lock = root / "locks" / wa.MEMORY / "legacy.lock"
    legacy_lock.write_text("", encoding="utf-8")
    pending_path.chmod(0o644)
    legacy_lock.chmod(0o644)

    if operation == "list":
        assert wa.list_pending(wa.MEMORY)[0]["id"] == pending_id
    elif operation == "get":
        assert wa.get_pending(wa.MEMORY, pending_id)["id"] == pending_id
    elif operation == "count":
        assert wa.pending_count(wa.MEMORY) == 1
    else:
        status, claim = wa.claim_pending(wa.MEMORY, pending_id, "reject")
        assert status == "claimed"
        assert claim is not None

    assert all(path.stat().st_mode & 0o777 == 0o700 for path in directories)
    assert all(
        path.stat().st_mode & 0o777 == 0o600
        for path in root.rglob("*")
        if path.is_file()
    )


def test_legacy_state_symlink_fails_closed(hermes_home, tmp_path):
    from pathlib import Path
    from tools import write_approval as wa

    root = Path(hermes_home) / "pending"
    (root / wa.MEMORY).mkdir(parents=True)
    outside = tmp_path / "outside.json"
    outside.write_text('{"payload": "SECRET"}', encoding="utf-8")
    (root / wa.MEMORY / "escape.json").symlink_to(outside)

    with pytest.raises(RuntimeError, match="redirect"):
        wa.list_pending(wa.MEMORY)
    assert outside.read_text(encoding="utf-8") == '{"payload": "SECRET"}'


def test_simulated_windows_junction_is_rejected_before_descent_or_creation(
    hermes_home, monkeypatch
):
    from pathlib import Path
    from tools import write_approval as wa

    pending_root = Path(hermes_home) / "pending"
    junction = pending_root / wa.MEMORY
    junction.mkdir(parents=True)
    (junction / "outside.json").write_text('{"id": "outside"}', encoding="utf-8")
    secured = []

    monkeypatch.setattr(
        Path,
        "is_junction",
        lambda self: self == junction,
        raising=False,
    )
    monkeypatch.setattr(wa, "_WINDOWS", True)
    monkeypatch.setattr(wa, "_restrict_windows_acl", lambda path: secured.append(path))

    with pytest.raises(RuntimeError, match="redirect"):
        wa.list_pending(wa.MEMORY)
    assert junction not in secured
    assert junction / "outside.json" not in secured

    with pytest.raises(RuntimeError, match="unsafe approval-state directory"):
        wa._ensure_dir(junction / "child")
    assert not (junction / "child").exists()


@pytest.mark.skipif(os.name != "nt", reason="native Windows junction semantics")
@pytest.mark.parametrize("at_root", [True, False])
def test_native_windows_junction_fails_closed_without_target_acl_change(
    hermes_home, tmp_path, at_root
):
    import subprocess
    from pathlib import Path
    from tools import write_approval as wa

    target = tmp_path / ("root-target" if at_root else "nested-target")
    target.mkdir()
    secret = target / "secret.txt"
    secret.write_text("DO NOT TOUCH", encoding="utf-8")
    pending_root = Path(hermes_home) / "pending"
    if at_root:
        junction = pending_root
    else:
        pending_root.mkdir()
        junction = pending_root / wa.MEMORY
    made = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(junction), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    if made.returncode != 0:
        pytest.skip(f"could not create test junction: {made.stderr.strip()}")
    before = subprocess.run(
        ["icacls", str(target)], capture_output=True, text=True, check=True
    ).stdout

    with pytest.raises(RuntimeError, match="approval-state"):
        wa.list_pending(wa.MEMORY)

    after = subprocess.run(
        ["icacls", str(target)], capture_output=True, text=True, check=True
    ).stdout
    assert after == before
    assert secret.read_text(encoding="utf-8") == "DO NOT TOUCH"


def test_legacy_windows_acl_migration_covers_directories_and_files(
    hermes_home, monkeypatch
):
    from pathlib import Path
    from tools import write_approval as wa

    root = Path(hermes_home) / "pending"
    pending_dir = root / wa.MEMORY
    pending_dir.mkdir(parents=True)
    payload = pending_dir / "legacy.json"
    payload.write_text('{"id": "legacy", "created_at": 1}', encoding="utf-8")
    secured = []
    monkeypatch.setattr(wa, "_WINDOWS", True)
    monkeypatch.setattr(wa, "_restrict_windows_acl", lambda path: secured.append(path))

    assert wa.pending_count(wa.MEMORY) == 1
    assert root in secured
    assert pending_dir in secured
    assert payload in secured


def test_legacy_windows_acl_migration_failure_blocks_access(
    hermes_home, monkeypatch
):
    from pathlib import Path
    from tools import write_approval as wa

    root = Path(hermes_home) / "pending" / wa.MEMORY
    root.mkdir(parents=True)
    (root / "legacy.json").write_text('{"id": "legacy"}', encoding="utf-8")
    monkeypatch.setattr(wa, "_WINDOWS", True)
    monkeypatch.setattr(
        wa,
        "_restrict_windows_acl",
        lambda _path: (_ for _ in ()).throw(PermissionError("ACL denied")),
    )

    with pytest.raises(PermissionError, match="ACL denied"):
        wa.list_pending(wa.MEMORY)
    with pytest.raises(PermissionError, match="ACL denied"):
        wa.get_pending(wa.MEMORY, "legacy")
    with pytest.raises(PermissionError, match="ACL denied"):
        wa.pending_count(wa.MEMORY)


def test_concurrent_directory_creator_still_fsyncs_parent(hermes_home, monkeypatch):
    from pathlib import Path
    from tools import write_approval as wa

    target = wa.get_hermes_home() / "pending"
    original_mkdir = Path.mkdir
    original_fsync = wa._fsync_dir
    synced = []
    raced = False

    def racing_mkdir(path, *args, **kwargs):
        nonlocal raced
        if path == target and not raced:
            raced = True
            original_mkdir(path, *args, **kwargs)
            raise FileExistsError(path)
        return original_mkdir(path, *args, **kwargs)

    def record_fsync(path):
        synced.append(path)
        return original_fsync(path)

    monkeypatch.setattr(Path, "mkdir", racing_mkdir)
    monkeypatch.setattr(wa, "_fsync_dir", record_fsync)

    wa._ensure_dir(wa._lock_dir(wa.MEMORY))

    assert raced is True
    assert wa.get_hermes_home() in synced


# ---------------------------------------------------------------------------
# Shared command handler
# ---------------------------------------------------------------------------

def test_handle_pending_list_empty(hermes_home):
    from hermes_cli.write_approval_commands import handle_pending_subcommand
    from tools import write_approval as wa
    out = handle_pending_subcommand(wa.MEMORY, ["pending"])
    assert "No pending memory" in out


def test_handle_approve_all(hermes_home):
    from hermes_cli.write_approval_commands import handle_pending_subcommand
    from tools.memory_tool import MemoryStore
    from tools import write_approval as wa
    store = MemoryStore(); store.load_from_disk()
    wa.stage_write("memory", {"action": "add", "target": "user", "content": "a"},
                   summary="a", origin="foreground")
    wa.stage_write("memory", {"action": "add", "target": "user", "content": "b"},
                   summary="b", origin="foreground")
    out = handle_pending_subcommand(wa.MEMORY, ["approve", "all"], memory_store=store)
    assert "Approved 2" in out
    assert wa.pending_count("memory") == 0
    assert len(store.user_entries) == 2


def test_handle_reject(hermes_home):
    from hermes_cli.write_approval_commands import handle_pending_subcommand
    from tools import write_approval as wa
    rec = wa.stage_write("skills", {"action": "create", "name": "s"},
                         summary="create s", origin="background_review")
    out = handle_pending_subcommand(wa.SKILLS, ["reject", rec["id"]])
    assert "Rejected" in out
    assert wa.pending_count("skills") == 0


def test_handle_single_approve_uses_atomic_resolver(hermes_home, monkeypatch):
    from hermes_cli import write_approval_commands as commands
    from tools import write_approval as wa

    rec = wa.stage_write(
        "memory",
        {"action": "add", "target": "user", "content": "private"},
        summary="private",
        origin="foreground",
    )
    calls = []

    def fake_resolve(subsystem, pending_id, decision, *, memory_store=None):
        calls.append((subsystem, pending_id, decision, memory_store))
        return {
            "success": True,
            "subsystem": subsystem,
            "pending_id": pending_id,
            "decision": decision,
        }

    monkeypatch.setattr(commands, "resolve_pending_write", fake_resolve)
    store = object()
    out = commands.handle_pending_subcommand(
        wa.MEMORY,
        ["approve", rec["id"]],
        memory_store=store,
    )

    assert out is not None
    assert "Approved 1" in out
    assert calls == [(wa.MEMORY, rec["id"], "approve", store)]


def test_handle_single_reject_uses_atomic_resolver(hermes_home, monkeypatch):
    from hermes_cli import write_approval_commands as commands
    from tools import write_approval as wa

    rec = wa.stage_write(
        "skills",
        {"action": "create", "name": "private-skill"},
        summary="private",
        origin="foreground",
    )
    calls = []

    def fake_resolve(subsystem, pending_id, decision, *, memory_store=None):
        calls.append((subsystem, pending_id, decision, memory_store))
        return {
            "success": True,
            "subsystem": subsystem,
            "pending_id": pending_id,
            "decision": decision,
        }

    monkeypatch.setattr(commands, "resolve_pending_write", fake_resolve)
    out = commands.handle_pending_subcommand(
        wa.SKILLS,
        ["reject", rec["id"]],
    )

    assert out is not None
    assert "Rejected" in out
    assert calls == [(wa.SKILLS, rec["id"], "reject", None)]


def test_atomic_resolution_acknowledges_matching_retry_without_reapplying(
    hermes_home, monkeypatch
):
    from hermes_cli import write_approval_commands as commands
    from tools import write_approval as wa

    rec = wa.stage_write(
        "skills", {"action": "create", "name": "secret", "content": "PRIVATE"},
        summary="create secret", origin="foreground"
    )
    calls = []
    monkeypatch.setattr(
        commands,
        "_apply_one",
        lambda subsystem, record, store: calls.append(record["id"])
        or (True, "", True),
    )

    first = commands.resolve_pending_write("skills", rec["id"], "approve")
    retry = commands.resolve_pending_write("skills", rec["id"], "approve")
    conflict = commands.resolve_pending_write("skills", rec["id"], "reject")

    assert first == retry == {
        "success": True,
        "subsystem": "skills",
        "pending_id": rec["id"],
        "decision": "approve",
    }
    assert calls == [rec["id"]]
    assert conflict == {"success": False, "error": "decision_conflict"}
    receipt = wa.get_resolution_receipt("skills", rec["id"])
    assert receipt == {
        "subsystem": "skills",
        "pending_id": rec["id"],
        "decision": "approve",
    }
    assert "PRIVATE" not in json.dumps(receipt)


def test_atomic_resolution_restores_pending_when_apply_fails(hermes_home, monkeypatch):
    from hermes_cli import write_approval_commands as commands
    from tools import write_approval as wa

    rec = wa.stage_write(
        "skills", {"action": "create", "name": "retry-me"},
        summary="create retry-me", origin="foreground"
    )
    monkeypatch.setattr(
        commands, "_apply_one", lambda *_args: (False, "boom", True)
    )

    result = commands.resolve_pending_write("skills", rec["id"], "approve")

    assert result == {"success": False, "error": "apply_failed"}
    assert wa.get_pending("skills", rec["id"]) is not None
    assert wa.get_resolution_receipt("skills", rec["id"]) is None


def test_opposing_decision_against_active_claim_is_retryable(
    hermes_home,
):
    from hermes_cli import write_approval_commands as commands
    from tools import write_approval as wa

    rec = wa.stage_write(
        "skills",
        {"action": "create", "name": "retry-opposition"},
        summary="create retry-opposition",
        origin="foreground",
    )
    status, claimed = wa.claim_pending("skills", rec["id"], "approve")
    assert status == "claimed"
    assert claimed is not None

    opposing = commands.resolve_pending_write("skills", rec["id"], "reject")
    assert opposing == {"success": False, "error": "in_progress"}

    assert wa.restore_pending_claim(
        "skills", rec["id"], claimed["_claim_nonce"]
    )
    retry = commands.resolve_pending_write("skills", rec["id"], "reject")
    assert retry == {
        "success": True,
        "subsystem": "skills",
        "pending_id": rec["id"],
        "decision": "reject",
    }


def test_fresh_claim_is_in_progress_and_stale_matching_claim_is_reclaimed(
    hermes_home,
):
    from tools import write_approval as wa

    rec = wa.stage_write(
        "skills",
        {"action": "create", "name": "private", "content": "PRIVATE"},
        summary="create private",
        origin="foreground",
    )
    status, _ = wa.claim_pending("skills", rec["id"], "approve", now=1_000.0)
    fresh, fresh_record = wa.claim_pending(
        "skills",
        rec["id"],
        "approve",
        now=1_000.0 + wa.CLAIM_STALE_AFTER_SECONDS - 1,
    )
    stale, stale_record = wa.claim_pending(
        "skills",
        rec["id"],
        "approve",
        now=1_000.0 + wa.CLAIM_STALE_AFTER_SECONDS + 1,
    )

    assert status == "claimed"
    assert (fresh, fresh_record) == ("in_progress", None)
    assert stale == "claimed"
    assert stale_record is not None
    assert stale_record["payload"]["content"] == "PRIVATE"


def test_stale_applying_claim_is_never_replayed(hermes_home):
    from tools import write_approval as wa

    rec = wa.stage_write(
        "memory",
        {"action": "add", "target": "memory", "content": "PRIVATE"},
        summary="private",
        origin="foreground",
    )
    status, claimed = wa.claim_pending("memory", rec["id"], "approve", now=100.0)
    assert status == "claimed"
    assert claimed is not None
    nonce = claimed["_claim_nonce"]
    assert wa.mark_claim_applying("memory", rec["id"], "approve", nonce)

    replay, replay_record = wa.claim_pending(
        "memory",
        rec["id"],
        "approve",
        now=100.0 + wa.CLAIM_STALE_AFTER_SECONDS + 1,
    )

    assert (replay, replay_record) == ("in_progress", None)
    claim = json.loads(
        (wa._claim_dir("memory") / f"{rec['id']}.json").read_text(encoding="utf-8")
    )
    assert claim["_claim_phase"] == "applying"


def test_receipt_failure_does_not_reapply_approved_write(
    hermes_home, monkeypatch
):
    from hermes_cli import write_approval_commands as commands
    from tools import write_approval as wa

    rec = wa.stage_write(
        "skills",
        {"action": "create", "name": "private"},
        summary="private",
        origin="foreground",
    )
    calls = []
    monkeypatch.setattr(
        commands,
        "_apply_one",
        lambda *_args: calls.append("apply") or (True, "", True),
    )
    monkeypatch.setattr(wa, "finish_pending_claim", lambda *_args, **_kwargs: False)

    first = commands.resolve_pending_write("skills", rec["id"], "approve")
    retry = commands.resolve_pending_write("skills", rec["id"], "approve")

    assert first == {"success": False, "error": "resolution_persist_failed"}
    assert retry == {"success": False, "error": "in_progress"}
    assert calls == ["apply"]


def test_concurrent_resolvers_apply_exactly_once(hermes_home, monkeypatch):
    from hermes_cli import write_approval_commands as commands
    from tools import write_approval as wa

    rec = wa.stage_write(
        "skills",
        {"action": "create", "name": "private"},
        summary="private",
        origin="foreground",
    )
    entered = threading.Event()
    release = threading.Event()
    calls = []
    results = []

    def apply_once(_subsystem, record, _store):
        calls.append(record["id"])
        entered.set()
        assert release.wait(timeout=5)
        return True, "", True

    monkeypatch.setattr(commands, "_apply_one", apply_once)
    first = threading.Thread(
        target=lambda: results.append(
            commands.resolve_pending_write("skills", rec["id"], "approve")
        )
    )
    first.start()
    assert entered.wait(timeout=5)
    second = commands.resolve_pending_write("skills", rec["id"], "approve")
    release.set()
    first.join(timeout=5)

    assert calls == [rec["id"]]
    assert second == {"success": False, "error": "in_progress"}
    assert results == [
        {
            "success": True,
            "subsystem": "skills",
            "pending_id": rec["id"],
            "decision": "approve",
        }
    ]


def test_stage_write_skips_ids_used_by_pending_claims_and_receipts(
    hermes_home, monkeypatch
):
    from tools import write_approval as wa

    ids = ["1" * 32, "2" * 32, "3" * 32, "4" * 32]
    wa._pending_dir("memory").mkdir(parents=True, exist_ok=True)
    wa._claim_dir("memory").mkdir(parents=True, exist_ok=True)
    wa._receipt_dir("memory").mkdir(parents=True, exist_ok=True)
    (wa._pending_dir("memory") / f"{ids[0]}.json").write_text("{}", encoding="utf-8")
    (wa._claim_dir("memory") / f"{ids[1]}.json").write_text("{}", encoding="utf-8")
    (wa._receipt_dir("memory") / f"{ids[2]}.json").write_text("{}", encoding="utf-8")
    generated = iter(ids)
    monkeypatch.setattr(wa.uuid, "uuid4", lambda: SimpleNamespace(hex=next(generated)))

    rec = wa.stage_write(
        "memory",
        {"action": "add", "target": "memory", "content": "safe"},
        summary="safe",
        origin="foreground",
    )

    assert rec["id"] == ids[3]
    assert len(rec["id"]) == 32
    assert wa.get_pending("memory", ids[3]) is not None


def test_stale_claim_with_opposing_decision_remains_in_progress(hermes_home):
    from tools import write_approval as wa

    rec = wa.stage_write(
        "memory",
        {"action": "add", "target": "memory", "content": "PRIVATE"},
        summary="private",
        origin="foreground",
    )
    assert wa.claim_pending("memory", rec["id"], "approve", now=100.0)[0] == "claimed"

    status, record = wa.claim_pending(
        "memory",
        rec["id"],
        "reject",
        now=100.0 + wa.CLAIM_STALE_AFTER_SECONDS + 1,
    )

    assert (status, record) == ("in_progress", None)


def test_stale_claim_falls_back_to_controlled_file_mtime(hermes_home):
    from tools import write_approval as wa

    rec = wa.stage_write(
        "skills",
        {"action": "delete", "name": "private"},
        summary="delete private",
        origin="foreground",
    )
    status, _ = wa.claim_pending("skills", rec["id"], "reject", now=500.0)
    assert status == "claimed"
    claim_path = wa._claim_dir("skills") / f"{rec['id']}.json"
    record = json.loads(claim_path.read_text(encoding="utf-8"))
    record.pop("_claimed_at")
    claim_path.write_text(json.dumps(record), encoding="utf-8")
    old_mtime = 500.0 - wa.CLAIM_STALE_AFTER_SECONDS - 1
    os.utime(claim_path, (old_mtime, old_mtime))

    reclaimed, private_record = wa.claim_pending(
        "skills", rec["id"], "reject", now=500.0
    )

    assert reclaimed == "claimed"
    assert private_record is not None
    assert private_record["id"] == rec["id"]


def test_atomic_resolution_validates_all_structured_fields(hermes_home):
    from hermes_cli.write_approval_commands import resolve_pending_write

    assert resolve_pending_write("other", "safe", "approve")["error"] == "invalid_request"
    assert resolve_pending_write("memory", "../unsafe", "approve")["error"] == "invalid_request"
    assert resolve_pending_write("memory", "safe", "other")["error"] == "invalid_request"


def test_handle_approval_on(hermes_home):
    from hermes_cli.write_approval_commands import handle_pending_subcommand
    from tools import write_approval as wa
    captured = {}
    out = handle_pending_subcommand(
        wa.MEMORY, ["approval", "on"],
        set_mode_fn=lambda enabled: captured.update(enabled=enabled),
    )
    assert captured["enabled"] is True
    assert "on" in out


def test_handle_approval_off(hermes_home):
    from hermes_cli.write_approval_commands import handle_pending_subcommand
    from tools import write_approval as wa
    captured = {}
    out = handle_pending_subcommand(
        wa.SKILLS, ["approval", "off"],
        set_mode_fn=lambda enabled: captured.update(enabled=enabled),
    )
    assert captured["enabled"] is False
    assert "off" in out


def test_handle_mode_alias_still_works(hermes_home):
    # 'mode' is kept as a back-compat alias for 'approval'.
    from hermes_cli.write_approval_commands import handle_pending_subcommand
    from tools import write_approval as wa
    captured = {}
    out = handle_pending_subcommand(
        wa.MEMORY, ["mode", "on"],
        set_mode_fn=lambda enabled: captured.update(enabled=enabled),
    )
    assert captured["enabled"] is True
    assert "on" in out


def test_handle_approval_invalid(hermes_home):
    from hermes_cli.write_approval_commands import handle_pending_subcommand
    from tools import write_approval as wa
    out = handle_pending_subcommand(wa.MEMORY, ["approval", "bogus"],
                                    set_mode_fn=lambda enabled: None)
    assert "Invalid value" in out


def test_handle_unknown_subcommand_returns_none(hermes_home):
    from hermes_cli.write_approval_commands import handle_pending_subcommand
    from tools import write_approval as wa
    # An unrecognized /skills subcommand (e.g. 'search') must return None so
    # the CLI falls through to the skills hub.
    out = handle_pending_subcommand(wa.SKILLS, ["search", "foo"])
    assert out is None


# ---------------------------------------------------------------------------
# Inline (interactive CLI) approval path — regression for the bug where the
# per-thread approval callback was never passed to prompt_dangerous_approval,
# so every gated foreground memory write was silently denied.
# ---------------------------------------------------------------------------

@pytest.fixture
def approval_callback_cleanup():
    yield
    from tools.terminal_tool import set_approval_callback
    set_approval_callback(None)


def test_memory_inline_approve_writes(hermes_home, approval_callback_cleanup):
    from tools.memory_tool import memory_tool, MemoryStore
    from tools.terminal_tool import set_approval_callback
    from tools import write_approval as wa
    _set_approval("memory", True)

    calls = []
    def approve_cb(command, description, **kw):
        calls.append((command, description))
        return "once"
    set_approval_callback(approve_cb)

    store = MemoryStore(); store.load_from_disk()
    r = json.loads(memory_tool("add", "memory", "approved fact", store=store))
    assert r["success"] is True
    assert r.get("staged") is None  # real write, not staged
    assert store.memory_entries == ["approved fact"]
    assert wa.pending_count("memory") == 0
    # The registered callback must actually be invoked (not the input() path).
    assert len(calls) == 1
    assert "approved fact" in calls[0][0]


def test_memory_inline_deny_blocks(hermes_home, approval_callback_cleanup):
    from tools.memory_tool import memory_tool, MemoryStore
    from tools.terminal_tool import set_approval_callback
    from tools import write_approval as wa
    _set_approval("memory", True)
    set_approval_callback(lambda command, description, **kw: "deny")

    store = MemoryStore(); store.load_from_disk()
    r = json.loads(memory_tool("add", "memory", "denied fact", store=store))
    assert r["success"] is False
    assert "denied" in r["error"].lower()
    assert store.memory_entries == []
    assert wa.pending_count("memory") == 0  # denied, not staged


def test_memory_inline_callback_error_stages(hermes_home, approval_callback_cleanup):
    # If the prompt machinery fails, fall back to staging — never drop silently.
    from tools.memory_tool import memory_tool, MemoryStore
    from tools.terminal_tool import set_approval_callback
    from tools import write_approval as wa
    _set_approval("memory", True)
    def broken_cb(command, description, **kw):
        raise RuntimeError("boom")
    set_approval_callback(broken_cb)

    store = MemoryStore(); store.load_from_disk()
    r = json.loads(memory_tool("add", "memory", "fallback fact", store=store))
    assert r.get("staged") is True
    assert wa.pending_count("memory") == 1


def test_gateway_context_stages_not_prompts(hermes_home, monkeypatch):
    # A gateway session has no per-thread CLI callback; the dangerous-command
    # /approve round-trip lives in the pending-queue machinery which the gate
    # does not use. The gate must stage, never attempt an inline prompt
    # (which would hit the input() fallback and silently deny).
    from tools.memory_tool import memory_tool, MemoryStore
    from tools import write_approval as wa
    _set_approval("memory", True)
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")

    store = MemoryStore(); store.load_from_disk()
    r = json.loads(memory_tool("add", "memory", "gateway fact", store=store))
    assert r.get("staged") is True
    assert store.memory_entries == []
    assert wa.pending_count("memory") == 1


def test_skills_never_prompt_inline_even_with_callback(hermes_home, approval_callback_cleanup):
    # Skills always stage — even when an interactive callback is registered.
    from tools.skill_manager_tool import skill_manage
    from tools.terminal_tool import set_approval_callback
    from tools import write_approval as wa
    _set_approval("skills", True)

    calls = []
    set_approval_callback(lambda c, d, **kw: calls.append(1) or "once")

    r = json.loads(skill_manage(
        action="create", name="test-inline-skill",
        content="---\nname: test-inline-skill\ndescription: x\n---\nbody\n"))
    assert r.get("staged") is True
    assert calls == []  # never prompted
    assert wa.pending_count("skills") == 1


def test_memory_invalid_params_rejected_before_staging(hermes_home):
    # Param validation must run BEFORE the gate so a broken write is rejected
    # immediately instead of staged and failing at approve time.
    from tools.memory_tool import memory_tool, MemoryStore
    from tools import write_approval as wa
    _set_approval("memory", True)
    store = MemoryStore(); store.load_from_disk()
    r = json.loads(memory_tool("add", "memory", None, store=store))
    assert r["success"] is False
    assert wa.pending_count("memory") == 0


class TestSkillGist:
    """skill_gist builds a heuristic one-line summary for a pending skill write.

    Pure, no model call — every branch is verifiable from the function source.
    """

    def test_create_with_frontmatter_description(self):
        from tools import write_approval as wa
        content = "---\ndescription: My cool skill\n---\nprint('hi')\n"
        assert (
            wa.skill_gist("create", "demo", content=content)
            == f"create 'demo' — My cool skill ({len(content)} chars)"
        )

    def test_edit_without_description_uses_size_only(self):
        from tools import write_approval as wa
        content = "no frontmatter here"
        assert (
            wa.skill_gist("edit", "demo", content=content)
            == f"rewrite 'demo' ({len(content)} chars)"
        )

    def test_large_content_reports_kb(self):
        from tools import write_approval as wa
        content = "x" * 2048  # >= 1024 bytes -> KB rounding
        assert wa.skill_gist("create", "big", content=content) == "create 'big' (3 KB)"

    def test_create_without_content_falls_through(self):
        from tools import write_approval as wa
        assert wa.skill_gist("create", "demo") == "create 'demo'"

    def test_patch_counts_lines(self):
        from tools import write_approval as wa
        assert (
            wa.skill_gist("patch", "demo", file_path="SKILL.md",
                          old_string="a\nb", new_string="x\ny\nz")
            == "patch 'demo' SKILL.md (+3/-2 lines)"
        )

    def test_patch_defaults_target_and_empty_strings(self):
        from tools import write_approval as wa
        assert wa.skill_gist("patch", "demo") == "patch 'demo' SKILL.md (+0/-0 lines)"

    def test_file_actions_and_unknown_fallback(self):
        from tools import write_approval as wa
        assert wa.skill_gist("write_file", "demo", file_path="a.py") == "write a.py in 'demo'"
        assert wa.skill_gist("remove_file", "demo", file_path="a.py") == "remove a.py from 'demo'"
        assert wa.skill_gist("delete", "demo") == "delete skill 'demo'"
        assert wa.skill_gist("unknown", "demo") == "unknown 'demo'"
