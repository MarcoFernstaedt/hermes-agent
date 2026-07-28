from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest


PRODUCTION_JOBS_COLUMNS = """
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL,
    company TEXT NOT NULL,
    role_title TEXT NOT NULL,
    normalized_company_title TEXT NOT NULL,
    lane TEXT NOT NULL,
    location TEXT NOT NULL,
    work_mode TEXT NOT NULL,
    pay TEXT,
    source_url TEXT NOT NULL,
    canonical_apply_url TEXT NOT NULL,
    requisition_id TEXT,
    date_found TEXT NOT NULL,
    freshness_evidence TEXT,
    responsibilities_json TEXT NOT NULL,
    requirements_json TEXT NOT NULL,
    fit_score INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    fit_rationale TEXT NOT NULL,
    gaps_json TEXT NOT NULL,
    blockers_json TEXT NOT NULL,
    recommended_action TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL
"""


def create_production_database(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.executescript(
            f"""
            CREATE TABLE campaigns (
                id INTEGER PRIMARY KEY,
                campaign_key TEXT NOT NULL,
                target_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE jobs ({PRODUCTION_JOBS_COLUMNS});
            CREATE TABLE packets (
                id INTEGER PRIMARY KEY,
                job_id INTEGER NOT NULL,
                folder_path TEXT NOT NULL,
                job_information_path TEXT NOT NULL,
                application_packet_path TEXT NOT NULL,
                validated_at TEXT NOT NULL
            );
            CREATE TABLE assets (
                id INTEGER PRIMARY KEY,
                packet_id INTEGER NOT NULL,
                asset_type TEXT NOT NULL,
                path TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                validation_json TEXT NOT NULL
            );
            CREATE TABLE validation_events (
                id INTEGER PRIMARY KEY,
                job_id INTEGER,
                event_type TEXT NOT NULL,
                checked_at TEXT NOT NULL,
                source_url TEXT,
                success INTEGER NOT NULL,
                details TEXT NOT NULL
            );
            """
        )
        connection.execute(
            """
            INSERT INTO campaigns
                (id, campaign_key, target_count, status, started_at, updated_at)
            VALUES (1, 'campaign', 300, 'active', '2026-07-16T00:00:00Z', '2026-07-17T00:00:00Z')
            """
        )
        connection.execute(
            """
            INSERT INTO jobs VALUES (
                1, 1, 'Example Co', 'Support Engineer', 'example co support engineer',
                'technical_support', 'Remote', 'Remote', NULL,
                'https://source.example/jobs/1', 'https://apply.example/jobs/1', 'REQ-1',
                '2026-07-17', 'checked', '["Support users"]', '["Linux"]', 92,
                'apply', 'Strong fit', '["Minor gap"]', '[]', 'Review packet',
                'packet_ready_not_applied', '2026-07-17T00:00:00Z'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO packets VALUES (
                1, 1, 'Applications/Example Co/Support Engineer',
                'Applications/Example Co/Support Engineer/Job Information.md',
                'Applications/Example Co/Support Engineer/Application Packet.md',
                '2026-07-17T00:00:00Z'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO assets VALUES (
                1, 1, 'application_packet',
                'Applications/Example Co/Support Engineer/Application Packet.md',
                'abc', '{}'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO validation_events VALUES (
                1, 1, 'freshness_check', '2026-07-17T08:00:00Z',
                'https://source.example/jobs/1', 1, 'active'
            )
            """
        )


@pytest.fixture
def jobs_db(tmp_path: Path) -> Path:
    path = tmp_path / "jobs.sqlite3"
    create_production_database(path)
    return path


@pytest.fixture
def packet_root(tmp_path: Path) -> Path:
    root = tmp_path / "Applications"
    folder = root / "Example Co" / "Support Engineer"
    folder.mkdir(parents=True)
    (folder / "Application Packet.md").write_text("packet", encoding="utf-8")
    return root
