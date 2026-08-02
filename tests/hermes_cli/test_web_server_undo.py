"""The undo screen's HTTP surface.

Third caller of `hermes_cli.undo.surface`, after the gateway RPC and `hermes
undo`. All three are thin over the same module on purpose: a browser, a
terminal and the TUI must not be able to disagree about what an entry means or
what forcing does.

The route-specific property these hold, which the other two surfaces do not
have to worry about: a refusal and a failure come back as **200 with a body**,
not as an HTTP error. The call worked; the answer is the structured conflict
report or the repair state, and that is the only part a screen can act on. A
500 would throw it away and leave the page saying "something went wrong".
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A real vault and hermes home, wired the way the app wires them."""
    home = tmp_path / "home"
    (home / "state").mkdir(parents=True)
    root = tmp_path / "vault"
    root.mkdir()

    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr("hermes_cli.config.get_hermes_home", lambda: home)
    monkeypatch.setattr("hermes_cli.secure_store.get_hermes_home", lambda: home)
    monkeypatch.setenv("HERMES_VAULT_PATH", str(root))

    from hermes_cli import web_server
    from hermes_cli.undo import actions

    actions.reset_journal_for_tests()
    with TestClient(web_server.app) as c:
        # The undo routes sit behind the same session-token check every other
        # /api route does; `TestAuthentication` below asserts that rather than
        # leaving it to be inferred from this line.
        c.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
        c.vault = root  # type: ignore[attr-defined]
        yield c
    actions.reset_journal_for_tests()


@pytest.fixture
def anonymous(client):
    """The same app, without the session token."""
    from hermes_cli import web_server

    client.headers.pop(web_server._SESSION_HEADER_NAME, None)
    return client


def write(rel: str, content: str):
    from hermes_cli.vault import notes

    return notes.write_note(rel, content)


