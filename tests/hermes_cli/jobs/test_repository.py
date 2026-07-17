from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest


def test_read_connections_are_query_only(jobs_db):
    from hermes_cli.jobs.repository import JobRepository

    repository = JobRepository(jobs_db)
    repository.migrate()

    with repository._connect(read_only=True) as connection:
        assert connection.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            connection.execute("UPDATE jobs SET status = status")


def test_migration_is_additive_idempotent_and_preserves_source_facts(jobs_db):
    from hermes_cli.jobs.repository import JobRepository

    with sqlite3.connect(jobs_db) as connection:
        before = connection.execute(
            "SELECT company, role_title, source_url, canonical_apply_url, fit_score FROM jobs"
        ).fetchall()

    repository = JobRepository(jobs_db)
    repository.migrate()
    repository.migrate()

    with sqlite3.connect(jobs_db) as connection:
        columns = [row[1] for row in connection.execute("PRAGMA table_info(jobs)")]
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        indexes = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            )
        }
        after = connection.execute(
            "SELECT company, role_title, source_url, canonical_apply_url, fit_score FROM jobs"
        ).fetchall()

    assert columns.count("applied_at") == 1
    assert "status_events" in tables
    assert "idx_status_events_job_changed" in indexes
    assert after == before


def test_list_jobs_filters_and_orders_actionable_fresh_roles(jobs_db):
    from hermes_cli.jobs.repository import JobRepository

    repository = JobRepository(jobs_db)
    repository.migrate()
    with sqlite3.connect(jobs_db) as connection:
        connection.execute(
            """
            INSERT INTO jobs (
                id, campaign_id, company, role_title, normalized_company_title,
                lane, location, work_mode, pay, source_url, canonical_apply_url,
                requisition_id, date_found, freshness_evidence,
                responsibilities_json, requirements_json, fit_score, verdict,
                fit_rationale, gaps_json, blockers_json, recommended_action,
                status, updated_at, applied_at
            ) VALUES (
                2, 1, 'Stale Co', 'QA Analyst', 'stale co qa analyst',
                'quality_assurance', 'Phoenix', 'On-site', '$20/hour',
                'https://source.example/jobs/2', 'https://apply.example/jobs/2',
                'REQ-2', '2026-07-16', NULL, '[]', '[]', 99, 'apply',
                'Fit', '[]', '["Certification"]', 'Review', 'rejected',
                '2026-07-17T00:00:00Z', '2026-07-14T12:00:00Z'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO validation_events VALUES (
                2, 2, 'freshness_check', '2026-07-01T08:00:00Z',
                'https://source.example/jobs/2', 1, 'active'
            )
            """
        )

    result = repository.list_jobs(now=datetime(2026, 7, 17, 12, tzinfo=timezone.utc))
    filtered = repository.list_jobs(
        status="rejected",
        lane="quality_assurance",
        freshness="stale",
        query="qa analyst",
        now=datetime(2026, 7, 17, 12, tzinfo=timezone.utc),
    )

    assert [job["id"] for job in result] == [1, 2]
    assert result[0]["freshness"] == "active"
    assert result[0]["checked_at"] == "2026-07-17T08:00:00Z"
    assert result[0]["gaps"] == ["Minor gap"]
    assert result[0]["blockers"] == []
    assert [job["id"] for job in filtered] == [2]


def test_list_jobs_orders_equal_roles_by_checked_then_date_found(jobs_db):
    from hermes_cli.jobs.repository import JobRepository

    repository = JobRepository(jobs_db)
    repository.migrate()
    with sqlite3.connect(jobs_db) as connection:
        for job_id, date_found in (
            (2, "2026-07-16"),
            (3, "2026-07-17"),
            (4, "2026-07-16"),
        ):
            connection.execute(
                """
                INSERT INTO jobs (
                    id, campaign_id, company, role_title, normalized_company_title,
                    lane, location, work_mode, pay, source_url, canonical_apply_url,
                    requisition_id, date_found, freshness_evidence,
                    responsibilities_json, requirements_json, fit_score, verdict,
                    fit_rationale, gaps_json, blockers_json, recommended_action,
                    status, updated_at, applied_at
                ) VALUES (?, 1, ?, 'Support Engineer', ?, 'technical_support',
                    'Remote', 'Remote', NULL, ?, ?, NULL, ?, NULL, '[]', '[]',
                    92, 'apply', 'Strong fit', '[]', '[]', 'Review packet',
                    'packet_ready_not_applied', '2026-07-17T00:00:00Z', NULL)
                """,
                (
                    job_id,
                    f"Example {job_id}",
                    f"example {job_id} support engineer",
                    f"https://source.example/jobs/{job_id}",
                    f"https://apply.example/jobs/{job_id}",
                    date_found,
                ),
            )
        connection.execute(
            """
            INSERT INTO validation_events VALUES (
                2, 2, 'freshness_check', '2026-07-17T09:00:00Z',
                'https://source.example/jobs/2', 1, 'active'
            )
            """
        )

    result = repository.list_jobs(now=datetime(2026, 7, 17, 12, tzinfo=timezone.utc))

    assert [job["id"] for job in result] == [2, 1, 3, 4]


