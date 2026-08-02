"""Note read/write with Obsidian parsing and safe writes.

Writes are atomic (temp file in the same directory, fsync, then ``os.replace``
over the target — never a truncate-then-write) and take a timestamped backup
first (kept outside the vault so Obsidian never sees them). Overwrite/append
can pass the mtime they last saw; a newer mtime on disk raises a conflict
instead of silently clobbering an Obsidian edit.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from hermes_cli.vault.paths import is_markdown, rel_to_vault, resolve_in_vault

_BACKUPS_KEEP = 8


class VaultConflict(Exception):
    """The note changed on disk since the caller last read it."""


class VaultExists(Exception):
    """create_note target already exists."""


# --- parsing ---------------------------------------------------------------

_FM_RE = re.compile(r"^---\n(.*?)\n---\n?", re.DOTALL)
_WIKILINK_RE = re.compile(r"(?<!\!)\[\[([^\]]+?)\]\]")
_EMBED_RE = re.compile(r"\!\[\[([^\]]+?)\]\]")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$", re.MULTILINE)
_TAG_RE = re.compile(r"(?:^|\s)#([A-Za-z0-9_][A-Za-z0-9_/\-]*)")


def parse_frontmatter(text: str) -> Tuple[Dict[str, Any], str]:
    """Split YAML frontmatter (if present) from the body. Parsed with a YAML
    parser, never regex, per the brief."""
    m = _FM_RE.match(text)
    if not m:
        return {}, text
    body = text[m.end():]
    try:
        import yaml

        data = yaml.safe_load(m.group(1)) or {}
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    return data, body


def _link_target(raw: str) -> Dict[str, Optional[str]]:
    """Split a wikilink body ``Note#Heading|Alias`` into parts."""
    alias = None
    if "|" in raw:
        raw, alias = raw.split("|", 1)
    heading = None
    block = None
    if "#^" in raw:
        raw, block = raw.split("#^", 1)
    elif "#" in raw:
        raw, heading = raw.split("#", 1)
    return {
        "target": raw.strip() or None,
        "heading": (heading or "").strip() or None,
        "block": (block or "").strip() or None,
        "alias": (alias or "").strip() or None,
    }


def extract_links(body: str) -> List[Dict[str, Optional[str]]]:
    return [_link_target(m.group(1)) for m in _WIKILINK_RE.finditer(body)]


def extract_embeds(body: str) -> List[Dict[str, Optional[str]]]:
    return [_link_target(m.group(1)) for m in _EMBED_RE.finditer(body)]


def extract_headings(body: str) -> List[Dict[str, Any]]:
    return [
        {"level": len(m.group(1)), "text": m.group(2).strip()}
        for m in _HEADING_RE.finditer(body)
    ]


def extract_tags(body: str, frontmatter: Dict[str, Any]) -> List[str]:
    tags = set()
    for m in _TAG_RE.finditer(body):
        tags.add(m.group(1))
    fm_tags = frontmatter.get("tags")
    if isinstance(fm_tags, str):
        tags.update(t.strip() for t in fm_tags.split(",") if t.strip())
    elif isinstance(fm_tags, list):
        tags.update(str(t).strip() for t in fm_tags if str(t).strip())
    return sorted(tags)


def note_title(rel: str, frontmatter: Dict[str, Any], headings: List[Dict[str, Any]]) -> str:
    fm = frontmatter.get("title")
    if isinstance(fm, str) and fm.strip():
        return fm.strip()
    for h in headings:
        if h["level"] == 1:
            return h["text"]
    return Path(rel).stem


def parse_note(rel: str, text: str) -> Dict[str, Any]:
    fm, body = parse_frontmatter(text)
    headings = extract_headings(body)
    return {
        "path": rel,
        "title": note_title(rel, fm, headings),
        "frontmatter": fm,
        "headings": headings,
        "tags": extract_tags(body, fm),
        "links": extract_links(body),
        "embeds": extract_embeds(body),
        "content": text,
        "body": body,
    }


# --- reads -----------------------------------------------------------------

