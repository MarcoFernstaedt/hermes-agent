"""Capability declarations + pure lifecycle helpers (Python mirror).

Kept deliberately small and dependency-free so the agent-tool generator
(tools/capability_tools.py) and its tests can import it without pulling in the
web server. The declarations are the single source: JSON documents under
``definitions/`` that both this Python side and the dashboard UI (via GET
/api/capabilities) read — a capability is authored once and consumed twice.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# The canonical declarations are JSON documents in ``definitions/`` — the single
# source authored once and consumed by both the agent-tool generator (here) and
# the dashboard UI (served via GET /api/capabilities). Each declares the entity,
# fields, an optional lifecycle (status field + states + legal transitions),
# views, and which operations the agent may perform. Note: "delete" is never
# exposed — a destructive op stays fail-safe (ALWAYS_APPROVAL / manual),
# matching the line held for send/trash elsewhere.

_DEFINITIONS_DIR = Path(__file__).parent / "definitions"


def load_capabilities() -> list[dict[str, Any]]:
    """Load every capability definition JSON, sorted by id for stable order."""
    caps: list[dict[str, Any]] = []
    if not _DEFINITIONS_DIR.is_dir():
        return caps
    for path in sorted(_DEFINITIONS_DIR.glob("*.json")):
        try:
            caps.append(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            continue
    return caps


CAPABILITIES: list[dict[str, Any]] = load_capabilities()


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
