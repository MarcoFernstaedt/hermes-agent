"""Agent tools generated from capability declarations.

For every declared capability (hermes_cli.capabilities.declarations) this
registers the agent-facing half of "written once, exposed twice": list/get
(AUTO reads), create and advance (APPROVAL writes, audited) — over the same
generic entity store the dashboard UI uses. Delete is deliberately never
generated, so ``<entity>_delete`` stays fail-safe (ALWAYS_APPROVAL), matching
the destructive-op line held for vault/email.

The store is shared with the web dashboard (same sqlite file), so a record the
agent creates shows up in the UI on its next fetch; live push to open tabs
happens only for UI-initiated writes (the web server owns the event bus).
"""
from __future__ import annotations

from typing import Any, Callable

from tools.registry import registry, tool_error, tool_result

from hermes_cli.capabilities.declarations import (
    CAPABILITIES,
    can_transition,
    coerce_fields,
    legal_transitions,
)

_TYPE_TO_JSON = {
    "text": "string",
    "markdown": "string",
    "url": "string",
    "select": "string",
    "number": "number",
    "currency": "number",
    "boolean": "boolean",
    "tags": "array",
}


def _store():
    """A migrated entity store bound to the dashboard's database."""
    from hermes_cli.entities.router import default_database_path
    from hermes_cli.entities.store import EntityStore

    store = EntityStore(default_database_path())
    store.migrate()
    return store


def _notify_dashboard(entity: str, entity_id: str, action: str, version: int) -> None:
    """Best-effort: nudge an open dashboard board/table to refetch this record.

    The capability tools write straight to the shared entity store, bypassing
    the web server's event bus — so a UI tab wouldn't otherwise learn of an
    agent write until its next fetch. When the agent runs under the dashboard,
    ``HERMES_TUI_SIDECAR_URL`` points back at the server (loopback,
    ``?token=<session token>``); POST the change hint to the entities /notify
    route so the live "entities" channel fans it out. Everything here is
    swallowed: a missing URL, a gated bind (no session token to reuse), or a
    down server just means the tab catches up on its next fetch.
    """
    import os

    raw = os.environ.get("HERMES_TUI_SIDECAR_URL")
    if not raw:
        return
    try:
        import json
        import urllib.request
        from urllib.parse import parse_qs, urlsplit

        parts = urlsplit(raw)  # ws://host:port/api/pub?token=...&channel=...
        token = parse_qs(parts.query).get("token", [None])[0]
        if not token or not parts.netloc:
            return  # gated mode authenticates with ?internal=, not reusable here
        url = f"http://{parts.netloc}/api/entities/{entity}/{entity_id}/notify"
        req = urllib.request.Request(
            url,
            data=json.dumps({"action": action, "version": version}).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Hermes-Session-Token": token},
            method="POST",
        )
        # Bypass the agent HTTPS proxy for this loopback call.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        opener.open(req, timeout=1.5).read()
    except Exception:
        pass


def _audit(entity: str, action: str, target: str, detail: dict | None = None) -> None:
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor="agent", module="capability", tool=entity,
            action=action, target=target, decision="approval",
            outcome="ok", detail=detail,
        )
    except Exception:
        pass


def _create_schema(cap: dict[str, Any]) -> dict[str, Any]:
    props: dict[str, Any] = {}
    required: list[str] = []
    for f in cap["fields"]:
        json_type = _TYPE_TO_JSON.get(f["type"], "string")
        prop: dict[str, Any] = {"type": json_type}
        if json_type == "array":
            prop["items"] = {"type": "string"}
        props[f["name"]] = prop
        if f.get("required"):
            required.append(f["name"])
    schema: dict[str, Any] = {"type": "object", "properties": props}
    if required:
        schema["required"] = required
    return schema


def _make_list(cap: dict[str, Any]) -> Callable:
    entity = cap["entity"]
    status_field = (cap.get("lifecycle") or {}).get("field")

    def handler(args: dict, **_kw) -> str:
        try:
            filters = {}
            if status_field and args.get(status_field):
                filters[status_field] = args[status_field]
            result = _store().list(entity, filters=filters or None, limit=int(args.get("limit", 100)))
            items = [{"id": e["id"], "version": e["version"], **e["data"]} for e in result["items"]]
            return tool_result({"items": items, "total": result["total"]})
        except Exception as exc:
            return tool_error(f"{entity} list failed: {exc}")

    return handler


def _make_get(cap: dict[str, Any]) -> Callable:
    entity = cap["entity"]

    def handler(args: dict, **_kw) -> str:
        entity_id = args.get("id")
        if not entity_id:
            return tool_error("id is required")
        try:
            record = _store().get(str(entity_id))
            if record is None or record["type"] != entity:
                return tool_error(f"{entity} not found")
            return tool_result({"id": record["id"], "version": record["version"], **record["data"]})
        except Exception as exc:
            return tool_error(f"{entity} get failed: {exc}")

    return handler


