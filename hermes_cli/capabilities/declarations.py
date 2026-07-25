"""Capability declarations + pure lifecycle helpers (Python mirror).

Kept deliberately small and dependency-free so the agent-tool generator
(tools/capability_tools.py) and its tests can import it without pulling in the
web server. The declarations mirror web/src/capabilities/registry.ts; the two
should be kept in step until a single shared JSON source replaces both.
"""
from __future__ import annotations

from typing import Any

# Each capability: id/entity, title field, declared fields, an optional
# lifecycle (status field + states + legal transitions), and which operations
# the agent may perform. Note: "delete" is intentionally never exposed — a
# destructive op stays fail-safe (ALWAYS_APPROVAL / manual), matching the line
# held for send/trash elsewhere.
CAPABILITIES: list[dict[str, Any]] = [
    {
        "id": "reading",
        "label": "Reading",
        "entity": "reading",
        "title_field": "title",
        "fields": [
            {"name": "title", "type": "text", "required": True},
            {"name": "author", "type": "text"},
            {"name": "url", "type": "url"},
            {"name": "status", "type": "select"},
            {"name": "tags", "type": "tags"},
            {"name": "notes", "type": "markdown"},
        ],
        "lifecycle": {
            "field": "status",
            "states": ["to_read", "reading", "done", "abandoned"],
            "initial": "to_read",
            "transitions": [
                {"from": "to_read", "to": ["reading", "abandoned"]},
                {"from": "reading", "to": ["done", "abandoned"]},
                {"from": "*", "to": ["to_read"]},
            ],
        },
        "agent": {"expose": ["list", "get", "create", "advance"]},
    },
]


def legal_transitions(lifecycle: dict[str, Any], from_status: str) -> list[str]:
    """Target states reachable from ``from_status`` (honouring a ``"*"`` from)."""
    out: list[str] = []
    seen: set[str] = set()
    for t in lifecycle.get("transitions", []):
        if t.get("from") in (from_status, "*"):
            for to in t.get("to", []):
                if to not in seen:
                    seen.add(to)
                    out.append(to)
    return out


def can_transition(lifecycle: dict[str, Any], from_status: str, to_status: str) -> bool:
    return to_status in legal_transitions(lifecycle, from_status)


def field_names(capability: dict[str, Any]) -> list[str]:
    return [f["name"] for f in capability.get("fields", [])]


def coerce_fields(capability: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    """Keep only declared fields from an agent-supplied payload (drops unknown
    keys so a capability's data shape stays what it declared)."""
    allowed = set(field_names(capability))
    return {k: v for k, v in data.items() if k in allowed}
