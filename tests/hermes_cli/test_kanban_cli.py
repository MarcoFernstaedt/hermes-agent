"""Tests for the kanban CLI surface (hermes_cli.kanban)."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from hermes_cli import kanban as kc
from hermes_cli import kanban_db as kb


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _file_snapshot(root: Path) -> dict[str, tuple[bool, bytes]]:
    return {
        str(path.relative_to(root)): (
            path.is_dir(),
            b"" if path.is_dir() else path.read_bytes(),
        )
        for path in sorted(root.rglob("*"))
    }


# ---------------------------------------------------------------------------
# Workspace flag parsing
# ---------------------------------------------------------------------------







# ---------------------------------------------------------------------------
# run_slash smoke tests (end-to-end via the same entry both CLI and gateway use)
# ---------------------------------------------------------------------------



def test_kanban_list_json_includes_session_id(kanban_home):
    """JSON output exposes `session_id` so external clients (Scarf, web
    dashboards) don't need a side query to filter by chat session."""
    from hermes_cli import kanban_db as kb
    with kb.connect() as conn:
        kb.create_task(
            conn, title="acp task", assignee="alice", session_id="acp-x"
        )
    raw = kc.run_slash("list --json")
    payload = json.loads(raw)
    assert any(
        row.get("title") == "acp task"
        and row.get("session_id") == "acp-x"
        for row in payload
    )


def test_worker_slash_create_denies_before_db_or_workspace_access(
    monkeypatch,
    tmp_path,
):
    home = tmp_path / ".hermes"
    home.mkdir()
    (home / "config.yaml").write_text(
        "kanban:\n  worker_allow_create: false\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_assigned")

    def forbidden_init_db(*_args, **_kwargs):
        raise AssertionError("worker create denial must happen before DB access")

    monkeypatch.setattr(kb, "init_db", forbidden_init_db)
    before = {path.relative_to(home) for path in home.rglob("*")}

    output = kc.run_slash("create 'forbidden task' --assignee peer --json")

    assert "worker_allow_create" in output
    assert {path.relative_to(home) for path in home.rglob("*")} == before


@pytest.mark.parametrize(
    ("command", "capability", "handler_name"),
    [
        ("link t_parent t_child", "kanban_link", "_cmd_link"),
        ("decompose t_root", "kanban_decompose", "_cmd_decompose"),
        (
            "swarm goal --worker peer:work --verifier verify --synthesizer synth",
            "kanban_swarm",
            "_cmd_swarm",
        ),
    ],
)
def test_worker_slash_routing_commands_deny_without_fresh_home_side_effects(
    monkeypatch,
    tmp_path,
    command,
    capability,
    handler_name,
):
    home = tmp_path / ".hermes"
    home.mkdir()
    (home / "config.yaml").write_text(
        "kanban:\n  worker_allow_create: false\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_assigned")

    def forbidden_dispatch(*_args, **_kwargs):
        raise AssertionError("worker denial must precede DB init and handler dispatch")

    monkeypatch.setattr(kb, "init_db", forbidden_dispatch)
    monkeypatch.setattr(kc, handler_name, forbidden_dispatch)
    before = _file_snapshot(home)

    output = kc.run_slash(command)

    assert output == (
        f"kanban: {capability} refused: this dispatcher-spawned worker profile "
        "does not allow routing mutations under kanban.worker_allow_create"
    )
    assert _file_snapshot(home) == before


def test_worker_cli_swarm_denies_before_board_bootstrap_or_handler_dispatch(
    monkeypatch,
    tmp_path,
    capsys,
):
    home = tmp_path / ".hermes"
    home.mkdir()
    (home / "config.yaml").write_text(
        "kanban:\n  worker_allow_create: false\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_assigned")

    def forbidden_dispatch(*_args, **_kwargs):
        raise AssertionError("worker swarm denial must precede Kanban bootstrap")

    monkeypatch.setattr(kb, "init_db", forbidden_dispatch)
    monkeypatch.setattr(kc, "_cmd_swarm", forbidden_dispatch)
    parser = argparse.ArgumentParser(prog="hermes", add_help=False)
    sub = parser.add_subparsers(dest="command")
    kc.build_parser(sub)
    args = parser.parse_args(
        [
            "kanban",
            "swarm",
            "goal",
            "--worker",
            "peer:work",
            "--verifier",
            "verify",
            "--synthesizer",
            "synth",
        ]
    )
    before = _file_snapshot(home)

    rc = kc.kanban_command(args)

    captured = capsys.readouterr()
    assert rc == 1
    assert captured.err == (
        "kanban: kanban_swarm refused: this dispatcher-spawned worker profile "
        "does not allow routing mutations under kanban.worker_allow_create\n"
    )
    assert _file_snapshot(home) == before


