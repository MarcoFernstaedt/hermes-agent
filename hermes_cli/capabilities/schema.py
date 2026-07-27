"""Capability declaration schema + validator.

A capability is *data*: the declaration below is the only thing an author (a
human via the builder, or the agent via a tool) produces. The fixed renderer
turns it into a surface. So the declaration is the trust boundary — it must be
validated *before* it is served or rendered, or a malformed capability becomes
broken UI at view time instead of a clear error at author time.

Kept dependency-free (pure Python, no jsonschema) to match the rest of the
capability layer, and shared by the loader (`declarations.py`), the HTTP
validate endpoint, and the agent authoring tool — one source of truth for
"is this declaration valid".
"""
from __future__ import annotations

import re
from typing import Any

# The field types the renderer's `formatField` / `FormFromSchema` understand.
FIELD_TYPES = {
    "text", "number", "currency", "boolean", "date", "select", "tags",
    "markdown", "url",
}
VIEW_KINDS = {"board", "table"}
# Operations the agent may be granted. "delete" is deliberately absent —
# destructive ops stay fail-safe and are never declared here.
AGENT_OPS = {"list", "get", "create", "advance"}

_ID_RE = re.compile(r"^[a-z][a-z0-9_-]*$")


def _is_str(v: Any) -> bool:
    return isinstance(v, str) and bool(v.strip())


def validate_declaration(decl: Any) -> list[str]:
    """Return a list of human-readable errors (empty ⇒ valid).

    Deterministic and side-effect-free: same declaration → same errors.
    """
    errors: list[str] = []
    if not isinstance(decl, dict):
        return ["declaration must be a JSON object"]

    cid = decl.get("id")
    if not _is_str(cid):
        errors.append("id is required and must be a non-empty string")
    elif not _ID_RE.match(cid):
        errors.append("id must be a slug: lowercase letters, digits, '-' or '_', starting with a letter")

    if not _is_str(decl.get("label")):
        errors.append("label is required and must be a non-empty string")

    # -- fields --
    fields = decl.get("fields")
    field_names: set[str] = set()
    if not isinstance(fields, list) or not fields:
        errors.append("fields is required and must be a non-empty array")
        fields = []
    for i, f in enumerate(fields):
        where = f"fields[{i}]"
        if not isinstance(f, dict):
            errors.append(f"{where} must be an object")
            continue
        name = f.get("name")
        if not _is_str(name):
            errors.append(f"{where}.name is required")
        else:
            if name in field_names:
                errors.append(f"{where}.name '{name}' is duplicated")
            field_names.add(name)
        if not _is_str(f.get("label")):
            errors.append(f"{where}.label is required")
        ftype = f.get("type")
        if ftype not in FIELD_TYPES:
            errors.append(f"{where}.type '{ftype}' is not one of {sorted(FIELD_TYPES)}")
        if ftype == "select":
            opts = f.get("options")
            if not isinstance(opts, list) or not opts:
                errors.append(f"{where} is a select and needs a non-empty options array")
            else:
                for j, o in enumerate(opts):
                    if not isinstance(o, dict) or not _is_str(o.get("value")) or not _is_str(o.get("label")):
                        errors.append(f"{where}.options[{j}] must have string value and label")

    # -- title / subtitle must reference declared fields --
    title_field = decl.get("title_field")
    if not _is_str(title_field):
        errors.append("title_field is required")
    elif field_names and title_field not in field_names:
        errors.append(f"title_field '{title_field}' is not a declared field")
    subtitle = decl.get("subtitle_field")
    if subtitle is not None and field_names and subtitle not in field_names:
        errors.append(f"subtitle_field '{subtitle}' is not a declared field")

    # -- lifecycle (optional) --
    lifecycle = decl.get("lifecycle")
    states: list[str] = []
    if lifecycle is not None:
        if not isinstance(lifecycle, dict):
            errors.append("lifecycle must be an object")
        else:
            lf = lifecycle.get("field")
            if not _is_str(lf):
                errors.append("lifecycle.field is required")
            elif field_names and lf not in field_names:
                errors.append(f"lifecycle.field '{lf}' is not a declared field")
            states = lifecycle.get("states") if isinstance(lifecycle.get("states"), list) else []
            if not states or not all(_is_str(s) for s in states):
                errors.append("lifecycle.states must be a non-empty array of strings")
            initial = lifecycle.get("initial")
            if not _is_str(initial):
                errors.append("lifecycle.initial is required")
            elif states and initial not in states:
                errors.append(f"lifecycle.initial '{initial}' is not in states")
            transitions = lifecycle.get("transitions", [])
            if not isinstance(transitions, list):
                errors.append("lifecycle.transitions must be an array")
            else:
                for i, t in enumerate(transitions):
                    if not isinstance(t, dict):
                        errors.append(f"lifecycle.transitions[{i}] must be an object")
                        continue
                    frm = t.get("from")
                    if frm != "*" and states and frm not in states:
                        errors.append(f"lifecycle.transitions[{i}].from '{frm}' is not a state or '*'")
                    tos = t.get("to")
                    if not isinstance(tos, list) or not tos:
                        errors.append(f"lifecycle.transitions[{i}].to must be a non-empty array")
                    elif states:
                        for to in tos:
                            if to not in states:
                                errors.append(f"lifecycle.transitions[{i}].to '{to}' is not a state")

    # -- views --
    views = decl.get("views")
    if not isinstance(views, list) or not views:
        errors.append("views is required and must be a non-empty array")
        views = []
    view_ids: set[str] = set()
    has_default = False
    for i, v in enumerate(views):
        where = f"views[{i}]"
        if not isinstance(v, dict):
            errors.append(f"{where} must be an object")
            continue
        vid = v.get("id")
        if not _is_str(vid):
            errors.append(f"{where}.id is required")
        elif vid in view_ids:
            errors.append(f"{where}.id '{vid}' is duplicated")
        else:
            view_ids.add(vid)
        kind = v.get("kind")
        if kind not in VIEW_KINDS:
            errors.append(f"{where}.kind '{kind}' is not one of {sorted(VIEW_KINDS)}")
        if kind == "board" and lifecycle is None:
            errors.append(f"{where} is a board but the capability declares no lifecycle")
        cols = v.get("columns")
        if cols is not None:
            if not isinstance(cols, list):
                errors.append(f"{where}.columns must be an array")
            elif field_names:
                for c in cols:
                    if c not in field_names:
                        errors.append(f"{where}.columns references unknown field '{c}'")
        group_by = v.get("groupBy") or v.get("group_by")
        if group_by is not None and field_names and group_by not in field_names:
            errors.append(f"{where}.groupBy '{group_by}' is not a declared field")
        if v.get("default") is True:
            has_default = True
    # A missing default:true is not an error — the renderer falls back to
    # views[0]. (has_default is tracked for tooling/tests, not enforced here.)
    _ = has_default

    # -- agent operations --
    agent = decl.get("agent")
    if agent is not None:
        if not isinstance(agent, dict):
            errors.append("agent must be an object")
        else:
            expose = agent.get("expose", [])
            if not isinstance(expose, list):
                errors.append("agent.expose must be an array")
            else:
                for op in expose:
                    if op == "delete":
                        errors.append("agent.expose must never include 'delete' (destructive ops are not exposable)")
                    elif op not in AGENT_OPS:
                        errors.append(f"agent.expose '{op}' is not one of {sorted(AGENT_OPS)}")

    return errors


