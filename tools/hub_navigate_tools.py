"""`hub_navigate` — the agent moves the app, within a fence.

"Show me the Henderson deal" should take the owner there. What it must never
become is arbitrary frontend control driven by model output: the agent reads
untrusted content — emails, web pages, news — and a navigation payload is an
obvious injection target.

Two defences, deliberately duplicated rather than shared:

- **Server side (here):** the route must be on the allow-list, and the intent
  must state a reason.
- **Client side (`web/src/lib/hubNavigate.ts`):** the frontend re-validates
  against a list it owns, and builds the URL from validated parts instead of
  trusting a string.

Duplication is the point. A single check is a single thing to get wrong, and
the client is the one actually performing the navigation — it must not execute
a destination merely because the server said so.

Registered AUTO because emitting an *intent* changes nothing by itself: the
frontend still validates it, announces it, and asks before interrupting someone
mid-composition. The consequence lives at the point of consumption.
"""
from __future__ import annotations

from tools.registry import registry, tool_error, tool_result

#: Kept in lockstep with NAVIGABLE_ROUTES in web/src/lib/hubNavigate.ts.
#: A test asserts the two lists match, so adding a route on one side without
#: the other fails the build rather than silently half-working.
NAVIGABLE_ROUTES: tuple[str, ...] = (
    "/now",
    "/sessions",
    "/review",
    "/jobs",
    "/progress",
    "/email",
    "/calendar",
    "/vault",
    "/media",
    "/files",
    "/graph",
    "/search",
    "/capabilities",
    "/settings",
)

_MAX_FRAGMENT = 200


def _fragment_ok(value: str) -> bool:
    if not value:
        return True
    if len(value) > _MAX_FRAGMENT:
        return False
    if value.startswith("//") or ".." in value:
        return False
    if any(c.isspace() for c in value):
        return False
    return not any(c in value for c in '<>"\'`\\:')


def _handle_navigate(args: dict, **_kw) -> str:
    route = str(args.get("route") or "").strip()
    if not route:
        return tool_error("route is required")
    if route not in NAVIGABLE_ROUTES:
        return tool_error(
            f"route {route!r} is not navigable; choose one of: "
            + ", ".join(NAVIGABLE_ROUTES)
        )

    reason = str(args.get("reason") or "").strip()
    if not reason:
        # An unexplained jump is indistinguishable from the app glitching, and
        # the reason is what gets announced before focus moves.
        return tool_error("reason is required — say why you are moving the owner")

    payload: dict[str, str] = {"route": route, "reason": reason}
    for key in ("entity_id", "view", "filter", "range"):
        value = str(args.get(key) or "").strip()
        if not value:
            continue
        if not _fragment_ok(value):
            return tool_error(f"{key} contains characters that are not allowed")
        payload[key] = value

    try:
        from hermes_cli.events import publish  # type: ignore

        publish("hub.navigate", payload)
        delivered = True
    except Exception:
        # No dashboard listening, or no event bus on this runtime. Report the
        # intent rather than failing the turn — the agent said something true
        # ("I would take you there") and the owner simply is not looking.
        delivered = False

    return tool_result({
        "navigated": delivered,
        "route": route,
        "reason": reason,
        "note": (
            "The dashboard was asked to open this route."
            if delivered
            else "No dashboard is listening; nothing moved."
        ),
    })


_SCHEMA = {
    "name": "hub_navigate",
    "description": (
        "Ask the owner's open dashboard to move to one of its routes — use when "
        "they ask to be shown something rather than told about it. Emits an "
        "intent the frontend validates; it announces the destination first and "
        "will ask rather than interrupt someone mid-typing. State a reason: it "
        "is read aloud before the move."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "route": {"type": "string", "enum": list(NAVIGABLE_ROUTES)},
            "reason": {
                "type": "string",
                "description": "Why you are moving them. Announced before focus moves.",
            },
            "entity_id": {"type": "string", "description": "Record to focus on arrival."},
            "view": {"type": "string"},
            "filter": {"type": "string"},
            "range": {"type": "string"},
        },
        "required": ["route", "reason"],
    },
}


def _register_permissions() -> None:
    try:
        from hermes_cli.module_permissions import Tier, register_tool_permission

        register_tool_permission("hub_navigate", Tier.AUTO)
    except Exception:
        pass


_register_permissions()

# Direct top-level registration — the registry's auto-discovery only detects a
# top-level ``registry.register`` call.
registry.register(name="hub_navigate", toolset="hub",
                  schema=_SCHEMA, handler=_handle_navigate, emoji="")
