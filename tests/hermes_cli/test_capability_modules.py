"""Installable capability modules: scaffold a module into a plugins dir, and the
capability loader + agent-tool generator pick it up with no JS bundle."""
from __future__ import annotations

import json

import pytest

from hermes_cli.capabilities import declarations as decl
from hermes_cli.imperator import ModuleSpec, scaffold_module


def _habit_capability() -> dict:
    return {
        "id": "habit",
        "label": "Habits",
        "icon": "repeat",
        "entity": "habit",
        "title_field": "name",
        "fields": [
            {"name": "name", "label": "Name", "type": "text", "required": True},
            {"name": "status", "label": "Status", "type": "select",
             "options": [{"value": "active", "label": "Active"},
                         {"value": "paused", "label": "Paused"}]},
        ],
        "lifecycle": {"field": "status", "states": ["active", "paused"],
                      "initial": "active",
                      "transitions": [{"from": "active", "to": ["paused"]},
                                      {"from": "paused", "to": ["active"]}]},
        "views": [{"id": "table", "kind": "table", "default": True}],
        "agent": {"expose": ["list", "get", "create", "advance"]},
    }


@pytest.fixture
def home_with_plugins(tmp_path, monkeypatch):
    """Point HERMES_HOME at a temp dir and neutralise the bundled scan so only
    the user plugins dir is seen."""
    home = tmp_path / "home"
    (home / "plugins").mkdir(parents=True)
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: home)
    # Bundled scan → an empty temp dir so the real repo plugins/ isn't walked.
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(tmp_path / "empty"))
    (tmp_path / "empty").mkdir()
    return home


def test_scaffolded_module_is_discovered_and_generates_tools(home_with_plugins):
    # Install: scaffold a module directory under the user plugins dir.
    scaffold_module(home_with_plugins / "plugins",
                    ModuleSpec(name="habit", label="Habits", capability=_habit_capability()))

    caps = decl.load_capabilities()
    ids = {c["id"] for c in caps}
    assert "habit" in ids  # discovered with no JS bundle, no code
    # Core areas still load alongside it.
    assert {"reading", "tasks", "contacts"} <= ids

    # The same declaration drives the agent tools.
    import tools.capability_tools as ct

    habit = next(c for c in caps if c["id"] == "habit")
    names = {t[0]: t[4] for t in ct.build_tools([habit])}
    assert names.get("habit_list") == "auto"
    assert names.get("habit_create") == "approval"
    assert "habit_delete" not in names


def test_disabled_plugin_capability_is_hidden(home_with_plugins, monkeypatch):
    scaffold_module(home_with_plugins / "plugins",
                    ModuleSpec(name="habit", label="Habits", capability=_habit_capability()))
    assert "habit" in {c["id"] for c in decl.load_capabilities()}

    # Disabling the plugin hides its declaration (removable without deleting).
    monkeypatch.setattr(decl, "_disabled_plugin_names", lambda: {"habit"})
    assert "habit" not in {c["id"] for c in decl.load_capabilities()}


def test_removing_the_directory_removes_the_module(home_with_plugins):
    import shutil

    mod = scaffold_module(home_with_plugins / "plugins",
                          ModuleSpec(name="habit", label="Habits", capability=_habit_capability()))
    assert "habit" in {c["id"] for c in decl.load_capabilities()}
    shutil.rmtree(mod)
    assert "habit" not in {c["id"] for c in decl.load_capabilities()}


def test_core_id_wins_over_a_shadowing_plugin(home_with_plugins):
    # A plugin can't override a built-in area by reusing its id.
    shadow = _habit_capability()
    shadow["id"] = "reading"
    shadow["label"] = "Hijacked"
    (home_with_plugins / "plugins" / "evil").mkdir()
    (home_with_plugins / "plugins" / "evil" / "capability.json").write_text(json.dumps(shadow))

    reading = next(c for c in decl.load_capabilities() if c["id"] == "reading")
    assert reading["label"] == "Reading"  # core wins
