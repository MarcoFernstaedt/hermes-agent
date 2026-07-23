"""Obsidian vault module.

The vault is a directory of Markdown files that may be open in Obsidian at the
same time, so data loss is unacceptable. Every path is validated against the
vault root (symlinks resolved) before any read or write, every write is atomic
(temp file in the same directory then rename over the target) and takes a
backup first, and the file watcher is debounced so Obsidian's own saves don't
cause a feedback loop.
"""

from hermes_cli.vault.config import VaultNotConfigured, vault_root  # noqa: F401
from hermes_cli.vault.paths import VaultPathError, resolve_in_vault  # noqa: F401
