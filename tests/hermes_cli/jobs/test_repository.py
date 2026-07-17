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


def test_summary_counts_only_todays_qualified_live_validated_complete_packets(
    jobs_db,
):
    from hermes_cli.jobs.repository import JobRepository

    repository = JobRepository(jobs_db)
    repository.migrate()
    with sqlite3.connect(jobs_db) as connection:
        for job_id, status, verdict, validated_at, checked_at, success, details in (
            # Phoenix campaign day starts at 07:00Z. Only this row qualifies.
            (
                2,
                "packet_ready_not_applied",
                "apply",
                "2026-07-17T07:00:00Z",
                "2026-07-17T11:00:00Z",
                1,
                "active",
            ),
            (
                3,
                "applied",
                "apply",
                "2026-07-17T08:00:00Z",
                "2026-07-17T11:00:00Z",
                1,
                "active",
            ),
            (
                4,
                "packet_ready_not_applied",
                "skip",
                "2026-07-17T08:00:00Z",
                "2026-07-17T11:00:00Z",
                1,
                "active",
            ),
            (
                5,
                "packet_ready_not_applied",
                "stretch",
                "2026-07-17T08:00:00Z",
                "2026-07-17T11:00:00Z",
                0,
                "unavailable",
            ),
            (
                6,
                "packet_ready_not_applied",
                "stretch",
                "2026-07-17T08:00:00Z",
                "2026-07-17T11:00:00Z",
                1,
                "closed",
            ),
            (
                7,
                "packet_ready_not_applied",
                "stretch",
                "2026-07-17T08:00:00Z",
                "2026-07-09T11:00:00Z",
                1,
                "active",
            ),
            (
                8,
                "packet_ready_not_applied",
                "stretch",
                "2026-07-17T06:59:59Z",
                "2026-07-17T11:00:00Z",
                1,
                "active",
            ),
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
                ) SELECT ?, campaign_id, ?, role_title, ?, lane, location, work_mode,
                    pay, ?, ?, NULL, '2026-07-17', freshness_evidence,
                    responsibilities_json, requirements_json, fit_score, ?,
                    fit_rationale, gaps_json, blockers_json, recommended_action,
                    ?, updated_at, NULL
                FROM jobs WHERE id = 1
                """,
                (
                    job_id,
                    f"Example {job_id}",
                    f"example {job_id}",
                    f"https://source.example/jobs/{job_id}",
                    f"https://apply.example/jobs/{job_id}",
                    verdict,
                    status,
                ),
            )
            connection.execute(
                "INSERT INTO packets VALUES (?, ?, ?, ?, ?, ?)",
                (
                    job_id,
                    job_id,
                    f"Applications/{job_id}",
                    f"Applications/{job_id}/Job Information.md",
                    f"Applications/{job_id}/Application Packet.md",
                    validated_at,
                ),
            )
            connection.execute(
                "INSERT INTO validation_events VALUES (?, ?, 'freshness_check', ?, ?, ?, ?)",
                (
                    job_id,
                    job_id,
                    checked_at,
                    f"https://source.example/jobs/{job_id}",
                    success,
                    details,
                ),
            )
        # A packet row with missing required packet paths is not packet-complete.
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
                9, 1, 'Incomplete Co', 'Developer', 'incomplete co developer',
                'junior_developer', 'Remote', 'Remote', NULL,
                'https://source.example/jobs/9', 'https://apply.example/jobs/9',
                NULL, '2026-07-17', NULL, '[]', '[]', 80, 'stretch',
                'Fit', '[]', '[]', 'Review', 'packet_ready_not_applied',
                '2026-07-17T00:00:00Z', NULL
            )
            """
        )
        connection.execute(
            "INSERT INTO packets VALUES (9, 9, 'Applications/9', '', 'Applications/9/Application Packet.md', '2026-07-17T08:00:00Z')"
        )
        connection.execute(
            "INSERT INTO validation_events VALUES (9, 9, 'freshness_check', '2026-07-17T11:00:00Z', 'https://source.example/jobs/9', 1, 'active')"
        )

    summary = repository.summary(now=datetime(2026, 7, 17, 12, tzinfo=timezone.utc))

    assert summary["agent_today_qualified"] == {"current": 1, "target": 300}
    assert summary["counts"]["packet_ready"] == 8
    assert summary["counts"]["applied"] == 1
    assert summary["counts"]["total"] == 9
    assert summary["campaign_stop"] is False


def test_summary_uses_phoenix_week_boundaries_for_manual_applications(jobs_db):
    from hermes_cli.jobs.repository import JobRepository

    repository = JobRepository(jobs_db)
    repository.migrate()
    with sqlite3.connect(jobs_db) as connection:
        for job_id, applied_at in (
            (2, "2026-07-13T06:59:59Z"),
            (3, "2026-07-13T07:00:00Z"),
            (4, "2026-07-20T06:59:59+00:00"),
            (5, "2026-07-20T07:00:00Z"),
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
                ) SELECT ?, campaign_id, ?, role_title, ?, lane, location, work_mode,
                    pay, ?, ?, NULL, date_found, freshness_evidence,
                    responsibilities_json, requirements_json, fit_score, verdict,
                    fit_rationale, gaps_json, blockers_json, recommended_action,
                    'pending', updated_at, ?
                FROM jobs WHERE id = 1
                """,
                (
                    job_id,
                    f"Applied {job_id}",
                    f"applied {job_id}",
                    f"https://source.example/jobs/{job_id}",
                    f"https://apply.example/jobs/{job_id}",
                    applied_at,
                ),
            )

    summary = repository.summary(now=datetime(2026, 7, 17, 12, tzinfo=timezone.utc))

    assert summary["your_week_applied"] == {"current": 2, "target": 1500}
    # Packet generation and packet-ready status never imply a manual application.
    assert summary["counts"]["packet_ready"] == 1


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
