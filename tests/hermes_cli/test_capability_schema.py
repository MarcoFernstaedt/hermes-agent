"""Capability declaration schema + validator."""
from __future__ import annotations

import copy

import pytest

from hermes_cli.capabilities import schema


def base() -> dict:
    """A minimal valid declaration (table only, no lifecycle)."""
    return {
        "id": "widget",
        "label": "Widgets",
        "title_field": "name",
        "fields": [
            {"name": "name", "label": "Name", "type": "text"},
            {"name": "kind", "label": "Kind", "type": "select",
             "options": [{"value": "a", "label": "A"}]},
        ],
        "views": [{"id": "table", "kind": "table", "default": True}],
        "agent": {"expose": ["list", "get", "create"]},
    }


def board_decl() -> dict:
    d = base()
    d["fields"].append({"name": "status", "label": "Status", "type": "select",
                        "options": [{"value": "open", "label": "Open"}, {"value": "done", "label": "Done"}]})
    d["lifecycle"] = {
        "field": "status", "states": ["open", "done"], "initial": "open",
        "transitions": [{"from": "open", "to": ["done"]}, {"from": "*", "to": ["open"]}],
    }
    d["views"] = [{"id": "board", "kind": "board", "default": True}]
    return d


def test_valid_declarations_pass():
    assert schema.validate_declaration(base()) == []
    assert schema.is_valid(board_decl())


def test_real_definitions_validate():
    from hermes_cli.capabilities.declarations import load_capabilities, LOAD_ERRORS

    ids = {c["id"] for c in load_capabilities()}
    assert {"tasks", "contacts", "reading"} <= ids
    assert LOAD_ERRORS == []


@pytest.mark.parametrize("mutate, needle", [
    (lambda d: d.pop("id"), "id is required"),
    (lambda d: d.update(id="Bad Id"), "slug"),
    (lambda d: d.pop("label"), "label is required"),
    (lambda d: d.update(fields=[]), "fields is required"),
    (lambda d: d.update(title_field="missing"), "not a declared field"),
    (lambda d: d["fields"].append({"name": "x", "label": "X", "type": "bogus"}), "not one of"),
    (lambda d: d.update(fields=[{"name": "name", "label": "N", "type": "select"}]), "non-empty options"),
    (lambda d: d.update(subtitle_field="nope"), "subtitle_field"),
    (lambda d: d.update(views=[]), "views is required"),
    (lambda d: d.update(views=[{"id": "b", "kind": "board"}]), "declares no lifecycle"),
    (lambda d: d["views"][0].update(columns=["ghost"]), "unknown field"),
    (lambda d: d.update(agent={"expose": ["delete"]}), "never include 'delete'"),
    (lambda d: d.update(agent={"expose": ["frobnicate"]}), "is not one of"),
])
def test_invalid_declarations_are_caught(mutate, needle):
    d = base()
    mutate(d)
    errors = schema.validate_declaration(d)
    assert any(needle in e for e in errors), f"expected '{needle}' in {errors}"


def test_lifecycle_cross_references():
    d = board_decl()
    d["lifecycle"]["initial"] = "ghost"
    assert any("initial" in e for e in schema.validate_declaration(d))
    d = board_decl()
    d["lifecycle"]["transitions"] = [{"from": "open", "to": ["ghost"]}]
    assert any("not a state" in e for e in schema.validate_declaration(d))


def test_duplicate_field_names():
    d = base()
    d["fields"].append({"name": "name", "label": "Dup", "type": "text"})
    assert any("duplicated" in e for e in schema.validate_declaration(d))


def test_gallery_view_is_valid():
    d = base()
    d["views"] = [{"id": "gallery", "kind": "gallery", "default": True}]
    assert schema.validate_declaration(d) == []


def test_agenda_requires_a_real_date_field():
    d = base()
    d["fields"].append({"name": "due", "label": "Due", "type": "date"})
    # Missing dateField.
    d["views"] = [{"id": "agenda", "kind": "agenda", "default": True}]
    assert any("needs a dateField" in e for e in schema.validate_declaration(d))
    # Points at a field that does not exist.
    d["views"] = [{"id": "agenda", "kind": "agenda", "dateField": "ghost"}]
    assert any("not a declared field" in e for e in schema.validate_declaration(d))
    # Valid.
    d["views"] = [{"id": "agenda", "kind": "agenda", "dateField": "due", "default": True}]
    assert schema.validate_declaration(d) == []


def test_published_schema_shape():
    js = schema.declaration_json_schema()
    assert js["type"] == "object"
    assert "id" in js["required"] and "views" in js["required"]
    assert js["properties"]["id"]["pattern"].startswith("^[a-z]")


def test_loader_rejects_invalid(tmp_path, monkeypatch):
    # A malformed declaration dropped into the definitions dir is rejected, not
    # served — and recorded in LOAD_ERRORS.
    from hermes_cli.capabilities import declarations as decl_mod

    d = tmp_path / "defs"
    d.mkdir()
    (d / "good.json").write_text(__import__("json").dumps(base()), encoding="utf-8")
    bad = copy.deepcopy(base())
    bad["id"] = "broken"
    bad["title_field"] = "does_not_exist"
    (d / "bad.json").write_text(__import__("json").dumps(bad), encoding="utf-8")
    monkeypatch.setattr(decl_mod, "_DEFINITIONS_DIR", d)
    monkeypatch.setattr(decl_mod, "_plugin_capability_files", lambda: [])

    caps = decl_mod.load_capabilities()
    ids = {c["id"] for c in caps}
    assert "widget" in ids
    assert "broken" not in ids
    assert any(e["id"] == "broken" for e in decl_mod.LOAD_ERRORS)


def test_every_valid_declaration_can_generate_tools():
    """A declaration that passes validation must never crash tool generation.

    The generator read cap["entity"] and cap["lifecycle"] directly, but both are
    OPTIONAL in the schema — so a *valid* declaration (no entity, no lifecycle)
    raised at tool-discovery time. Found on the live machine. Now that the agent
    can author declarations, a schema-passing proposal must never be able to
    break tool discovery.
    """
    from tools.capability_tools import build_tools

    minimal = {
        "id": "notes", "label": "Notes", "title_field": "t",
        "fields": [{"name": "t", "label": "T", "type": "text"}],
        "views": [{"id": "table", "kind": "table", "default": True}],
        # 'advance' requested but there is no lifecycle to advance through.
        "agent": {"expose": ["list", "get", "create", "advance"]},
    }
    assert schema.validate_declaration(minimal) == []

    names = [t[0] for t in build_tools([minimal])]
    # entity defaults to id, matching the renderer's entityTypeOf.
    assert names == ["notes_list", "notes_get", "notes_create"]
    # advance is skipped rather than generating a tool that cannot work.
    assert not any("advance" in n for n in names)

    # And the shipped declarations still generate cleanly.
    from hermes_cli.capabilities.declarations import load_capabilities
    assert build_tools(load_capabilities())
