"""Strict worker-scoped Kanban capability policy.

This module is intentionally import-safe for both the model-tool and CLI paths.
It reads only the active profile's config.yaml plus the optional managed-scope
config.yaml. It does not use the forgiving merged loader because parse and I/O
failures must not restore restricted routing mutations.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode

from hermes_constants import get_hermes_home
from hermes_cli.managed_scope import get_managed_dir


_MISSING = object()
_POLICY_PATH = ("kanban", "worker_allow_create")


class _InvalidPolicyConfig(Exception):
    """Internal marker for malformed, unreadable, or structurally invalid policy."""


class WorkerKanbanRoutingPolicyError(PermissionError):
    """A dispatcher worker attempted a policy-restricted routing mutation."""


class _UniqueKeySafeLoader(yaml.SafeLoader):
    """Module-local SafeLoader that rejects ambiguity at every mapping depth."""

    def construct_mapping(self, node: MappingNode, deep: bool = False) -> dict:
        if not isinstance(node, MappingNode):
            raise ConstructorError(
                None,
                None,
                f"expected a mapping node, but found {node.id}",
                node.start_mark,
            )
        self.flatten_mapping(node)
        seen: set[object] = set()
        for key_node, _value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            try:
                duplicate = key in seen
                seen.add(key)
            except TypeError as exc:
                raise ConstructorError(
                    "while constructing a mapping",
                    node.start_mark,
                    "found an unhashable mapping key",
                    key_node.start_mark,
                ) from exc
            if duplicate:
                raise ConstructorError(
                    "while constructing a mapping",
                    node.start_mark,
                    "found a duplicate mapping key",
                    key_node.start_mark,
                )
        return super().construct_mapping(node, deep=deep)


def _strict_mapping(path: Path) -> dict[str, Any] | None:
    """Return a strict YAML mapping, None when absent, or raise on failure."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as exc:
        raise _InvalidPolicyConfig from exc

    meaningful = [
        line
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not meaningful:
        return {}

    try:
        # This loader inherits only PyYAML's SafeLoader constructors; the
        # subclass adds duplicate-key rejection without enabling Python tags.
        parsed = yaml.load(text, Loader=_UniqueKeySafeLoader)
    except yaml.YAMLError as exc:
        raise _InvalidPolicyConfig from exc
    if not isinstance(parsed, dict):
        raise _InvalidPolicyConfig
    return parsed


def _policy_leaf(config: dict[str, Any] | None) -> object:
    """Resolve one source without defaults while validating parent shape."""
    if config is None or "kanban" not in config:
        return _MISSING
    section = config["kanban"]
    if not isinstance(section, dict):
        raise _InvalidPolicyConfig
    if "worker_allow_create" not in section:
        return _MISSING
    value = section["worker_allow_create"]
    if type(value) is not bool:
        raise _InvalidPolicyConfig
    return value


def _strict_worker_allow_create() -> bool:
    """Resolve user then managed policy; any source-integrity failure denies."""
    try:
        user_value = _policy_leaf(_strict_mapping(get_hermes_home() / "config.yaml"))

        managed_value: object = _MISSING
        managed_dir = get_managed_dir()
        if managed_dir is not None:
            managed_value = _policy_leaf(_strict_mapping(managed_dir / "config.yaml"))
    except (OSError, _InvalidPolicyConfig):
        return False

    effective = managed_value if managed_value is not _MISSING else user_value
    if effective is _MISSING:
        return True
    return effective is True


def worker_kanban_routing_allowed() -> bool:
    """Allow create/link unless this dispatcher worker is strictly restricted.

    Human CLI calls and explicit Kanban orchestrators do not carry
    HERMES_KANBAN_TASK and retain their existing behavior. Dispatcher workers
    re-read strict policy on every durable handler/CLI decision.
    """
    if not os.environ.get("HERMES_KANBAN_TASK"):
        return True
    return _strict_worker_allow_create()


def worker_kanban_policy_cache_key() -> bool | None:
    """Return a schema-cache discriminator for the active worker policy."""
    if not os.environ.get("HERMES_KANBAN_TASK"):
        return None
    return _strict_worker_allow_create()


def worker_policy_denial_message(capability: str) -> str:
    """Return one non-sensitive denial message shared by tool and CLI paths."""
    return (
        f"{capability} refused: this dispatcher-spawned worker profile does not "
        f"allow routing mutations under {_POLICY_PATH[0]}.{_POLICY_PATH[1]}"
    )


def require_worker_kanban_routing_allowed(capability: str) -> None:
    """Raise a stable permission error when worker routing is restricted."""
    if not worker_kanban_routing_allowed():
        raise WorkerKanbanRoutingPolicyError(worker_policy_denial_message(capability))
