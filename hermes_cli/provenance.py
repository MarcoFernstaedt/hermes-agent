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


@lru_cache(maxsize=1)
def runtime_identity() -> dict[str, Any]:
    """Which Hermes is actually serving this dashboard.

    The recon found the sidebar reporting ``v0.18.2`` while ``hermes --version``
    on the same machine reported ``v0.19.0``. Both were telling the truth about
    different things: the dashboard reports the *source tree it imported*, the
    CLI reports whatever install is first on PATH. When a checkout shadows an
    installed wheel, those diverge silently and every version number on screen
    becomes untrustworthy.

    So report both, from one place, with no subprocess: the imported package's
    version and location, and the installed distribution's version and location
    as recorded in package metadata. ``version_drift`` is true only when a
    distribution is installed *and* its version differs from the code that is
    actually running — the precise "two Hermeses" condition.
    """
    from hermes_cli import __release_date__, __version__

    package_path = str(Path(__file__).resolve().parent)
    installed_version: Optional[str] = None
    installed_path: Optional[str] = None
    try:
        import importlib.metadata as _md

        dist = _md.distribution("hermes-agent")
        installed_version = dist.version
        located = dist.locate_file("hermes_cli")
        installed_path = str(Path(str(located)).resolve())
    except Exception:
        # No metadata (running straight from a checkout) — nothing to compare
        # against, which is itself the common, healthy case.
        pass

    return {
        "version": __version__,
        "release_date": __release_date__,
        "package_path": package_path,
        "installed_version": installed_version,
        "installed_path": installed_path,
        # True when an installed distribution reports a different version than
        # the source tree this process imported.
        "version_drift": bool(installed_version and installed_version != __version__),
        # Where the running code came from, in one word.
        "source": (
            "installed"
            if installed_path and installed_path == package_path
            else "checkout"
        ),
    }


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
        "runtime": runtime_identity(),
        # True when the served frontend was built from a different commit than
        # the running backend — the exact drift the recon flagged.
        "commit_drift": bool(drift),
        "process": {
            "started_at": _START_WALL,
            "uptime_seconds": round(time.monotonic() - _START_MONOTONIC, 1),
            "python": sys.version.split()[0],
        },
    }
