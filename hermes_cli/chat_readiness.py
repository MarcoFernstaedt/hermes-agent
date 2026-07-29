"""Is the chat backend actually ready to start?

Dashboard chat spawns the TUI in a PTY, and `_make_tui_argv` will, on a cold
checkout, run `npm install` and an esbuild inside that spawn. Round-2 on-machine
recon opened chat and watched it sit on "Installing TUI dependencies…" for five
minutes, with the session endpoint returning 404, and workers left behind after
the browser closed. From the owner's side it looked like chat was broken; in
fact it was building, unbounded, inside a connect handler.

Building is a legitimate thing to do. Doing it silently while someone waits for
a chat prompt, with no progress and no way out, is not. So the dashboard checks
first: if the backend is ready, connect as before; if it is not, say so in one
sentence with the exact command that fixes it, and do not start a multi-minute
build behind a spinner.

This is a stopgap ahead of the native structured chat client, which removes the
PTY path entirely. It is deliberately cheap — filesystem checks only, no
subprocess — so it can run on every connect and be polled by the UI.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any


def _tui_dir() -> Path:
    from hermes_cli.main import PROJECT_ROOT

    return PROJECT_ROOT / "ui-tui"


def chat_backend_status() -> dict[str, Any]:
    """Report whether chat can start now, and if not, exactly why.

    ``ready`` means a connect will reach a prompt without building anything.
    ``blocking_build`` means the pieces are present but a connect would trigger
    an install or a bundle first — the state that produced the five-minute hang.
    """
    from hermes_cli.main import (
        _find_bundled_tui,
        _tui_need_npm_install,
        _tui_need_rebuild,
    )

    tui_dir = _tui_dir()

    # A packaged/prebuilt bundle needs nothing at all.
    try:
        if _find_bundled_tui() is not None:
            return {"ready": True, "source": "bundled"}
    except Exception:
        pass

    if not tui_dir.is_dir():
        return {
            "ready": False,
            "reason": "missing",
            "detail": f"The chat interface is not present at {tui_dir}.",
            "remedy": "Reinstall Hermes, or check out the full repository.",
        }

    try:
        needs_install = _tui_need_npm_install(tui_dir)
    except Exception as exc:  # a probe that raises must not break chat
        return {"ready": True, "source": "unknown", "probe_error": str(exc)}

    if needs_install:
        return {
            "ready": False,
            "reason": "blocking_build",
            "detail": (
                "Chat's dependencies are not installed. Starting a chat would run "
                "npm install first, which can take several minutes with no progress "
                "shown, so it is not done automatically."
            ),
            "remedy": "Run `hermes chat` once in a terminal to build it, then reopen chat here.",
        }

    try:
        if _tui_need_rebuild(tui_dir):
            return {
                "ready": False,
                "reason": "blocking_build",
                "detail": "Chat's interface bundle is out of date and would be rebuilt on connect.",
                "remedy": "Run `hermes chat` once in a terminal to rebuild it, then reopen chat here.",
            }
    except Exception:
        # Rebuild detection is advisory; never block chat on the probe itself.
        pass

    return {"ready": True, "source": "workspace"}