def read_note(rel: str, *, root: Path | None = None) -> Dict[str, Any]:
    path = resolve_in_vault(rel, root=root)
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(rel)
    text = path.read_text(encoding="utf-8", errors="replace")
    parsed = parse_note(rel_to_vault(path, root=root), text)
    parsed["mtime"] = path.stat().st_mtime
    return parsed


def list_notes(*, root: Path | None = None) -> List[Dict[str, Any]]:
    from hermes_cli.vault.config import require_vault_root

    base = (root or require_vault_root()).resolve()
    out = []
    for path in base.rglob("*"):
        # Skip Obsidian internals and our own backups.
        parts = set(path.relative_to(base).parts)
        if ".obsidian" in parts or ".trash" in parts:
            continue
        if path.is_file() and is_markdown(path):
            st = path.stat()
            out.append({
                "path": path.relative_to(base).as_posix(),
                "title": path.stem,
                "mtime": st.st_mtime,
                "size": st.st_size,
            })
    out.sort(key=lambda n: n["mtime"], reverse=True)
    return out


# --- writes ----------------------------------------------------------------

def _backups_dir() -> Path:
    from hermes_cli.config import get_hermes_home

    d = Path(get_hermes_home()) / "vault-backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _backup(path: Path) -> Optional[Path]:
    if not path.exists():
        return None
    d = _backups_dir()
    # `%S` + pid is not unique: two writes to the same note inside one second
    # from one process produced the same filename, so the second backup
    # overwrote the first. Harmless while backups were only a safety net;
    # actively wrong now that an undo entry points at one — two entries would
    # share a path and the older undo would restore the newer content. A short
    # random suffix makes each snapshot its own file.
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = d / f"{path.stem}.{stamp}.{os.getpid()}.{uuid.uuid4().hex[:8]}.bak"
    shutil.copy2(path, dest)
    # Keep only the most recent few backups for this note stem.
    existing = sorted(d.glob(f"{path.stem}.*.bak"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in existing[_BACKUPS_KEEP:]:
        try:
            old.unlink()
        except OSError:
            pass
    return dest


def content_digest(text: str) -> str:
    """SHA-256 of a note's bytes. The unit the undo contract is written in."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _record_undo(
    rel: str,
    backup: Optional[Path],
    existed: bool,
    *,
    action_id: str,
    preimage_sha256: Optional[str] = None,
    postimage_sha256: Optional[str] = None,
) -> None:
    """Record how to reverse this write. Never blocks the write itself.

    The two hashes are what make the reversal safe rather than merely possible.
    ``preimage_sha256`` is what the note contained before, so the restore can
    check the backup on disk is still the version it was promised.
    ``postimage_sha256`` is what this write is about to put there, so the
    restore can check nothing has changed the note since — and refuse if
    something has.

    The vault is Obsidian's. Between a write and an undo the owner may have
    opened that note and typed in it, and a restore that overwrote those
    keystrokes would be this app deciding it knows better than the person using
    it. The hash is how the app finds out, rather than assuming.

    Imported lazily so `notes` keeps no import-time dependency on the journal,
    and wrapped because a journal that cannot record must not cost the owner a
    save. The failure mode is a lost undo, which is visible in the stack; the
    alternative is a refused write, which is worse and is not this module's
    call to make.
    """
    try:
        from hermes_cli.undo.actions import record_vault_write

        record_vault_write(
            rel=rel,
            backup_path=str(backup) if backup else None,
            existed=existed,
            action_id=action_id,
            preimage_sha256=preimage_sha256,
            postimage_sha256=postimage_sha256,
        )
    except Exception:
        pass


def _atomic_write(path: Path, content: str) -> None:
    """Write to a temp file in the same directory, fsync, then replace — so the
    target is never a partial file and never truncated-then-written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".imptmp.{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def write_note(
    rel: str, content: str, *, expected_mtime: Optional[float] = None, root: Path | None = None
) -> Dict[str, Any]:
    """Overwrite a note (backup first, atomic write). If ``expected_mtime`` is
    given and the file on disk is newer, raise VaultConflict instead of
    clobbering an external edit."""
    path = resolve_in_vault(rel, root=root)
    if expected_mtime is not None and path.exists():
        if path.stat().st_mtime > expected_mtime + 1e-6:
            raise VaultConflict(rel)
    existed = path.exists()
    previous = path.read_text(encoding="utf-8") if existed else ""
    backup = _backup(path)
    # Recorded *before* the write, so there is no window in which the note has
    # changed and nothing knows how to change it back. The backup already
    # exists on disk at this point, so the undo is a promise we can keep at the
    # moment we make it.
    _record_undo(
        rel, backup, existed, action_id="vault.write",
        preimage_sha256=content_digest(previous) if existed else None,
        postimage_sha256=content_digest(content),
    )
    _atomic_write(path, content)
    return {"path": rel, "mtime": path.stat().st_mtime, "bytes": len(content.encode("utf-8"))}


def append_to_note(rel: str, text: str, *, root: Path | None = None) -> Dict[str, Any]:
    """Append text to a note, creating it if missing. Atomic + backup."""
    path = resolve_in_vault(rel, root=root)
    existed = path.exists()
    existing = path.read_text(encoding="utf-8") if existed else ""
    sep = "" if (not existing or existing.endswith("\n")) else "\n"
    backup = _backup(path)
    written = existing + sep + text
    _record_undo(
        rel, backup, existed, action_id="vault.append",
        preimage_sha256=content_digest(existing) if existed else None,
        postimage_sha256=content_digest(written),
    )
    _atomic_write(path, written)
    return {"path": rel, "mtime": path.stat().st_mtime}


def search_notes(query: str, *, root: Path | None = None, limit: int = 50) -> List[Dict[str, Any]]:
    """Case-insensitive search over note titles and content. Returns matches
    with a small context snippet. On-the-fly scan — fine for a personal vault;
    a SQLite FTS index is a later optimization."""
    q = (query or "").strip().lower()
    if not q:
        return []
    results: List[Dict[str, Any]] = []
    for meta in list_notes(root=root):
        try:
            text = resolve_in_vault(meta["path"], root=root).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lower = text.lower()
        title_hit = q in meta["title"].lower()
        idx = lower.find(q)
        if not title_hit and idx < 0:
            continue
        snippet = ""
        if idx >= 0:
            start = max(0, idx - 40)
            snippet = text[start:idx + len(q) + 40].replace("\n", " ").strip()
        results.append({"path": meta["path"], "title": meta["title"], "snippet": snippet})
        if len(results) >= limit:
            break
    return results


def _link_matches(link_target: str, note_path: str) -> bool:
    """Obsidian resolves links by note NAME across the vault, not by path."""
    name = Path(note_path).stem.lower()
    return link_target.strip().lower() in {name, note_path.lower(), Path(note_path).as_posix().lower()}


def backlinks(note_path: str, *, root: Path | None = None) -> List[Dict[str, Any]]:
    """Notes that link to ``note_path`` (matched by note name), each with the
    line of context around the link."""
    out: List[Dict[str, Any]] = []
    for meta in list_notes(root=root):
        if meta["path"] == note_path:
            continue
        try:
            text = resolve_in_vault(meta["path"], root=root).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for link in extract_links(text):
            if link["target"] and _link_matches(link["target"], note_path):
                context = ""
                for line in text.splitlines():
                    if f"[[{link['target']}" in line:
                        context = line.strip()
                        break
                out.append({"path": meta["path"], "title": meta["title"], "context": context})
                break
    return out


def create_note(rel: str, content: str = "", *, root: Path | None = None) -> Dict[str, Any]:
    """Create a new note. Raises VaultExists if it already exists (never
    overwrites via create)."""
    path = resolve_in_vault(rel, root=root)
    if not is_markdown(path):
        path = path.with_suffix(".md")
    if path.exists():
        raise VaultExists(rel)
    # `create_note` is what the agent's `vault_create` tool calls, and it wrote
    # without journaling — so the one path an agent actually takes was the one
    # path with no undo. There is no backup because there was no prior version;
    # the inverse of a create is a delete.
    _record_undo(
        rel_to_vault(path, root=root), None, False, action_id="vault.create",
        postimage_sha256=content_digest(content),
    )
    _atomic_write(path, content)
    return {"path": rel_to_vault(path, root=root), "mtime": path.stat().st_mtime}
