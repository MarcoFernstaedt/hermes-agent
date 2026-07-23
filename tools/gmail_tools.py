"""Native Gmail agent tools — the SAFE surface (search, read, draft).

These share the exact service the dashboard UI uses (hermes_cli.google.gmail),
so there is one implementation and one encrypted token store. Deliberately no
send or trash tool: sending real mail or destroying it on my behalf requires an
interactive approval prompt wired into the agent dispatch (ALWAYS_APPROVAL,
never auto), which is a separate, testable-against-a-live-session piece. Until
then the agent composes a DRAFT I send myself — it structurally cannot send.

Every write (draft) is recorded to the shared audit log. Permission tiers are
declared so the approval model knows these tools: search/read are AUTO, draft
is APPROVAL; send/trash remain unregistered and therefore fail safe to
ALWAYS_APPROVAL.
"""

from __future__ import annotations

from typing import Any, List

from tools.registry import registry, tool_error, tool_result


def _gmail_available() -> bool:
    try:
        from hermes_cli import secure_store

        tok = secure_store.load_token("google", "default")
        if tok is None:
            return False
        return secure_store.get_status("google", "default") != secure_store.STATUS_NEEDS_REAUTH
    except Exception:
        return False


def _client():
    from hermes_cli.google.gmail import GmailClient

    return GmailClient()


def _err(exc: Exception) -> str:
    from hermes_cli.google import GoogleReauthRequired

    if isinstance(exc, GoogleReauthRequired):
        return tool_error("Gmail needs reauthorization; reconnect Google on the server.")
    return tool_error(f"Gmail tool failed: {type(exc).__name__}: {exc}")


def _as_list(raw: Any) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        return [p.strip() for p in raw.split(",") if p.strip()]
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    return []


def _audit(action: str, target: str = "", detail: dict | None = None) -> None:
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor="agent", module="email", tool="gmail",
            action=action, target=target, decision="auto", outcome="ok", detail=detail,
        )
    except Exception:
        pass


def _handle_gmail_search(args: dict, **kw) -> str:
    from hermes_cli.google.gmail import parse_metadata

    q = args.get("query") or args.get("q")
    try:
        limit = max(1, min(int(args.get("max_results") or 15), 25))
    except (TypeError, ValueError):
        limit = 15
    client = _client()
    try:
        listing = client.list_messages(q=q, max_results=limit)
        rows = [
            parse_metadata(client.get_message(m["id"], fmt="metadata"))
            for m in (listing.get("messages") or [])[:limit]
        ]
        return tool_result({"messages": rows, "nextPageToken": listing.get("nextPageToken")})
    except Exception as exc:
        return _err(exc)


def _handle_gmail_read(args: dict, **kw) -> str:
    from hermes_cli.google.gmail import extract_plain_text, parse_metadata

    mid = args.get("message_id") or args.get("id")
    if not mid:
        return tool_error("message_id is required")
    client = _client()
    try:
        msg = client.get_message(str(mid), fmt="full")
        meta = parse_metadata(msg)
        meta["body_text"] = extract_plain_text(msg)
        return tool_result(meta)
    except Exception as exc:
        return _err(exc)


def _handle_gmail_draft(args: dict, **kw) -> str:
    from hermes_cli.google.compose import build_raw_message

    to = _as_list(args.get("to"))
    if not to:
        return tool_error("to is required (one or more recipients)")
    client = _client()
    try:
        raw = build_raw_message(
            to=to,
            subject=str(args.get("subject") or ""),
            body=str(args.get("body") or ""),
            cc=_as_list(args.get("cc")) or None,
            in_reply_to=args.get("in_reply_to"),
            references=args.get("references"),
        )
        result = client.create_draft(raw, thread_id=args.get("thread_id"))
        _audit("draft.create", target=", ".join(to), detail={"subject": args.get("subject")})
        return tool_result({
            "draft_id": result.get("id"),
            "note": "Draft created for your review. Open Email to send — the agent "
                    "cannot send on your behalf.",
        })
    except Exception as exc:
        return _err(exc)


_STR = {"type": "string"}

GMAIL_SEARCH_SCHEMA = {
    "name": "gmail_search",
    "description": "Search Gmail using Gmail's query syntax (is:unread, from:, subject:, has:attachment, newer_than:7d, label:). Returns message summaries.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": _STR,
            "max_results": {"type": "integer"},
        },
    },
}

GMAIL_READ_SCHEMA = {
    "name": "gmail_read",
    "description": "Read a single Gmail message by id, returning sender, subject, date and the plain-text body.",
    "parameters": {
        "type": "object",
        "properties": {"message_id": _STR},
        "required": ["message_id"],
    },
}

GMAIL_DRAFT_SCHEMA = {
    "name": "gmail_draft",
    "description": "Create a Gmail draft (a new message or a reply) for the user to review and send. This does NOT send — the user sends it themselves.",
    "parameters": {
        "type": "object",
        "properties": {
            "to": {"type": "array", "items": _STR},
            "cc": {"type": "array", "items": _STR},
            "subject": _STR,
            "body": _STR,
            "thread_id": _STR,
            "in_reply_to": _STR,
            "references": _STR,
        },
        "required": ["to"],
    },
}


def _register_permissions() -> None:
    try:
        from hermes_cli.module_permissions import Tier, register_tool_permission

        register_tool_permission("gmail_search", Tier.AUTO)
        register_tool_permission("gmail_read", Tier.AUTO)
        register_tool_permission("gmail_draft", Tier.APPROVAL)
    except Exception:
        pass


_TOOLS = (
    ("gmail_search", GMAIL_SEARCH_SCHEMA, _handle_gmail_search),
    ("gmail_read", GMAIL_READ_SCHEMA, _handle_gmail_read),
    ("gmail_draft", GMAIL_DRAFT_SCHEMA, _handle_gmail_draft),
)

# Self-register on import (tools.registry.discover_builtin_tools imports this).
_register_permissions()
for _name, _schema, _handler in _TOOLS:
    try:
        registry.register(
            name=_name,
            toolset="gmail",
            schema=_schema,
            handler=_handler,
            check_fn=_gmail_available,
            emoji="",
        )
    except Exception:
        pass