class TestReadingTheJournal:
    def test_a_written_note_appears_on_the_stack(self, client):
        (client.vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")

        body = client.get("/api/undo").json()
        assert body["counts"]["stack"] == 1
        assert body["stack"][0]["target"] == "note.md"

    def test_the_three_lists_are_always_present(self, client):
        # A screen that has to guess whether a key exists renders differently
        # on an empty install than on a busy one.
        body = client.get("/api/undo").json()
        assert body["counts"] == {"stack": 0, "repairs": 0, "in_flight": 0}
        assert body["stack"] == [] and body["repairs"] == [] and body["in_flight"] == []

    def test_the_payload_carries_no_backup_path_or_hashes(self, client):
        # Absolute paths into the hermes home have no business in a browser.
        (client.vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        blob = client.get("/api/undo").text
        assert "preimage_sha256" not in blob
        assert "backup" not in blob

    def test_a_preview_reports_a_conflict_without_changing_anything(self, client):
        (client.vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "agent wrote this")
        (client.vault / "note.md").write_text("owner typed this", encoding="utf-8")

        entry_id = client.get("/api/undo").json()["stack"][0]["id"]
        body = client.get(f"/api/undo/{entry_id}").json()
        assert body["can_undo"] is False
        assert body["can_force"] is True
        assert body["conflict"]["kind"] == "changed_since"
        assert (client.vault / "note.md").read_text(encoding="utf-8") == "owner typed this"

    def test_an_unknown_entry_is_a_404(self, client):
        assert client.get("/api/undo/does-not-exist").status_code == 404


class TestApplying:
    def test_it_puts_the_previous_content_back(self, client):
        (client.vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")

        body = client.post("/api/undo/apply", json={}).json()
        assert body["undone"] is True
        assert (client.vault / "note.md").read_text(encoding="utf-8") == "original"

    def test_a_named_entry_can_be_undone_out_of_order(self, client):
        (client.vault / "a.md").write_text("a0", encoding="utf-8")
        (client.vault / "b.md").write_text("b0", encoding="utf-8")
        write("a.md", "a1")
        write("b.md", "b1")

        older = next(
            r for r in client.get("/api/undo").json()["stack"] if r["target"] == "a.md"
        )
        client.post("/api/undo/apply", json={"entryId": older["id"]})

        assert (client.vault / "a.md").read_text(encoding="utf-8") == "a0"
        assert (client.vault / "b.md").read_text(encoding="utf-8") == "b1"

    def test_nothing_to_undo_is_a_200_not_an_error(self, client):
        resp = client.post("/api/undo/apply", json={})
        assert resp.status_code == 200
        assert resp.json() == {"undone": False, "reason": "nothing to undo"}


class TestAConflictIsAnAnswerNotAnError:
    def _conflicted(self, client):
        (client.vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "agent wrote this")
        (client.vault / "note.md").write_text("owner typed this", encoding="utf-8")

    def test_it_comes_back_as_200_with_the_report(self, client):
        """A 500 would discard the only part the page can act on."""
        self._conflicted(client)
        resp = client.post("/api/undo/apply", json={})

        assert resp.status_code == 200
        body = resp.json()
        assert body["undone"] is False
        assert body["refused"] is True
        assert body["conflict"]["kind"] == "changed_since"
        assert body["canForce"] is True
        assert (client.vault / "note.md").read_text(encoding="utf-8") == "owner typed this"

    def test_the_refusal_leaves_the_entry_offerable(self, client):
        self._conflicted(client)
        client.post("/api/undo/apply", json={})
        assert client.get("/api/undo").json()["counts"]["stack"] == 1

    def test_forcing_carries_the_owners_answer_back(self, client):
        self._conflicted(client)
        assert client.post("/api/undo/apply", json={}).json()["refused"] is True

        body = client.post("/api/undo/apply", json={"force": True}).json()
        assert body["undone"] is True
        assert (client.vault / "note.md").read_text(encoding="utf-8") == "original"

    def test_a_missing_backup_does_not_offer_a_force_button(self, client):
        # `backup_missing` is the one conflict force cannot answer: there is
        # nothing to restore, so the button could only ever fail.
        from hermes_cli.undo import actions
        from pathlib import Path

        (client.vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry = actions.journal().stack()[0]
        Path(entry["inverse_payload"]["backup"]).unlink()

        body = client.get(f"/api/undo/{entry['id']}").json()
        assert body["can_force"] is False


class TestAFailureIsADifferentAnswer:
    def test_it_says_the_entry_needs_a_person(self, client, monkeypatch):
        """Ran and did not take. Retrying is not the next step; looking is."""
        (client.vault / "note.md").write_text("original", encoding="utf-8")
        write("note.md", "changed")
        entry_id = client.get("/api/undo").json()["stack"][0]["id"]

        monkeypatch.setattr(
            "hermes_cli.undo.actions.apply_vault_inverse",
            lambda e, **kw: (_ for _ in ()).throw(OSError("disk went away")),
        )
        resp = client.post("/api/undo/apply", json={"entryId": entry_id})

        assert resp.status_code == 200
        body = resp.json()
        assert body["undone"] is False
        assert body["failed"] is True
        assert body["needsRepair"] is True
        # And it is now visible in the list the screen leads with.
        assert client.get("/api/undo").json()["counts"]["repairs"] == 1


class TestRouteWiring:
    def test_the_literal_apply_route_is_not_shadowed(self):
        """`/api/undo/{entry_id}` must be declared after `/api/undo/apply`.

        They differ by method today, which makes the ordering invisible until
        somebody adds a GET — at which point `apply` would silently become an
        entry id lookup.
        """
        from hermes_cli.web_server import app

        paths = [r.path for r in app.routes if getattr(r, "path", "").startswith("/api/undo")]
        assert paths.index("/api/undo/apply") < paths.index("/api/undo/{entry_id}")


class TestAuthentication:
    """The journal names every file the agent touched. It is not public.

    Asserted rather than assumed: these routes are new, and a route that
    forgets the check looks identical to one that has it until somebody
    curls it.
    """

    def test_reading_the_journal_requires_the_session_token(self, anonymous):
        assert anonymous.get("/api/undo").status_code == 401

    def test_previewing_requires_the_session_token(self, anonymous):
        assert anonymous.get("/api/undo/anything").status_code == 401

    def test_applying_requires_the_session_token(self, anonymous):
        assert anonymous.post("/api/undo/apply", json={}).status_code == 401
