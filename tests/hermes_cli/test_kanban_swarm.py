from __future__ import annotations

import ast
import inspect
import sqlite3
import textwrap
from pathlib import Path
from typing import cast

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli.kanban_swarm import (
    SwarmWorkerSpec,
    create_swarm,
    latest_blackboard,
    post_blackboard_update,
)


def _durable_row_counts(conn) -> dict[str, int]:
    tables = [
        row["name"]
        for row in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
    ]
    return {
        table: conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        for table in tables
    }


def _file_snapshot(root: Path) -> dict[str, tuple[bool, bytes]]:
    return {
        str(path.relative_to(root)): (
            path.is_dir(),
            b"" if path.is_dir() else path.read_bytes(),
        )
        for path in sorted(root.rglob("*"))
    }


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


@pytest.mark.parametrize("policy_state", ["explicit-false", "malformed", "unreadable"])
def test_worker_create_swarm_denies_before_validation_iteration_connection_or_ids(
    monkeypatch,
    tmp_path,
    policy_state,
):
    from hermes_cli.kanban_policy import WorkerKanbanRoutingPolicyError

    home = tmp_path / ".hermes"
    home.mkdir()
    config_path = home / "config.yaml"
    if policy_state == "explicit-false":
        config_path.write_text(
            "kanban:\n  worker_allow_create: false\n", encoding="utf-8"
        )
    elif policy_state == "malformed":
        config_path.write_text("kanban: [unterminated\n", encoding="utf-8")
    else:
        config_path.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_assigned")

    class ForbiddenWorkers:
        def __iter__(self):
            raise AssertionError("worker swarm denial must precede iterator consumption")

    def forbidden_task_id():
        raise AssertionError("worker swarm denial must precede task-ID generation")

    monkeypatch.setattr(kb, "_new_task_id", forbidden_task_id)
    before = _file_snapshot(home)

    with pytest.raises(WorkerKanbanRoutingPolicyError, match="^kanban_swarm refused:"):
        create_swarm(
            cast(sqlite3.Connection, None),
            goal="",
            workers=ForbiddenWorkers(),
            verifier_assignee="",
            synthesizer_assignee="",
        )

    assert _file_snapshot(home) == before


def test_worker_create_swarm_denial_creates_no_rows_events_links_workspaces_or_ids(
    kanban_home,
    monkeypatch,
):
    from hermes_cli.kanban_policy import WorkerKanbanRoutingPolicyError

    workspaces = kanban_home / "worker-policy-workspaces"
    workspaces.mkdir()
    monkeypatch.setenv("HERMES_KANBAN_WORKSPACES_ROOT", str(workspaces))
    (kanban_home / "config.yaml").write_text(
        "kanban:\n  worker_allow_create: false\n", encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_assigned")

    def forbidden_task_id():
        raise AssertionError("worker swarm denial must precede task-ID generation")

    monkeypatch.setattr(kb, "_new_task_id", forbidden_task_id)
    with kb.connect_closing() as conn:
        before_rows = _durable_row_counts(conn)
        before_files = _file_snapshot(kanban_home)

        with pytest.raises(WorkerKanbanRoutingPolicyError, match="^kanban_swarm refused:"):
            create_swarm(
                conn,
                goal="forbidden graph",
                workers=[SwarmWorkerSpec(profile="peer", title="work", body="work")],
                verifier_assignee="verify",
                synthesizer_assignee="synth",
                workspace_path=str(workspaces / "must-not-exist"),
            )

        assert _durable_row_counts(conn) == before_rows
        assert _file_snapshot(kanban_home) == before_files
        assert not (workspaces / "must-not-exist").exists()


@pytest.mark.parametrize(
    "config_text",
    [
        "toolsets:\n  - hermes-cli\n",
        "kanban:\n  worker_allow_create: true\n",
    ],
    ids=["missing-key", "explicit-true"],
)
def test_worker_create_swarm_preserves_allowed_behavior(
    kanban_home,
    monkeypatch,
    config_text,
):
    (kanban_home / "config.yaml").write_text(config_text, encoding="utf-8")
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_assigned")

    with kb.connect_closing() as conn:
        before = _durable_row_counts(conn)
        created = create_swarm(
            conn,
            goal="allowed graph",
            workers=[SwarmWorkerSpec(profile="peer", title="work", body="work")],
            verifier_assignee="verify",
            synthesizer_assignee="synth",
        )
        after = _durable_row_counts(conn)

        assert kb.get_task(conn, created.root_id) is not None
        assert after["tasks"] == before["tasks"] + 4
        assert after["task_links"] == before["task_links"] + 3


def test_non_worker_create_swarm_ignores_worker_policy(kanban_home, monkeypatch):
    (kanban_home / "config.yaml").write_text(
        "kanban:\n  worker_allow_create: false\n", encoding="utf-8"
    )
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)

    with kb.connect_closing() as conn:
        created = create_swarm(
            conn,
            goal="orchestrator graph",
            workers=[SwarmWorkerSpec(profile="peer", title="work", body="work")],
            verifier_assignee="verify",
            synthesizer_assignee="synth",
        )
        assert kb.get_task(conn, created.synthesizer_id) is not None


