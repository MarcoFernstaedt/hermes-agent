"""Tests for the backend module registry."""

import pytest

from hermes_cli.modules import registry
from hermes_cli.modules.registry import ModuleSpec


@pytest.fixture(autouse=True)
def _clean():
    registry._reset_for_tests()
    yield
    registry._reset_for_tests()


class _FakeApp:
    def __init__(self):
        self.included = []

    def include_router(self, router):
        self.included.append(router)


def test_mount_only_modules_with_routers():
    registry.register_module(
        ModuleSpec(id="media", create_router=lambda auth: f"media-router::{auth}")
    )
    registry.register_module(ModuleSpec(id="toolsonly", register_tools=lambda: None))

    app = _FakeApp()
    mounted = registry.mount_modules(app, authorize="AUTH")
    assert mounted == ["media"]
    assert app.included == ["media-router::AUTH"]


def test_register_all_tools_runs_each_registrar():
    calls = []
    registry.register_module(
        ModuleSpec(id="media", register_tools=lambda: calls.append("media"))
    )
    registry.register_module(
        ModuleSpec(id="email", register_tools=lambda: calls.append("email"))
    )
    assert registry.register_all_tools() == ["media", "email"]
    assert calls == ["media", "email"]


def test_run_startup_is_guarded():
    ran = []

    def boom():
        raise RuntimeError("startup exploded")

    registry.register_module(ModuleSpec(id="bad", startup=boom))
    registry.register_module(ModuleSpec(id="good", startup=lambda: ran.append("good")))
    # Must not raise despite the failing hook.
    registry.run_startup()
    assert ran == ["good"]


def test_settings_defaults_merged_by_id():
    registry.register_module(ModuleSpec(id="media", settings_defaults={"volume": 50}))
    registry.register_module(ModuleSpec(id="empty"))
    assert registry.settings_defaults() == {"media": {"volume": 50}}


def test_reregister_replaces():
    registry.register_module(ModuleSpec(id="media", settings_defaults={"v": 1}))
    registry.register_module(ModuleSpec(id="media", settings_defaults={"v": 2}))
    assert len(registry.get_modules()) == 1
    assert registry.settings_defaults() == {"media": {"v": 2}}