def test_list_jobs_exposes_only_http_external_links(jobs_db):
    from hermes_cli.jobs.repository import JobRepository

    repository = JobRepository(jobs_db)
    repository.migrate()
    with sqlite3.connect(jobs_db) as connection:
        connection.execute(
            "UPDATE jobs SET source_url = 'javascript:alert(1)' WHERE id = 1"
        )

    job = repository.list_jobs()[0]

    assert job["source_url"] is None
    assert job["apply_url"] == "https://apply.example/jobs/1"


def test_summary_keeps_packet_ready_distinct_and_uses_utc_day_week_boundaries(jobs_db):
    from hermes_cli.jobs.repository import JobRepository

    repository = JobRepository(jobs_db)
    repository.migrate()
    with sqlite3.connect(jobs_db) as connection:
        connection.execute(
            """
            INSERT INTO jobs (
                id, campaign_id, company, role_title, normalized_company_title,
                lane, location, work_mode, pay, source_url, canonical_apply_url,
                requisition_id, date_found, freshness_evidence,
                responsibilities_json, requirements_json, fit_score, verdict,
                fit_rationale, gaps_json, blockers_json, recommended_action,
                status, updated_at, applied_at
            ) VALUES (
                2, 1, 'Applied Co', 'Developer', 'applied co developer',
                'junior_developer', 'Remote', 'Remote', NULL,
                'https://source.example/jobs/2', 'https://apply.example/jobs/2',
                NULL, '2026-07-16', NULL, '[]', '[]', 80, 'stretch',
                'Fit', '[]', '[]', 'Wait', 'pending',
                '2026-07-17T00:00:00Z', '2026-07-13T00:00:00Z'
            )
            """
        )
        connection.execute(
            "INSERT INTO packets VALUES (2, 2, 'Applications/Applied', 'Applications/Applied/Job Information.md', 'Applications/Applied/Application Packet.md', '2026-07-16T00:00:00Z')"
        )

    summary = repository.summary(now=datetime(2026, 7, 17, 12, tzinfo=timezone.utc))

    assert summary["counts"]["qualified_packet_ready"] == 1
    assert summary["counts"]["applied"] == 0
    assert summary["counts"]["pending"] == 1
    assert summary["today_prepared"] == {"current": 1, "target": 300}
    assert summary["week_applied"] == {"current": 1, "target": 1500}
    assert summary["campaign_stop"] is False


def test_source_pipeline_statuses_remain_filterable_and_closed_counts_as_expired(
    jobs_db,
):
    from hermes_cli.jobs.repository import JobRepository

    repository = JobRepository(jobs_db)
    repository.migrate()
    with sqlite3.connect(jobs_db) as connection:
        connection.execute("UPDATE jobs SET status = 'closed' WHERE id = 1")

    roles = repository.list_jobs(status="closed")
    summary = repository.summary()

    assert [role["id"] for role in roles] == [1]
    assert summary["counts"]["expired"] == 1