def test_delegated_child_create_swarm_guard_remains_authoritative(
    kanban_home,
    monkeypatch,
):
    from agent.delegation_context import delegated_child_context

    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    with kb.connect_closing() as conn:
        before = _durable_row_counts(conn)
        with delegated_child_context():
            with pytest.raises(PermissionError, match="delegate_task child contexts"):
                create_swarm(
                    conn,
                    goal="delegated graph",
                    workers=[
                        SwarmWorkerSpec(profile="peer", title="work", body="work")
                    ],
                    verifier_assignee="verify",
                    synthesizer_assignee="synth",
                )
        assert _durable_row_counts(conn) == before


def test_swarm_composition_boundary_guards_before_nested_task_creation():
    """Supported fan-out helpers may not rely only on nested DB mutator guards."""
    function = ast.parse(textwrap.dedent(inspect.getsource(create_swarm))).body[0]
    assert isinstance(function, ast.FunctionDef)
    executable = function.body[1:]  # skip the function docstring

    first = executable[0]
    assert isinstance(first, ast.Expr)
    assert isinstance(first.value, ast.Call)
    assert isinstance(first.value.func, ast.Name)
    assert first.value.func.id == "require_worker_kanban_routing_allowed"
    assert ast.literal_eval(first.value.args[0]) == "kanban_swarm"

    nested_calls = [
        node
        for node in ast.walk(function)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "kb"
        and node.func.attr == "create_task"
    ]
    assert nested_calls, "the composition contract applies because swarm creates tasks"


def test_create_swarm_builds_parallel_workers_verifier_and_synthesizer(tmp_path):
    conn = kb.connect(tmp_path / "kanban.db")
    try:
        created = create_swarm(
            conn,
            goal="Map the target market and produce a decision memo.",
            workers=[
                SwarmWorkerSpec(profile="researcher-a", title="Market scan", body="Find competitors"),
                SwarmWorkerSpec(profile="researcher-b", title="Customer scan", body="Find customer pains"),
            ],
            verifier_assignee="reviewer",
            synthesizer_assignee="writer",
            tenant="intel",
            created_by="orchestrator",
        )

        root = kb.get_task(conn, created.root_id)
        workers = [kb.get_task(conn, tid) for tid in created.worker_ids]
        verifier = kb.get_task(conn, created.verifier_id)
        synthesizer = kb.get_task(conn, created.synthesizer_id)

        assert root.status == "done"
        assert root.assignee == "orchestrator"
        assert [task.status for task in workers] == ["ready", "ready"]
        assert [task.assignee for task in workers] == ["researcher-a", "researcher-b"]
        assert verifier.status == "todo"
        assert synthesizer.status == "todo"
        assert set(kb.parent_ids(conn, created.verifier_id)) == set(created.worker_ids)
        assert kb.parent_ids(conn, created.synthesizer_id) == [created.verifier_id]
        assert all(created.root_id in (task.body or "") for task in workers)
    finally:
        conn.close()


def test_swarm_blackboard_merges_structured_updates(tmp_path):
    conn = kb.connect(tmp_path / "kanban.db")
    try:
        created = create_swarm(
            conn,
            goal="Collect evidence.",
            workers=[SwarmWorkerSpec(profile="researcher", title="Evidence", body="Find proof")],
            verifier_assignee="reviewer",
            synthesizer_assignee="writer",
        )

        post_blackboard_update(
            conn,
            created.root_id,
            author="researcher",
            key="sources",
            value=["https://example.com/a"],
        )
        post_blackboard_update(
            conn,
            created.root_id,
            author="reviewer",
            key="risks",
            value={"missing_primary_source": True},
        )

        board = latest_blackboard(conn, created.root_id)
        assert board["sources"] == ["https://example.com/a"]
        assert board["risks"] == {"missing_primary_source": True}
        assert board["_authors"]["sources"] == "researcher"
    finally:
        conn.close()


def test_swarm_verifier_and_synthesis_are_dependency_gated(tmp_path):
    conn = kb.connect(tmp_path / "kanban.db")
    try:
        created = create_swarm(
            conn,
            goal="Research two branches then verify and synthesize.",
            workers=[
                SwarmWorkerSpec(profile="a", title="Branch A", body="A"),
                SwarmWorkerSpec(profile="b", title="Branch B", body="B"),
            ],
            verifier_assignee="reviewer",
            synthesizer_assignee="writer",
        )

        kb.complete_task(
            conn,
            created.worker_ids[0],
            summary="A done",
            metadata={"confidence": 0.8},
        )
        kb.recompute_ready(conn)
        assert kb.get_task(conn, created.verifier_id).status == "todo"
        assert kb.get_task(conn, created.synthesizer_id).status == "todo"

        kb.complete_task(conn, created.worker_ids[1], summary="B done")
        kb.recompute_ready(conn)
        assert kb.get_task(conn, created.verifier_id).status == "ready"
        assert kb.get_task(conn, created.synthesizer_id).status == "todo"

        kb.complete_task(
            conn,
            created.verifier_id,
            summary="Verified both branches",
            metadata={"gate": "pass"},
        )
        kb.recompute_ready(conn)
        assert kb.get_task(conn, created.synthesizer_id).status == "ready"
    finally:
        conn.close()
