"""Release provenance — what is actually running, so drift is visible.

The on-machine recon found the daily runtime serving an *older* checkout than
the one under test, silently missing new endpoints. That is a security and
usability control failure: you cannot trust the app if you cannot tell which
build is live. This module reports the running backend commit, the frontend
build commit (emitted into ``web_dist/build-info.json`` at build time), the
process start time, and the runtime versions — for a single System surface.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

# Captured once at import — i.e. when the server process started.
_START_MONOTONIC = time.monotonic()
_START_WALL = time.time()


def _repo_root() -> Path:
    # hermes_cli/provenance.py -> repo root is two parents up.
    return Path(__file__).resolve().parent.parent


def _git(*args: str) -> Optional[str]:
    try:
        out = subprocess.run(
            ["git", *args],
            cwd=str(_repo_root()),
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode != 0:
            return None
        return out.stdout.strip() or None
    except Exception:
        return None


@lru_cache(maxsize=1)
def backend_commit() -> dict:
    """The commit the running backend checkout is on (best-effort)."""
    full = _git("rev-parse", "HEAD")
    if full is None:
        return {"commit": "unknown", "commit_short": "unknown", "branch": "unknown", "dirty": None}
    return {
        "commit": full,
        "commit_short": (_git("rev-parse", "--short", "HEAD") or full[:9]),
        "branch": (_git("rev-parse", "--abbrev-ref", "HEAD") or "unknown"),
        "dirty": bool(_git("status", "--porcelain")),
    }


def _web_dist_dir() -> Path:
    return _repo_root() / "hermes_cli" / "web_dist"


def frontend_build_info() -> dict:
    """The frontend build's commit/time from ``web_dist/build-info.json``.

    Absent file → the frontend was never built here (or an old build predating
    provenance) — report that plainly instead of guessing."""
    path = _web_dist_dir() / "build-info.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {
            "commit": data.get("commit", "unknown"),
            "commit_short": data.get("commit_short", "unknown"),
            "branch": data.get("branch", "unknown"),
            "dirty": data.get("dirty"),
            "built_at": data.get("built_at"),
        }
    except Exception:
        return {"commit": "unknown", "commit_short": "unknown", "branch": "unknown",
                "dirty": None, "built_at": None, "available": False}


def collect() -> dict[str, Any]:
    """Everything the System surface needs in one payload."""
    backend = backend_commit()
    frontend = frontend_build_info()
    drift = (
        backend.get("commit") not in {None, "unknown"}
        and frontend.get("commit") not in {None, "unknown"}
        and backend["commit"] != frontend["commit"]
    )
    return {
        "backend": backend,
        "frontend": frontend,
        # True when the served frontend was built from a different commit than
        # the running backend — the exact drift the recon flagged.
        "commit_drift": bool(drift),
        "process": {
            "started_at": _START_WALL,
            "uptime_seconds": round(time.monotonic() - _START_MONOTONIC, 1),
            "python": sys.version.split()[0],
        },
    }
