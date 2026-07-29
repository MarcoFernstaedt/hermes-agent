"""The agent's view of *now* — the volatile context tier as a tool.

The locked two-tier architecture keeps the system prompt byte-stable so upstream
prompt caches stay warm, which means nothing recency-ordered may ever live
there. Everything volatile is pulled instead, and this is the puller.

Registered AUTO: assembling context is read-only and local, so gating it behind
an approval would only teach the agent not to bother. That is not hypothetical —
round-2 recon found zero calls to this tool across thirty days, because it had
never been implemented, and the resulting agent had no cheap way to learn what
was waiting on the owner before answering.
"""
from __future__ import annotations

from tools.registry import registry, tool_result


def _handle_hub_context(args: dict, **_kw) -> str:
    from hermes_cli.hub_context import collect_hub_context

    sections = args.get("sections")
    if isinstance(sections, str):
        sections = [s.strip() for s in sections.split(",") if s.strip()]
    if sections is not None and not isinstance(sections, list):
        sections = None
    return tool_result(collect_hub_context(sections))


_SCHEMA = {
    "name": "hub_context",
    "description": (
        "Get what is true right now across the owner's hub: what needs their "
        "attention, jobs ready to send, proposals awaiting approval, whether "
        "the agent is halted, tracked items due or overdue, and platform "
        "health. Read-only and local. Call this at the start of a turn when "
        "the answer depends on current state rather than on general knowledge — "
        "this information is deliberately kept out of the system prompt so the "
        "prompt cache stays warm, so it is not in your context unless you ask."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "sections": {
                "type": "array",
                "items": {
                    "type": "string",
                    "enum": ["jobs", "review", "guardrails", "capabilities", "health"],
                },
                "description": "Limit the payload to these sections. Omit for all of them.",
            },
        },
    },
}


def _register_permissions() -> None:
    try:
        from hermes_cli.module_permissions import Tier, register_tool_permission

        register_tool_permission("hub_context", Tier.AUTO)
    except Exception:
        pass


_register_permissions()

# Direct top-level registration: the registry's auto-discovery only detects a
# top-level ``registry.register`` call, so a loop-wrapped or conditional
# registration would leave this tool invisible to the agent.
registry.register(name="hub_context", toolset="hub",
                  schema=_SCHEMA, handler=_handle_hub_context, emoji="")
