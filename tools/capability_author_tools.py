"""Agent tools for authoring capabilities — propose, never apply.

Imperator can turn a description into a *capability declaration* and file it to
the review queue. It never writes the declaration or creates the surface
directly: the owner approves the proposal, and only then does the review
handler validate-and-write it. So the agent proposes structure; the owner
approves; the app reshapes — self-extension is never self-authorisation.

``capability_list`` (AUTO) lets the agent see what already exists so it doesn't
propose a duplicate. ``capability_propose`` (APPROVAL) validates the declaration
against the published schema *before* filing, so a malformed proposal is
rejected at author time with actionable errors, never queued as noise.
"""
from __future__ import annotations

import json

from tools.registry import registry, tool_error, tool_result


def _handle_list(_args: dict, **_kw) -> str:
    from hermes_cli.capabilities.declarations import load_capabilities

    caps = load_capabilities()
    summary = [
        {"id": c["id"], "label": c.get("label"), "fields": [f["name"] for f in c.get("fields", [])],
         "has_lifecycle": "lifecycle" in c}
        for c in caps
    ]
    return tool_result({"capabilities": summary})


def _handle_propose(args: dict, **_kw) -> str:
    from hermes_cli.capabilities.schema import validate_declaration
    from hermes_cli.review.store import ReviewStore
    from hermes_constants import get_hermes_home

    declaration = args.get("declaration")
    if isinstance(declaration, str):
        try:
            declaration = json.loads(declaration)
        except json.JSONDecodeError as exc:
            return tool_error(f"declaration is not valid JSON: {exc}")
    if not isinstance(declaration, dict):
        return tool_error("declaration must be a JSON object")

    errors = validate_declaration(declaration)
    if errors:
        return tool_error("declaration failed validation:\n- " + "\n- ".join(errors))

    cid = declaration["id"]
    store = ReviewStore(get_hermes_home() / "state" / "review.sqlite3")
    proposal = store.create(
        kind="capability",
        title=args.get("title") or f"Add the '{declaration.get('label', cid)}' capability",
        summary=args.get("summary", ""),
        source="agent",
        risk="low",  # a capability is data, not privileged code
        payload={"declaration": declaration},
        preview={"id": cid, "label": declaration.get("label"),
                 "fields": [f["name"] for f in declaration.get("fields", [])]},
    )
    return tool_result({
        "proposed": True,
        "proposal_id": proposal["id"],
        "status": proposal["status"],
        "message": f"Filed capability '{cid}' to the review queue for approval.",
    })


_LIST_SCHEMA = {
    "name": "capability_list",
    "description": "List the capabilities that already exist (id, label, fields) so you don't propose a duplicate.",
    "parameters": {"type": "object", "properties": {}},
}

_PROPOSE_SCHEMA = {
    "name": "capability_propose",
    "description": (
        "Propose a new capability (a data-driven surface: entities, fields, "
        "lifecycle, views). Files it to the review queue for the owner to "
        "approve — it does NOT create the surface. The declaration is validated "
        "against the schema first. Emit a declaration, never UI code."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "declaration": {
                "type": "object",
                "description": "The capability declaration (see GET /api/capabilities/schema).",
            },
            "title": {"type": "string", "description": "Short title for the proposal."},
            "summary": {"type": "string", "description": "Why this capability is useful."},
        },
        "required": ["declaration"],
    },
}


def _register_permissions() -> None:
    try:
        from hermes_cli.module_permissions import Tier, register_tool_permission

        register_tool_permission("capability_list", Tier.AUTO)
        register_tool_permission("capability_propose", Tier.APPROVAL)
    except Exception:
        pass


_register_permissions()

# Direct top-level registration so the registry's auto-discovery
# (_module_registers_tools looks for a top-level registry.register call) imports
# this module and the agent actually sees the tools.
registry.register(name="capability_list", toolset="capabilities",
                  schema=_LIST_SCHEMA, handler=_handle_list, emoji="")
registry.register(name="capability_propose", toolset="capabilities",
                  schema=_PROPOSE_SCHEMA, handler=_handle_propose, emoji="")
