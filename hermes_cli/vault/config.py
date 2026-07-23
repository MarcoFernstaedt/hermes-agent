"""Vault location resolution."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional


class VaultNotConfigured(Exception):
    """No vault directory has been configured."""


def vault_root() -> Optional[Path]:
    """Resolve the configured Obsidian vault directory, or None if unset.

    Reads ``HERMES_VAULT_PATH`` first, then ``vault.path`` in config.yaml.
    Returns the real (symlink-resolved) directory if it exists.
    """
    raw = os.environ.get("HERMES_VAULT_PATH", "").strip()
    if not raw:
        try:
            from hermes_cli.config import cfg_get, load_config

            raw = str(cfg_get(load_config(), "vault", "path", default="") or "").strip()
        except Exception:
            raw = ""
    if not raw:
        return None
    path = Path(raw).expanduser()
    try:
        resolved = path.resolve()
    except OSError:
        return None
    return resolved if resolved.is_dir() else None


def require_vault_root() -> Path:
    root = vault_root()
    if root is None:
        raise VaultNotConfigured(
            "No Obsidian vault configured. Set HERMES_VAULT_PATH or vault.path in config."
        )
    return root
