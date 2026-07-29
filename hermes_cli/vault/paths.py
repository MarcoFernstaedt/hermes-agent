"""Path validation — the vault's security keystone.

A note path can never escape the vault root. Every candidate is resolved
(symlinks and ``..`` included) and must land strictly inside the resolved
vault root, or it is rejected. This runs before every read and write.
"""

from __future__ import annotations

from pathlib import Path
from typing import Union

from hermes_cli.vault.config import require_vault_root


class VaultPathError(Exception):
    """A path escaped the vault root, or is otherwise invalid."""


def resolve_in_vault(rel_path: Union[str, Path], *, root: Path | None = None) -> Path:
    """Resolve ``rel_path`` (relative to the vault root) to a real path that is
    guaranteed to be inside the vault. Raises ``VaultPathError`` otherwise.

    Absolute inputs are allowed only if they already point inside the vault;
    an absolute path elsewhere, a ``..`` traversal, or a symlink pointing out
    of the vault all raise.
    """
    base = (root or require_vault_root()).resolve()
    raw = Path(rel_path)

    candidate = raw if raw.is_absolute() else (base / raw)
    # Resolve symlinks and ``..``. strict=False so not-yet-existing targets
    # (a new note) still normalise; their parent chain is still checked.
    resolved = candidate.resolve()

    if resolved != base and base not in resolved.parents:
        raise VaultPathError(f"Path escapes the vault: {rel_path!r}")
    return resolved


def rel_to_vault(path: Path, *, root: Path | None = None) -> str:
    """Return the vault-relative POSIX path for display/index keys."""
    base = (root or require_vault_root()).resolve()
    return path.resolve().relative_to(base).as_posix()


def is_markdown(path: Path) -> bool:
    return path.suffix.lower() in {".md", ".markdown"}
