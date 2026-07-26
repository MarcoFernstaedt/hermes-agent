from __future__ import annotations

import json

import pytest

from hermes_cli.imperator import ModuleSpec, scaffold_module


def _reading_capability() -> dict:
    return {
        "id": "reading",
        "label": "Reading",
        "icon": "book-marked",
        "entity": "reading",
        "title_field": "title",
        "fields": [
            {"name": "title", "label": "Title", "type": "text", "required": True},
            {"name": "status", "label": "Status", "type": "select",
             "options": [{"value": "to_read", "label": "To read"},
                         {"value": "done", "label": "Done"}]},
        ],
        "lifecycle": {"field": "status", "states": ["to_read", "done"],
                      "initial": "to_read",
                      "transitions": [{"from": "to_read", "to": ["done"]}]},
        "views": [{"id": "table", "kind": "table", "default": True}],
        "agent": {"expose": ["list", "get", "create", "advance"]},
    }


def test_scaffold_emits_verified_structure(tmp_path):
    spec = ModuleSpec(name="reading", label="Reading", icon="book-marked",
                      capability=_reading_capability())
    mod = scaffold_module(tmp_path, spec)

    dash = mod / "dashboard"
    assert (dash / "manifest.json").is_file()
    assert (dash / "capability.json").is_file()
    assert (dash / "README.md").is_file()
    assert (dash / "dist").is_dir()
    # Capability-only module needs no bespoke backend.
    assert not (dash / "plugin_api.py").exists()

    manifest = json.loads((dash / "manifest.json").read_text())
    # The exact keys the dashboard-plugin discovery reads.
    assert manifest["name"] == "reading"
    assert manifest["tab"]["path"] == "/reading"
    assert manifest["tab"]["position"] == "end"
    assert manifest["entry"] == "dist/index.js"
    assert "api" not in manifest  # no bespoke backend declared


def test_scaffolded_capability_loads_in_the_real_generator(tmp_path):
    # The declaration the scaffold writes must be consumable by the same agent
    # tool generator the Intelligence Hub uses — proving "author once".
    import tools.capability_tools as ct

    spec = ModuleSpec(name="reading", label="Reading", capability=_reading_capability())
    mod = scaffold_module(tmp_path, spec)
    decl = json.loads((mod / "dashboard" / "capability.json").read_text())

    tools = {t[0]: t[4] for t in ct.build_tools([decl])}
    assert tools.get("reading_list") == "auto"
    assert tools.get("reading_create") == "approval"
    assert tools.get("reading_advance") == "approval"
    assert "reading_delete" not in tools  # destructive op never generated


def test_bespoke_api_module_emits_router(tmp_path):
    spec = ModuleSpec(name="pomodoro", label="Pomodoro", bespoke_api=True)
    mod = scaffold_module(tmp_path, spec)
    api = (mod / "dashboard" / "plugin_api.py").read_text()
    assert "router = APIRouter()" in api  # mounted at /api/plugins/pomodoro/
    manifest = json.loads((mod / "dashboard" / "manifest.json").read_text())
    assert manifest["api"] == "plugin_api.py"


def test_scaffold_rejects_bad_name_and_double_write(tmp_path):
    with pytest.raises(ValueError):
        scaffold_module(tmp_path, ModuleSpec(name="Bad Name", label="X"))
    scaffold_module(tmp_path, ModuleSpec(name="ok", label="Ok"))
    with pytest.raises(FileExistsError):
        scaffold_module(tmp_path, ModuleSpec(name="ok", label="Ok"))