def test_worker_full_cli_swarm_creates_no_kanban_state_before_denial(tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    (home / "config.yaml").write_text(
        "kanban:\n  worker_allow_create: false\n",
        encoding="utf-8",
    )
    env = os.environ.copy()
    env["HERMES_HOME"] = str(home)
    env["HERMES_KANBAN_TASK"] = "t_assigned"
    env.pop("HERMES_MANAGED_DIR", None)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "hermes_cli.main",
            "kanban",
            "swarm",
            "goal",
            "--worker",
            "peer:work",
            "--verifier",
            "verify",
            "--synthesizer",
            "synth",
        ],
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 1
    assert "kanban_swarm refused" in result.stderr
    assert not (home / "kanban.db").exists()
    assert not (home / "kanban").exists()


@pytest.mark.parametrize(
    ("handler", "args", "capability"),
    [
        (kc._cmd_link, argparse.Namespace(parent_id="p", child_id="c"), "kanban_link"),
        (kc._cmd_decompose, argparse.Namespace(), "kanban_decompose"),
        (
            kc._cmd_swarm,
            argparse.Namespace(),
            "kanban_swarm",
        ),
    ],
)
def test_direct_worker_routing_handlers_translate_policy_before_state_access(
    monkeypatch,
    tmp_path,
    capsys,
    handler,
    args,
    capability,
):
    home = tmp_path / ".hermes"
    home.mkdir()
    (home / "config.yaml").write_text(
        "kanban:\n  worker_allow_create: false\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_assigned")
    before = _file_snapshot(home)

    rc = handler(args)

    captured = capsys.readouterr()
    assert rc == 1
    assert captured.err == (
        f"kanban: {capability} refused: this dispatcher-spawned worker profile "
        "does not allow routing mutations under kanban.worker_allow_create\n"
    )
    assert _file_snapshot(home) == before