def is_valid(decl: Any) -> bool:
    return not validate_declaration(decl)


def declaration_json_schema() -> dict[str, Any]:
    """A published JSON-Schema (draft-07) view of the declaration, for the
    authoring builder and external tooling. The authoritative check is
    ``validate_declaration`` (it enforces cross-references the schema cannot,
    e.g. title_field ∈ fields); this schema covers shape and enums."""
    field_schema = {
        "type": "object",
        "required": ["name", "label", "type"],
        "properties": {
            "name": {"type": "string", "minLength": 1},
            "label": {"type": "string", "minLength": 1},
            "type": {"enum": sorted(FIELD_TYPES)},
            "required": {"type": "boolean"},
            "placeholder": {"type": "string"},
            "readOnly": {"type": "boolean"},
            "options": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["value", "label"],
                    "properties": {
                        "value": {"type": "string"},
                        "label": {"type": "string"},
                    },
                },
            },
        },
    }
    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "$id": "https://imperator.local/schemas/capability-declaration.json",
        "title": "Imperator capability declaration",
        "type": "object",
        "required": ["id", "label", "title_field", "fields", "views"],
        "additionalProperties": True,
        "properties": {
            "id": {"type": "string", "pattern": "^[a-z][a-z0-9_-]*$"},
            "label": {"type": "string", "minLength": 1},
            "icon": {"type": "string"},
            "group": {"type": "string"},
            "entity": {"type": "string"},
            "title_field": {"type": "string", "minLength": 1},
            "subtitle_field": {"type": "string"},
            "fields": {"type": "array", "minItems": 1, "items": field_schema},
            "lifecycle": {
                "type": "object",
                "required": ["field", "states", "initial"],
                "properties": {
                    "field": {"type": "string"},
                    "states": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                    "initial": {"type": "string"},
                    "transitions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["from", "to"],
                            "properties": {
                                "from": {"type": "string"},
                                "to": {"type": "array", "items": {"type": "string"}},
                            },
                        },
                    },
                },
            },
            "views": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "required": ["id", "kind"],
                    "properties": {
                        "id": {"type": "string"},
                        "kind": {"enum": sorted(VIEW_KINDS)},
                        "columns": {"type": "array", "items": {"type": "string"}},
                        "groupBy": {"type": "string"},
                        "default": {"type": "boolean"},
                    },
                },
            },
            "agent": {
                "type": "object",
                "properties": {
                    "expose": {"type": "array", "items": {"enum": sorted(AGENT_OPS)}},
                },
            },
        },
    }
