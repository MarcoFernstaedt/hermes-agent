"""Doctor reports enabled jobs that have no scheduler serving their profile."""

import json

from cron.jobs import use_cron_store
from hermes_cli import cron as cron_cli
from hermes_cli import doctor_state


def test_doctor_warns_for_enabled_jobs_without_scheduler(tmp_path, monkeypatch, capsys):
    cron_dir = tmp_path / "cron"
    cron_dir.mkdir()
    (cron_dir / "jobs.json").write_text(json.dumps({"jobs": [
        {"id": "daily", "enabled": True},
        {"id": "disabled", "enabled": False},
    ]}), encoding="utf-8")
    monkeypatch.setattr(cron_cli, "_builtin_gateway_liveness", lambda: False)
    with use_cron_store(tmp_path):
        finding = doctor_state._check_cron_scheduler(False)
    out = capsys.readouterr().out
    assert "1 enabled cron job" in out
    assert "hermes gateway install" in out
    assert any("cron job" in issue for issue in finding.manual_issues)


def test_doctor_does_not_warn_without_enabled_jobs_or_with_a_scheduler(tmp_path, monkeypatch, capsys):
    cron_dir = tmp_path / "cron"
    cron_dir.mkdir()
    jobs_file = cron_dir / "jobs.json"
    for jobs, live in [([], False), ([{"id": "off", "enabled": False}], False),
                       ([{"id": "live", "enabled": True}], True),
                       ([{"id": "unknown", "enabled": True}], None)]:
        jobs_file.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
        monkeypatch.setattr(cron_cli, "_builtin_gateway_liveness", lambda live=live: live)
        with use_cron_store(tmp_path):
            finding = doctor_state._check_cron_scheduler(False)
        assert not finding.manual_issues
        assert "no scheduler" not in capsys.readouterr().out.lower()


def test_doctor_scheduler_warning_is_profile_scoped_and_read_only(tmp_path, monkeypatch, capsys):
    from hermes_cli import doctor
    from hermes_cli import profiles

    assert any(check is doctor._check_cron_scheduler for _, check in doctor.DOCTOR_CHECKS)
    monkeypatch.setattr(cron_cli, "_builtin_gateway_liveness", lambda: False)
    monkeypatch.setattr(profiles, "get_active_profile_name", lambda: "secondary")
    primary = tmp_path / "primary" / "cron"
    secondary = tmp_path / "secondary" / "cron"
    for directory in (primary, secondary):
        directory.mkdir(parents=True)
    primary.joinpath("jobs.json").write_text(json.dumps({"jobs": [{"id": "one", "enabled": True}]}), encoding="utf-8")
    jobs_file = secondary / "jobs.json"
    contents = json.dumps({"jobs": [
        {"id": "two", "enabled": True}, {"id": "paused", "enabled": True, "state": "paused"},
    ]})
    jobs_file.write_text(contents, encoding="utf-8")
    with use_cron_store(secondary.parent):
        finding = doctor_state._check_cron_scheduler(True)
    assert "profile 'secondary'" in capsys.readouterr().out
    assert "1 enabled cron job" in finding.manual_issues[0]
    assert jobs_file.read_text(encoding="utf-8-sig") == contents
