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


def test_search_matches_values_across_types(store):
    store.create("reading", {"title": "Dune", "author": "Frank Herbert", "tags": ["scifi"]})
    store.create("task", {"title": "Read Dune notes", "context": "Imperator"})
    store.create("contact", {"name": "Frank Miller", "org": "Acme"})

    # Prefix match spans types; ordered by relevance.
    dune = store.search("dun")
    assert dune["total"] == 2
    assert {i["type"] for i in dune["items"]} == {"reading", "task"}

    # A value in any field is searchable (author here).
    frank = store.search("frank")
    assert {i["type"] for i in frank["items"]} == {"reading", "contact"}

    # Field names are NOT indexed — searching a key matches nothing.
    assert store.search("author")["total"] == 0

    # Blank query returns nothing (not everything).
    assert store.search("   ")["total"] == 0


def test_search_scopes_to_types(store):
    store.create("reading", {"title": "Frank Herbert reader"})
    store.create("contact", {"name": "Frank Miller"})
    scoped = store.search("frank", types=["contact"])
    assert scoped["total"] == 1
    assert scoped["items"][0]["type"] == "contact"


def test_search_index_follows_updates_and_deletes(store):
    e = store.create("contact", {"name": "Frank Miller", "org": "Acme"})
    assert store.search("acme")["total"] == 1
    # Update re-indexes: old value drops, new value hits.
    store.update(e["id"], {"name": "Frank Miller", "org": "Globex"}, expected_version=1)
    assert store.search("acme")["total"] == 0
    assert store.search("globex")["total"] == 1
    # Delete removes it from the index.
    store.delete(e["id"])
    assert store.search("globex")["total"] == 0


def test_search_backfills_existing_rows_on_migrate(tmp_path):
    # A store written before the FTS index existed still becomes searchable
    # after migrate() backfills — simulate by inserting straight into entities.
    import json
    import sqlite3

    db = tmp_path / "legacy.sqlite3"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, "
        "data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, "
        "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )
    con.execute(
        "INSERT INTO entities VALUES (?, ?, ?, 1, ?, ?)",
        ("id1", "reading", json.dumps({"title": "Legacy Dune"}), "2026-01-01Z", "2026-01-01Z"),
    )
    con.commit()
    con.close()

    store = EntityStore(db)
    store.migrate()
    hit = store.search("legacy")
    assert hit["total"] == 1
    assert hit["items"][0]["data"]["title"] == "Legacy Dune"