def _make_create(cap: dict[str, Any]) -> Callable:
    entity = cap["entity"]
    lifecycle = cap.get("lifecycle")

    def handler(args: dict, **_kw) -> str:
        try:
            data = coerce_fields(cap, dict(args))
            if lifecycle and not data.get(lifecycle["field"]):
                data[lifecycle["field"]] = lifecycle["initial"]
            created = _store().create(entity, data)
            _audit(entity, "create", created["id"], {"data": data})
            _notify_dashboard(entity, created["id"], "created", created["version"])
            return tool_result({"id": created["id"], "version": created["version"], **created["data"]})
        except Exception as exc:
            return tool_error(f"{entity} create failed: {exc}")

    return handler


def _make_advance(cap: dict[str, Any]) -> Callable:
    entity = cap["entity"]
    lifecycle = cap["lifecycle"]
    field = lifecycle["field"]

    def handler(args: dict, **_kw) -> str:
        from hermes_cli.entities.store import EntityConflictError

        entity_id = args.get("id")
        to_status = args.get("to")
        if not entity_id or not to_status:
            return tool_error("id and to are required")
        try:
            store = _store()
            record = store.get(str(entity_id))
            if record is None or record["type"] != entity:
                return tool_error(f"{entity} not found")
            current = str(record["data"].get(field, ""))
            if not can_transition(lifecycle, current, str(to_status)):
                allowed = legal_transitions(lifecycle, current)
                return tool_error(
                    f"Cannot move from '{current}' to '{to_status}'. Allowed: {allowed or 'none'}"
                )
            new_data = {**record["data"], field: to_status}
            updated = store.update(record["id"], new_data, expected_version=record["version"])
            _audit(entity, "advance", record["id"], {"from": current, "to": to_status})
            _notify_dashboard(entity, updated["id"], "updated", updated["version"])
            return tool_result({"id": updated["id"], "version": updated["version"], **updated["data"]})
        except EntityConflictError:
            return tool_error(f"{entity} changed elsewhere; re-read and retry")
        except Exception as exc:
            return tool_error(f"{entity} advance failed: {exc}")

    return handler


def build_tools(capabilities: list[dict[str, Any]] | None = None) -> list[tuple]:
    """Return the (name, toolset, schema, handler, tier) tuples a set of
    capability declarations generates. Exposed for tests."""
    caps = CAPABILITIES if capabilities is None else capabilities
    tools: list[tuple] = []
    for cap in caps:
        entity = cap["entity"]
        expose = set((cap.get("agent") or {}).get("expose", []))
        lifecycle = cap.get("lifecycle")
        str_id = {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}
        if "list" in expose:
            props = {"limit": {"type": "number"}}
            if lifecycle:
                props[lifecycle["field"]] = {"type": "string"}
            tools.append((
                f"{entity}_list", entity,
                {"name": f"{entity}_list", "description": f"List {cap['label']} records.",
                 "parameters": {"type": "object", "properties": props}},
                _make_list(cap), "auto",
            ))
        if "get" in expose:
            tools.append((
                f"{entity}_get", entity,
                {"name": f"{entity}_get", "description": f"Get one {cap['label']} record by id.",
                 "parameters": str_id},
                _make_get(cap), "auto",
            ))
        if "create" in expose:
            tools.append((
                f"{entity}_create", entity,
                {"name": f"{entity}_create",
                 "description": f"Create a {cap['label']} record. Requires approval.",
                 "parameters": _create_schema(cap)},
                _make_create(cap), "approval",
            ))
        if "advance" in expose and lifecycle:
            tools.append((
                f"{entity}_advance", entity,
                {"name": f"{entity}_advance",
                 "description": (
                     f"Advance a {cap['label']} record to another {lifecycle['field']} "
                     f"(states: {', '.join(lifecycle['states'])}). Requires approval."
                 ),
                 "parameters": {"type": "object",
                                "properties": {"id": {"type": "string"}, "to": {"type": "string"}},
                                "required": ["id", "to"]}},
                _make_advance(cap), "approval",
            ))
    return tools


def _register() -> None:
    try:
        from hermes_cli.module_permissions import Tier, register_tool_permission
    except Exception:
        register_tool_permission = None  # type: ignore
        Tier = None  # type: ignore

    for name, toolset, schema, handler, tier in build_tools():
        if register_tool_permission is not None and Tier is not None:
            try:
                register_tool_permission(name, Tier.AUTO if tier == "auto" else Tier.APPROVAL)
            except Exception:
                pass
        try:
            registry.register(name=name, toolset=toolset, schema=schema, handler=handler, emoji="")
        except Exception:
            pass


_register()