def test_status_transition_rejects_a_stale_observation_without_overwriting(jobs_db):
    from hermes_cli.jobs.repository import JobRepository, StaleJobError

    repository = JobRepository(jobs_db)
    repository.migrate()
    first = repository.transition_status(
        1,
        "applied",
        expected_status="packet_ready_not_applied",
        expected_updated_at="2026-07-17T00:00:00Z",
        changed_at=datetime(2026, 7, 17, 13, tzinfo=timezone.utc),
    )

    with pytest.raises(StaleJobError) as caught:
        repository.transition_status(
            1,
            "withdrawn",
            expected_status="packet_ready_not_applied",
            expected_updated_at="2026-07-17T00:00:00Z",
            changed_at=datetime(2026, 7, 17, 14, tzinfo=timezone.utc),
        )

    assert first["status"] == "applied"
    assert caught.value.current == {
        "id": 1,
        "status": "applied",
        "updated_at": "2026-07-17T13:00:00Z",
        "applied_at": "2026-07-17T13:00:00Z",
    }
    with sqlite3.connect(jobs_db) as connection:
        row = connection.execute(
            "SELECT status, updated_at FROM jobs WHERE id = 1"
        ).fetchone()
        events = connection.execute(
            "SELECT from_status, to_status FROM status_events ORDER BY id"
        ).fetchall()
    assert row == ("applied", "2026-07-17T13:00:00Z")
    assert events == [("packet_ready_not_applied", "applied")]


@pytest.mark.parametrize(
    ("source", "target"),
    [
        ("packet_ready_not_applied", "applied"),
        ("packet_ready_not_applied", "withdrawn"),
        ("packet_ready_not_applied", "duplicate"),
        ("packet_ready_not_applied", "expired"),
        ("applied", "pending"),
        ("applied", "interviewing"),
        ("applied", "rejected"),
        ("applied", "withdrawn"),
        ("applied", "expired"),
        ("applied", "offer_received"),
        ("pending", "interviewing"),
        ("pending", "rejected"),
        ("pending", "withdrawn"),
        ("pending", "expired"),
        ("pending", "offer_received"),
        ("interviewing", "rejected"),
        ("interviewing", "withdrawn"),
        ("interviewing", "expired"),
        ("interviewing", "offer_received"),
        ("offer_received", "offer_accepted"),
        ("offer_received", "rejected"),
        ("offer_received", "withdrawn"),
    ],
)
def test_every_valid_status_transition_is_audited(jobs_db, source, target):
    from hermes_cli.jobs.repository import JobRepository

    repository = JobRepository(jobs_db)
    repository.migrate()
    with sqlite3.connect(jobs_db) as connection:
        connection.execute("UPDATE jobs SET status = ? WHERE id = 1", (source,))

    result = repository.transition_status(
        1,
        target,
        expected_status=source,
        expected_updated_at="2026-07-17T00:00:00Z",
        changed_at=datetime(2026, 7, 17, 13, tzinfo=timezone.utc),
    )

    with sqlite3.connect(jobs_db) as connection:
        job = connection.execute(
            "SELECT status, updated_at, applied_at FROM jobs WHERE id = 1"
        ).fetchone()
        events = connection.execute(
            "SELECT from_status, to_status, changed_at, actor FROM status_events"
        ).fetchall()
    assert job[0] == target
    assert job[1] == "2026-07-17T13:00:00Z"
    assert job[2] == ("2026-07-17T13:00:00Z" if target == "applied" else None)
    assert events == [(source, target, "2026-07-17T13:00:00Z", "dashboard")]
    assert result["campaign_stop"] is (target == "offer_accepted")


@pytest.mark.parametrize(
    ("source", "target"),
    [
        ("packet_ready_not_applied", "pending"),
        ("rejected", "applied"),
        ("offer_accepted", "rejected"),
        ("applied", "applied"),
    ],
)
def test_invalid_status_transitions_change_nothing(jobs_db, source, target):
    from hermes_cli.jobs.repository import InvalidTransitionError, JobRepository

    repository = JobRepository(jobs_db)
    repository.migrate()
    with sqlite3.connect(jobs_db) as connection:
        connection.execute("UPDATE jobs SET status = ? WHERE id = 1", (source,))

    with pytest.raises(InvalidTransitionError):
        repository.transition_status(
            1,
            target,
            expected_status=source,
            expected_updated_at="2026-07-17T00:00:00Z",
            changed_at=datetime(2026, 7, 17, 13, tzinfo=timezone.utc),
        )

    with sqlite3.connect(jobs_db) as connection:
        assert (
            connection.execute("SELECT status FROM jobs WHERE id = 1").fetchone()[0]
            == source
        )
        assert (
            connection.execute("SELECT COUNT(*) FROM status_events").fetchone()[0] == 0
        )
