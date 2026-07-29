"""Platform self-observation / health aggregation."""
from __future__ import annotations

import pytest


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "state").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setattr("hermes_constants.get_hermes_home", lambda: h)
    return h


def test_health_shape_and_ok(home):
    from hermes_cli import health

    out = health.collect_health()
    assert set(out["sections"]) == {"build", "capabilities", "review", "guardrails"}
    assert out["status"] in {"ok", "warn", "error", "unknown"}
    # A clean install: capabilities load, no review backlog.
    assert out["sections"]["capabilities"]["status"] in {"ok", "unknown"}


def test_health_flags_rejected_capability(home, monkeypatch):
    from hermes_cli import health
    from hermes_cli.capabilities import declarations as decl

    # Simulate a rejected declaration.
    monkeypatch.setattr(decl, "LOAD_ERRORS", [{"source": "x.json", "id": "bad", "errors": ["nope"]}])
    monkeypatch.setattr(decl, "load_capabilities", lambda: [])
    out = health.collect_health()
    assert out["sections"]["capabilities"]["status"] == "error"
    assert out["status"] == "error"  # worst-of rolls up


def test_health_flags_guardrail_failures(home):
    from hermes_cli import audit_log, health

    audit_log.record(actor="agent", module="agent_guards", tool="email_send",
                     action="outbound_secret_detected", outcome="refused", detail={})
    out = health.collect_health()
    g = out["sections"]["guardrails"]
    assert g["refused_or_failed"] >= 1
    assert any(c["key"].startswith("agent_guards:") for c in g["clusters"])


def test_improvement_proposal_acknowledged_on_approve(home):
    from hermes_cli.review.store import ReviewStore
    from hermes_cli.review.handlers import apply_payload

    store = ReviewStore(home / "state" / "review.sqlite3")
    p = store.create(kind="improvement", title="Retire dead capability",
                     payload={"action": "retire capability 'ghost'"})
    store.approve(p["id"])
    outcome = apply_payload("improvement", p["payload"])
    assert "acknowledged" in outcome


def test_build_health_reports_version(home):
    from hermes_cli import health
    from hermes_cli import __version__

    build = health.collect_health()["sections"]["build"]
    assert build["version"] == __version__
    # No installed distribution in a checkout-only run → no drift claimed.
    assert build["version_drift"] is False


def test_build_health_warns_on_version_drift(home, monkeypatch):
    """An installed wheel reporting a different version than the running code
    is surfaced as a warning, not silently ignored."""
    from hermes_cli import health, provenance

    real = provenance.collect()
    drifted = dict(real)
    drifted["runtime"] = {**real["runtime"], "installed_version": "9.9.9", "version_drift": True}
    monkeypatch.setattr(provenance, "collect", lambda: drifted)

    build = health.collect_health()["sections"]["build"]
    assert build["version_drift"] is True
    assert build["status"] == "warn"
    assert build["installed_version"] == "9.9.9"


def test_runtime_identity_shape():
    """Version identity comes from one place and describes what is running."""
    from hermes_cli import provenance, __version__, __release_date__

    provenance.runtime_identity.cache_clear()
    r = provenance.runtime_identity()
    assert r["version"] == __version__
    assert r["release_date"] == __release_date__
    assert r["package_path"].endswith("hermes_cli")
    assert r["source"] in {"installed", "checkout"}
    # version_drift is only ever claimed when an installed dist exists.
    assert r["version_drift"] is (bool(r["installed_version"]) and r["installed_version"] != __version__)
