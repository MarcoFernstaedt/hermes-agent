from __future__ import annotations

import pytest

from hermes_cli.entities.store import (
    EntityConflictError,
    EntityNotFoundError,
    EntityStore,
)


@pytest.fixture
def store(tmp_path):
    s = EntityStore(tmp_path / "entities.sqlite3")
    s.migrate()
    return s


def test_create_get_roundtrip(store):
    created = store.create("job", {"company": "Acme", "status": "saved"})
    assert created["version"] == 1
    assert created["type"] == "job"
    fetched = store.get(created["id"])
    assert fetched["data"] == {"company": "Acme", "status": "saved"}
    assert fetched["created_at"] == created["created_at"]


def test_update_bumps_version_and_enforces_expected(store):
    e = store.create("job", {"status": "saved"})
    updated = store.update(e["id"], {"status": "applied"}, expected_version=1)
    assert updated["version"] == 2
    assert updated["data"]["status"] == "applied"
    # Stale expected_version → conflict carrying the current record.
    with pytest.raises(EntityConflictError) as caught:
        store.update(e["id"], {"status": "offer"}, expected_version=1)
    assert caught.value.current["version"] == 2
    assert caught.value.current["data"]["status"] == "applied"


def test_update_missing_raises(store):
    with pytest.raises(EntityNotFoundError):
        store.update("nope", {"x": 1}, expected_version=1)


def test_list_filters_by_type_and_field(store):
    store.create("job", {"status": "saved"})
    store.create("job", {"status": "applied"})
    store.create("note", {"status": "saved"})
    all_jobs = store.list("job")
    assert all_jobs["total"] == 2
    assert all(item["type"] == "job" for item in all_jobs["items"])
    applied = store.list("job", filters={"status": "applied"})
    assert applied["total"] == 1
    assert applied["items"][0]["data"]["status"] == "applied"


def test_list_orders_newest_first_and_paginates(store):
    import datetime as dt

    for i in range(5):
        store.create(
            "job",
            {"n": i},
            now=dt.datetime(2026, 7, 20, 12, i, tzinfo=dt.timezone.utc),
        )
    page = store.list("job", limit=2, offset=0)
    assert page["total"] == 5
    assert [item["data"]["n"] for item in page["items"]] == [4, 3]  # newest first


def test_delete(store):
    e = store.create("job", {"x": 1})
    assert store.delete(e["id"]) is True
    assert store.get(e["id"]) is None
    assert store.delete(e["id"]) is False


def test_invalid_type_rejected(store):
    with pytest.raises(ValueError):
        store.create("bad type!", {"x": 1})
