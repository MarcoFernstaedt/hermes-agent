from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest


def test_asset_metadata_and_resolution_never_expose_stored_paths(jobs_db, packet_root):
    from hermes_cli.jobs.assets import JobAssetStore

    store = JobAssetStore(jobs_db, packet_root)

    assets = store.list_for_job(1)
    resolved = store.resolve(1, 1)

    assert assets == [
        {
            "id": 1,
            "type": "application_packet",
            "name": "Application Packet.md",
            "media_type": "text/markdown",
            "download_url": "/api/jobs/1/assets/1?disposition=attachment",
            "open_url": "/api/jobs/1/assets/1?disposition=inline",
        }
    ]
    assert resolved.read_text(encoding="utf-8") == "packet"
    assert str(packet_root) not in str(assets)
    assert "Applications/Example Co" not in str(assets)


@pytest.mark.parametrize(
    ("stored_path", "asset_type"),
    [
        ("../outside.txt", "resume_txt"),
        ("/tmp/outside.txt", "resume_txt"),
        ("Applications/Example Co/Support Engineer/.env", "resume_txt"),
        ("Applications/Example Co/Support Engineer/private.key", "resume_txt"),
        ("Applications/Example Co/Support Engineer/Resume.exe", "resume_txt"),
    ],
)
def test_asset_resolution_rejects_traversal_secrets_and_type_mismatches(
    jobs_db, packet_root, stored_path, asset_type
):
    from hermes_cli.jobs.assets import AssetNotFoundError, JobAssetStore

    with sqlite3.connect(jobs_db) as connection:
        connection.execute(
            "UPDATE assets SET path = ?, asset_type = ? WHERE id = 1",
            (stored_path, asset_type),
        )

    with pytest.raises(AssetNotFoundError):
        JobAssetStore(jobs_db, packet_root).resolve(1, 1)


def test_asset_resolution_rejects_symlink_that_escapes_root(
    jobs_db, packet_root, tmp_path
):
    from hermes_cli.jobs.assets import AssetNotFoundError, JobAssetStore

    outside = tmp_path / "outside.txt"
    outside.write_text("private", encoding="utf-8")
    link = packet_root / "Example Co" / "Support Engineer" / "Resume.txt"
    os.symlink(outside, link)
    with sqlite3.connect(jobs_db) as connection:
        connection.execute(
            "UPDATE assets SET path = ?, asset_type = ? WHERE id = 1",
            ("Applications/Example Co/Support Engineer/Resume.txt", "resume_txt"),
        )

    with pytest.raises(AssetNotFoundError):
        JobAssetStore(jobs_db, packet_root).resolve(1, 1)


def test_asset_must_belong_to_requested_job(jobs_db, packet_root):
    from hermes_cli.jobs.assets import AssetNotFoundError, JobAssetStore

    with pytest.raises(AssetNotFoundError):
        JobAssetStore(jobs_db, packet_root).resolve(999, 1)