@pytest.mark.parametrize("action", ["create", "link"])
def test_direct_routing_handlers_translate_lower_policy_denial(
    kanban_home,
    monkeypatch,
    capsys,
    action,
):
    with kb.connect_closing() as conn:
        parent = kb.create_task(conn, title="parent", assignee="operator")
        child = kb.create_task(conn, title="child", assignee="operator")
        before_tasks = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        before_links = conn.execute("SELECT COUNT(*) FROM task_links").fetchone()[0]

    (kanban_home / "config.yaml").write_text(
        "kanban:\n  worker_allow_create: false\n", encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_assigned")
    monkeypatch.setattr(kc, "worker_kanban_routing_allowed", lambda: True)

    parser = argparse.ArgumentParser(prog="hermes", add_help=False)
    sub = parser.add_subparsers(dest="command")
    kc.build_parser(sub)
    if action == "create":
        args = parser.parse_args(["kanban", "create", "forbidden child"])
        rc = kc._cmd_create(args)
    else:
        args = parser.parse_args(["kanban", "link", parent, child])
        rc = kc._cmd_link(args)

    captured = capsys.readouterr()
    assert rc == 1
    assert captured.err.startswith(f"kanban: kanban_{action} refused:")
    assert "Traceback" not in captured.err
    with kb.connect_closing() as conn:
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == before_tasks
        assert conn.execute("SELECT COUNT(*) FROM task_links").fetchone()[0] == before_links


def test_direct_decompose_handler_translates_lower_policy_denial(
    kanban_home,
    monkeypatch,
    capsys,
):
    from hermes_cli import kanban_decompose as decomp
    from hermes_cli.kanban_policy import WorkerKanbanRoutingPolicyError

    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_assigned")
    monkeypatch.setattr(kc, "worker_kanban_routing_allowed", lambda: True)

    def deny_lower(*_args, **_kwargs):
        raise WorkerKanbanRoutingPolicyError(
            "kanban_decompose refused: this dispatcher-spawned worker profile "
            "does not allow routing mutations under kanban.worker_allow_create"
        )

    monkeypatch.setattr(decomp, "decompose_task", deny_lower)
    args = argparse.Namespace(
        task_id="t_root",
        all_triage=False,
        tenant=None,
        author="worker",
        json=False,
    )

    rc = kc._cmd_decompose(args)

    captured = capsys.readouterr()
    assert rc == 1
    assert captured.err.startswith("kanban: kanban_decompose refused:")
    assert "Traceback" not in captured.err


def test_direct_swarm_handler_translates_lower_policy_denial(
    kanban_home,
    monkeypatch,
    capsys,
):
    (kanban_home / "config.yaml").write_text(
        "kanban:\n  worker_allow_create: false\n", encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_assigned")
    monkeypatch.setattr(kc, "worker_kanban_routing_allowed", lambda: True)
    with kb.connect_closing() as conn:
        before_tasks = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        before_links = conn.execute("SELECT COUNT(*) FROM task_links").fetchone()[0]

    args = argparse.Namespace(
        goal="forbidden swarm",
        worker=["peer:work"],
        verifier="verify",
        synthesizer="synth",
        tenant=None,
        priority=0,
        created_by="worker",
        idempotency_key=None,
        json=False,
    )

    rc = kc._cmd_swarm(args)

    captured = capsys.readouterr()
    assert rc == 1
    assert captured.err.startswith("kanban: kanban_swarm refused:")
    assert "Traceback" not in captured.err
    with kb.connect_closing() as conn:
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == before_tasks
        assert conn.execute("SELECT COUNT(*) FROM task_links").fetchone()[0] == before_links


def test_human_slash_create_ignores_worker_policy(kanban_home, monkeypatch):
    home = Path(os.environ["HERMES_HOME"])
    (home / "config.yaml").write_text(
        "kanban:\n  worker_allow_create: false\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)

    output = kc.run_slash("create 'human task' --assignee operator --json")
    created = json.loads(output)

    assert created["title"] == "human task"
    with kb.connect_closing() as conn:
        assert kb.get_task(conn, created["id"]) is not None


def test_worker_cli_link_translates_db_policy_denial(
    kanban_home,
    monkeypatch,
    capsys,
):
    with kb.connect_closing() as conn:
        parent = kb.create_task(conn, title="parent", assignee="operator")
        child = kb.create_task(conn, title="child", assignee="operator")

    (kanban_home / "config.yaml").write_text(
        "kanban:\n  worker_allow_create: false\n", encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_assigned")

    parser = argparse.ArgumentParser(prog="hermes", add_help=False)
    sub = parser.add_subparsers(dest="command")
    kc.build_parser(sub)
    args = parser.parse_args(["kanban", "link", parent, child])

    rc = kc.kanban_command(args)

    captured = capsys.readouterr()
    assert rc == 1
    assert captured.err == (
        "kanban: kanban_link refused: this dispatcher-spawned worker profile "
        "does not allow routing mutations under kanban.worker_allow_create\n"
    )
    assert "Traceback" not in captured.err


def test_board_override_is_isolated_per_concurrent_call(kanban_home, monkeypatch):
    kb.create_board("alpha")
    kb.create_board("beta")

    parser = argparse.ArgumentParser(prog="hermes", add_help=False)
    sub = parser.add_subparsers(dest="command")
    kc.build_parser(sub)

    barrier = threading.Barrier(2)
    original_init_db = kb.init_db

    def slow_init_db(*args, **kwargs):
        try:
            barrier.wait(timeout=5)
        except threading.BrokenBarrierError:
            pass
        return original_init_db(*args, **kwargs)

    monkeypatch.setattr(kb, "init_db", slow_init_db)

    failures: list[str] = []

    def worker(board: str, title: str) -> None:
        args = parser.parse_args(["kanban", "--board", board, "create", title])
        rc = kc.kanban_command(args)
        if rc != 0:
            failures.append(f"{board}:{rc}")

    t1 = threading.Thread(target=worker, args=("alpha", "alpha-task"))
    t2 = threading.Thread(target=worker, args=("beta", "beta-task"))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert failures == []

    with kb.connect_closing(board="alpha") as conn:
        alpha_titles = [row.title for row in kb.list_tasks(conn, limit=100)]
    with kb.connect_closing(board="beta") as conn:
        beta_titles = [row.title for row in kb.list_tasks(conn, limit=100)]

    assert alpha_titles == ["alpha-task"]
    assert beta_titles == ["beta-task"]


# ---------------------------------------------------------------------------
# Integration with the COMMAND_REGISTRY
# ---------------------------------------------------------------------------






# ---------------------------------------------------------------------------
# reclaim + reassign CLI smoke tests
# ---------------------------------------------------------------------------

def test_run_slash_reclaim_running_task(kanban_home):
    import re
    import time
    import secrets
    from hermes_cli import kanban_db as kb

    out1 = kc.run_slash("create 'stuck worker task' --assignee broken-model")
    m = re.search(r"(t_[a-f0-9]+)", out1)
    assert m
    tid = m.group(1)

    # Simulate a running claim outside TTL.
    conn = kb.connect()
    try:
        lock = secrets.token_hex(4)
        conn.execute(
            "UPDATE tasks SET status='running', claim_lock=?, claim_expires=?, "
            "worker_pid=? WHERE id=?",
            (lock, int(time.time()) + 3600, 4242, tid),
        )
        conn.execute(
            "INSERT INTO task_runs (task_id, status, claim_lock, claim_expires, "
            "worker_pid, started_at) VALUES (?, 'running', ?, ?, ?, ?)",
            (tid, lock, int(time.time()) + 3600, 4242, int(time.time())),
        )
        rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute("UPDATE tasks SET current_run_id=? WHERE id=?", (rid, tid))
        conn.commit()
    finally:
        conn.close()

    out = kc.run_slash(f"reclaim {tid} --reason 'test'")
    assert "Reclaimed" in out, out
    # Status back to ready.
    out2 = kc.run_slash(f"show {tid}")
    assert "ready" in out2.lower()




# ---------------------------------------------------------------------------
# /kanban specify — slash surface (same entry point CLI + gateway use)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# /kanban help / no-args / unknown-action UX (issue #21794)
# ---------------------------------------------------------------------------


