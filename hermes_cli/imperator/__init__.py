"""Imperator module SDK.

An Imperator *module* is a self-contained feature packaged the way Hermes's own
dashboard extensions are (verified against ``plugins/kanban``): a directory with
a ``dashboard/manifest.json`` describing a tab, an optional ``plugin_api.py``
exposing a FastAPI ``APIRouter`` that the dashboard mounts at
``/api/plugins/<name>/``, and a JS bundle that renders the tab. Capability-shaped
modules additionally carry a capability declaration (see
``hermes_cli.capabilities``) so their board/table/form UI and their agent tools
are generated from one document.

This package provides the scaffolding that emits that structure, so a new module
is authored by filling in a declaration rather than by hand-editing the router,
the nav, or the tool registry.
"""

from hermes_cli.imperator.module_scaffold import (
    ModuleSpec,
    scaffold_module,
)

__all__ = ["ModuleSpec", "scaffold_module"]
