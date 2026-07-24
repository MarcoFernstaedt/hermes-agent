"""Native Obsidian vault agent tools — the SAFE surface.

Share the exact core the dashboard UI uses (hermes_cli.vault). Reads
(search/read/list) are AUTO; append/create are APPROVAL and audited. No
overwrite or delete tool is exposed, so vault_overwrite / vault_delete resolve
to ALWAYS_APPROVAL (fail-safe) — the agent cannot clobber or remove a note.
Every write is atomic + backed up by the core, and every path is validated
against the vault root before touching disk.
"""

from __future__ import annotations

from typing import Any

from tools.registry import registry, tool_error, tool_result


def _available() -> bool:
    try:
        from hermes_cli.vault.config import vault_root

        return vault_root() is not None
    except Exception:
        return False


def _err(exc: Exception) -> str:
    from hermes_cli.vault.config import VaultNotConfigured
    from hermes_cli.vault.notes import VaultExists
    from hermes_cli.vault.paths import VaultPathError

    if isinstance(exc, VaultNotConfigured):
        return tool_error("No Obsidian vault is configured on the server.")
    if isinstance(exc, VaultPathError):
        return tool_error("That path is outside the vault and was refused.")
    if isinstance(exc, VaultExists):
        return tool_error("A note already exists at that path; use append or a new name.")
    if isinstance(exc, FileNotFoundError):
        return tool_error("Note not found.")
    return tool_error(f"Vault tool failed: {type(exc).__name__}: {exc}")


def _audit(action: str, target: str = "", detail: dict | None = None) -> None:
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor="agent", module="vault", tool="vault",
            action=action, target=target, decision="auto", outcome="ok", detail=detail,
        )
    except Exception:
        pass


def _handle_search(args: dict, **kw) -> str:
    from hermes_cli.vault import notes

    try:
        return tool_result({"results": notes.search_notes(str(args.get("query") or ""))})
    except Exception as exc:
        return _err(exc)


def _handle_read(args: dict, **kw) -> str:
    from hermes_cli.vault import notes

    path = args.get("path")
    if not path:
        return tool_error("path is required")
    try:
        note = notes.read_note(str(path))
        # Return the useful bits, not the full re-parse envelope.
        return tool_result({
            "path": note["path"], "title": note["title"], "tags": note["tags"],
            "frontmatter": note["frontmatter"], "body": note["body"],
        })
    except Exception as exc:
        return _err(exc)


def _handle_list(args: dict, **kw) -> str:
    from hermes_cli.vault import notes

    try:
        result = notes.list_notes()
        tag = str(args.get("tag") or "").strip().lstrip("#").lower()
        folder = str(args.get("folder") or "").strip().strip("/")
        if folder:
            result = [n for n in result if n["path"].startswith(folder + "/")]
        if tag:
            # Tag filtering needs each note's tags; read lazily and cheaply.
            filtered = []
            for n in result:
                try:
                    parsed = notes.read_note(n["path"])
                except Exception:
                    continue
                if tag in {t.lower() for t in parsed["tags"]}:
                    filtered.append(n)
            result = filtered
        return tool_result({"notes": result[:200]})
    except Exception as exc:
        return _err(exc)


def _handle_append(args: dict, **kw) -> str:
    from hermes_cli.vault import notes

    path, text = args.get("path"), args.get("text")
    if not path or text is None:
        return tool_error("path and text are required")
    try:
        result = notes.append_to_note(str(path), str(text))
        _audit("note.append", target=str(path), detail={"chars": len(str(text))})
        return tool_result(result)
    except Exception as exc:
        return _err(exc)


def _handle_append_daily(args: dict, **kw) -> str:
    """Append to today's daily note (created if missing). Uses a
    ``daily/YYYY-MM-DD.md`` convention."""
    import datetime

    from hermes_cli.vault import notes

    text = args.get("text")
    if text is None:
        return tool_error("text is required")
    folder = str(args.get("folder") or "daily").strip("/")
    path = f"{folder}/{datetime.date.today().isoformat()}.md"
    try:
        result = notes.append_to_note(path, str(text))
        _audit("daily.append", target=path, detail={"chars": len(str(text))})
        return tool_result(result)
    except Exception as exc:
        return _err(exc)


def _handle_create(args: dict, **kw) -> str:
    from hermes_cli.vault import notes

    path = args.get("path")
    if not path:
        return tool_error("path is required")
    try:
        result = notes.create_note(str(path), str(args.get("content") or ""))
        _audit("note.create", target=str(path))
        return tool_result(result)
    except Exception as exc:
        return _err(exc)


_STR = {"type": "string"}
_SCHEMAS = {
    "vault_search": {"name": "vault_search", "description": "Search the Obsidian vault by content and title.",
                     "parameters": {"type": "object", "properties": {"query": _STR}, "required": ["query"]}},
    "vault_read": {"name": "vault_read", "description": "Read a note from the vault (returns frontmatter, tags, body).",
                   "parameters": {"type": "object", "properties": {"path": _STR}, "required": ["path"]}},
    "vault_list": {"name": "vault_list", "description": "List vault notes, optionally filtered by tag or folder.",
                   "parameters": {"type": "object", "properties": {"tag": _STR, "folder": _STR}}},
    "vault_append": {"name": "vault_append", "description": "Append text to a note (created if missing). Requires approval.",
                     "parameters": {"type": "object", "properties": {"path": _STR, "text": _STR}, "required": ["path", "text"]}},
    "vault_append_daily": {"name": "vault_append_daily", "description": "Append text to today's daily note. Requires approval.",
                           "parameters": {"type": "object", "properties": {"text": _STR, "folder": _STR}, "required": ["text"]}},
    "vault_create": {"name": "vault_create", "description": "Create a new note. Fails if it exists. Requires approval.",
                     "parameters": {"type": "object", "properties": {"path": _STR, "content": _STR}, "required": ["path"]}},
}

_TOOLS = (
    ("vault_search", _SCHEMAS["vault_search"], _handle_search),
    ("vault_read", _SCHEMAS["vault_read"], _handle_read),
    ("vault_list", _SCHEMAS["vault_list"], _handle_list),
    ("vault_append", _SCHEMAS["vault_append"], _handle_append),
    ("vault_append_daily", _SCHEMAS["vault_append_daily"], _handle_append_daily),
    ("vault_create", _SCHEMAS["vault_create"], _handle_create),
)


def _register_permissions() -> None:
    try:
        from hermes_cli.module_permissions import Tier, register_tool_permission

        for name in ("vault_search", "vault_read", "vault_list"):
            register_tool_permission(name, Tier.AUTO)
        for name in ("vault_append", "vault_append_daily", "vault_create"):
            register_tool_permission(name, Tier.APPROVAL)
    except Exception:
        pass


_register_permissions()
for _name, _schema, _handler in _TOOLS:
    try:
        registry.register(name=_name, toolset="vault", schema=_schema,
                          handler=_handler, check_fn=_available, emoji="")
    except Exception:
        pass
