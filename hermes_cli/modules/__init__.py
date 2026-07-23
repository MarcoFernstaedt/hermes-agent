"""Backend module registry.

A module is a self-contained feature area with a single backend service and two
consumers: the UI (a FastAPI router) and the agent (registered tools). This
package is the seam that mounts them uniformly, so adding a module is one
``register_module(ModuleSpec(...))`` call rather than hand-editing the router
list, the tool registry and the startup migrations separately.
"""

from hermes_cli.modules.registry import (  # noqa: F401
    ModuleSpec,
    get_modules,
    mount_modules,
    register_all_tools,
    register_module,
    run_startup,
)
