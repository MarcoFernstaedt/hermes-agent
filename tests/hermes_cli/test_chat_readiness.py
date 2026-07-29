"""Chat must not start a multi-minute build inside a connect handler.

Round-2 recon opened chat on a cold checkout and watched it sit on "Installing
TUI dependencies…" for five minutes, with a 404 session and workers left behind.
The build itself is legitimate; doing it silently while someone waits for a
prompt is not.
"""
from __future__ import annotations

import pytest


def test_bundled_tui_is_ready_with_no_further_checks(monkeypatch, tmp_path):
    from hermes_cli import chat_readiness

    monkeypatch.setattr("hermes_cli.main._find_bundled_tui", lambda *a, **k: tmp_path / "entry.js")
    out = chat_readiness.chat_backend_status()
    assert out["ready"] is True
    assert out["source"] == "bundled"


def test_missing_workspace_is_named_not_guessed(monkeypatch, tmp_path):
    from hermes_cli import chat_readiness

    monkeypatch.setattr("hermes_cli.main._find_bundled_tui", lambda *a, **k: None)
    monkeypatch.setattr(chat_readiness, "_tui_dir", lambda: tmp_path / "absent")
    out = chat_readiness.chat_backend_status()
    assert out["ready"] is False
    assert out["reason"] == "missing"
    assert out["remedy"]


def test_pending_install_is_reported_with_the_command_that_fixes_it(monkeypatch, tmp_path):
    from hermes_cli import chat_readiness

    tui = tmp_path / "ui-tui"
    tui.mkdir()
    monkeypatch.setattr("hermes_cli.main._find_bundled_tui", lambda *a, **k: None)
    monkeypatch.setattr(chat_readiness, "_tui_dir", lambda: tui)
    monkeypatch.setattr("hermes_cli.main._tui_need_npm_install", lambda _root: True)

    out = chat_readiness.chat_backend_status()
    assert out["ready"] is False
    assert out["reason"] == "blocking_build"
    # The owner must be told what to run, not merely that something is wrong.
    assert "hermes chat" in out["remedy"]


def test_stale_bundle_is_reported_too(monkeypatch, tmp_path):
    from hermes_cli import chat_readiness

    tui = tmp_path / "ui-tui"
    tui.mkdir()
    monkeypatch.setattr("hermes_cli.main._find_bundled_tui", lambda *a, **k: None)
    monkeypatch.setattr(chat_readiness, "_tui_dir", lambda: tui)
    monkeypatch.setattr("hermes_cli.main._tui_need_npm_install", lambda _root: False)
    monkeypatch.setattr("hermes_cli.main._tui_need_rebuild", lambda _root: True)

    out = chat_readiness.chat_backend_status()
    assert out["ready"] is False
    assert out["reason"] == "blocking_build"


def test_a_probe_that_raises_never_blocks_chat(monkeypatch, tmp_path):
    """Failing open is correct here: a broken probe must not cost the owner chat."""
    from hermes_cli import chat_readiness

    tui = tmp_path / "ui-tui"
    tui.mkdir()
    monkeypatch.setattr("hermes_cli.main._find_bundled_tui", lambda *a, **k: None)
    monkeypatch.setattr(chat_readiness, "_tui_dir", lambda: tui)

    def boom(_root):
        raise OSError("permission denied")

    monkeypatch.setattr("hermes_cli.main._tui_need_npm_install", boom)
    out = chat_readiness.chat_backend_status()
    assert out["ready"] is True
    assert "permission denied" in out["probe_error"]


def test_a_stale_rebuild_probe_failure_is_advisory_only(monkeypatch, tmp_path):
    from hermes_cli import chat_readiness

    tui = tmp_path / "ui-tui"
    tui.mkdir()
    monkeypatch.setattr("hermes_cli.main._find_bundled_tui", lambda *a, **k: None)
    monkeypatch.setattr(chat_readiness, "_tui_dir", lambda: tui)
    monkeypatch.setattr("hermes_cli.main._tui_need_npm_install", lambda _root: False)

    def boom(_root):
        raise OSError("nope")

    monkeypatch.setattr("hermes_cli.main._tui_need_rebuild", boom)
    assert chat_readiness.chat_backend_status()["ready"] is True


@pytest.mark.parametrize("attr", ["_resolve_chat_argv", "_resolve_chat_argv_async"])
def test_the_probe_is_skipped_when_tests_patch_either_resolver(monkeypatch, attr):
    """Otherwise every existing chat test would need a built TUI to pass.

    Both spellings matter. Checking only the sync resolver broke
    ``test_pty_ws_resolves_argv_through_async_wrapper``, which patches the async
    wrapper alone — the probe ran, refused the connect, and the resolver the
    test was asserting on was never reached.
    """
    from hermes_cli import web_server

    assert web_server._chat_argv_resolver_is_patched() is False
    monkeypatch.setattr(web_server, attr, lambda **kw: ([], None, None))
    assert web_server._chat_argv_resolver_is_patched() is True


@pytest.mark.parametrize("reason", ["missing", "blocking_build"])
def test_every_not_ready_state_carries_a_remedy(monkeypatch, tmp_path, reason):
    """A blocked state with no stated fix is just a nicer-looking hang."""
    from hermes_cli import chat_readiness

    tui = tmp_path / "ui-tui"
    monkeypatch.setattr("hermes_cli.main._find_bundled_tui", lambda *a, **k: None)
    if reason == "blocking_build":
        tui.mkdir()
        monkeypatch.setattr("hermes_cli.main._tui_need_npm_install", lambda _root: True)
    monkeypatch.setattr(chat_readiness, "_tui_dir", lambda: tui)

    out = chat_readiness.chat_backend_status()
    assert out["reason"] == reason
    assert out["detail"] and out["remedy"]
