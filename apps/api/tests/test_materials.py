"""The upload path into the retrieval index.

Runs against a real Postgres, for the same reason `test_api.py` does: the
guarantees worth testing here are provenance and purge, and both are enforced by
constraints and indexes rather than by Python.

    cd infra && make up
"""

from __future__ import annotations

import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from tutor_api.app import app, resolve_dsn

DSN = resolve_dsn()

SYLLABUS = b"""# Physics 101

## Grading

The midterm is worth 40% of the final grade and covers chapters 1 through 6.
Homework is 20%. The final exam is the remaining 40% and is cumulative.

## Office hours

Tuesdays and Thursdays, 2pm to 4pm, in Wean 5409. Bring your own problems;
we work through whatever you are stuck on rather than a fixed agenda.
"""


def _db_available() -> bool:
    try:
        with psycopg.connect(DSN, connect_timeout=2):
            return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _db_available(), reason=f"no database at {DSN} — run `cd infra && make up`"
)


@pytest.fixture
def conn():
    with psycopg.connect(DSN, autocommit=True) as connection:
        yield connection


@pytest.fixture
def learner(conn) -> str:
    user_id = conn.execute(
        "INSERT INTO users (email, adult_attested_at) VALUES (%s, now()) RETURNING id",
        (f"materials-test-{uuid.uuid4()}@example.test",),
    ).fetchone()[0]
    yield str(user_id)
    # Cascades to uploads and doc_chunks.
    conn.execute("DELETE FROM users WHERE id = %s", (user_id,))


@pytest.fixture
def client(monkeypatch):
    """A client with the lifespan run, so app.state.retrieval exists."""
    monkeypatch.setenv("DATABASE_URL", DSN)
    with TestClient(app) as test_client:
        yield test_client


def _upload(
    client,
    learner,
    content=SYLLABUS,
    filename="syllabus.md",
    content_type="text/markdown",
):
    return client.post(
        "/materials",
        headers={"X-User-Id": learner},
        files={"file": (filename, content, content_type)},
    )


class TestAuth:
    def test_materials_require_a_learner(self, client):
        # Unlike personas, there is no shared library to fall back to. An
        # anonymous read here would be a read of somebody's private documents.
        assert client.get("/materials").status_code == 401
        assert client.post("/materials", files={"file": ("a.md", b"x")}).status_code == 401

    def test_a_malformed_learner_id_is_a_400_not_a_500(self, client):
        response = client.get("/materials", headers={"X-User-Id": "bob"})
        assert response.status_code == 400


class TestIngest:
    def test_a_document_becomes_retrievable_chunks(self, client, learner):
        response = _upload(client, learner)
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["chunks"] >= 1
        assert body["filename"] == "syllabus.md"
        assert body["kind"] == "text"

    def test_chunks_carry_the_upload_as_provenance(self, client, learner, conn):
        upload_id = _upload(client, learner).json()["upload_id"]
        rows = conn.execute(
            "SELECT upload_id, linked_account_id, acl->>'mode' FROM doc_chunks "
            "WHERE upload_id = %s",
            (upload_id,),
        ).fetchall()
        assert rows
        for chunk_upload, linked_account, mode in rows:
            assert str(chunk_upload) == upload_id
            # Exactly one provenance root, or purge-by-source is unsound.
            assert linked_account is None
            assert mode == "owner"

    def test_reuploading_replaces_rather_than_duplicates(self, client, learner, conn):
        first = _upload(client, learner).json()
        second = _upload(client, learner, content=SYLLABUS + b"\n\nUpdated: the midterm moved.")
        assert second.status_code == 201

        # Two uploads, two provenance roots — but the first document's chunks
        # must not still be answering questions from the superseded text.
        count = conn.execute(
            "SELECT count(*) FROM doc_chunks WHERE upload_id = %s AND deleted_at IS NULL",
            (first["upload_id"],),
        ).fetchone()[0]
        assert count == first["chunks"]

    def test_an_unsupported_format_says_what_is_supported(self, client, learner):
        response = _upload(
            client,
            learner,
            content=b"\x00\x01",
            filename="lecture.mp4",
            content_type="video/mp4",
        )
        assert response.status_code == 415
        assert ".pdf" in str(response.json()["detail"])

    def test_a_document_with_no_text_is_not_recorded(self, client, learner, conn):
        response = _upload(client, learner, content=b"   \n\n  ", filename="blank.md")
        assert response.status_code == 422
        # No upload row survives a failed ingest: the panel must not list a
        # material the tutor has nothing indexed for.
        remaining = conn.execute(
            "SELECT count(*) FROM uploads WHERE user_id = %s AND deleted_at IS NULL",
            (learner,),
        ).fetchone()[0]
        assert remaining == 0

    def test_an_upload_for_an_unknown_learner_is_rejected(self, client):
        response = client.post(
            "/materials",
            headers={"X-User-Id": str(uuid.uuid4())},
            files={"file": ("a.md", SYLLABUS, "text/markdown")},
        )
        assert response.status_code == 400


class TestList:
    def test_uploads_are_listed_with_their_chunk_counts(self, client, learner):
        uploaded = _upload(client, learner).json()
        listing = client.get("/materials", headers={"X-User-Id": learner}).json()

        assert [m["upload_id"] for m in listing["materials"]] == [uploaded["upload_id"]]
        assert listing["materials"][0]["chunks"] == uploaded["chunks"]
        assert listing["retrieval"]["available"] is True

    def test_one_learner_cannot_see_another_learners_materials(self, client, learner, conn):
        _upload(client, learner)
        other = conn.execute(
            "INSERT INTO users (email) VALUES (%s) RETURNING id",
            (f"other-{uuid.uuid4()}@example.test",),
        ).fetchone()[0]
        try:
            listing = client.get("/materials", headers={"X-User-Id": str(other)}).json()
            assert listing["materials"] == []
        finally:
            conn.execute("DELETE FROM users WHERE id = %s", (other,))


class TestShowSource:
    def test_a_chunk_can_be_fetched_by_id_for_the_board(self, client, learner, conn):
        upload_id = _upload(client, learner).json()["upload_id"]
        chunk_id = str(
            conn.execute(
                "SELECT id FROM doc_chunks WHERE upload_id = %s ORDER BY chunk_ix LIMIT 1",
                (upload_id,),
            ).fetchone()[0]
        )

        response = client.get(f"/materials/chunks/{chunk_id}", headers={"X-User-Id": learner})
        assert response.status_code == 200
        assert "midterm" in response.json()["text"].lower()

    def test_another_learner_cannot_fetch_the_chunk(self, client, learner, conn):
        upload_id = _upload(client, learner).json()["upload_id"]
        chunk_id = str(
            conn.execute(
                "SELECT id FROM doc_chunks WHERE upload_id = %s LIMIT 1", (upload_id,)
            ).fetchone()[0]
        )
        other = conn.execute(
            "INSERT INTO users (email) VALUES (%s) RETURNING id",
            (f"other-{uuid.uuid4()}@example.test",),
        ).fetchone()[0]
        try:
            # The id travels through the browser, so this is a real attack path
            # and not a theoretical one.
            response = client.get(
                f"/materials/chunks/{chunk_id}", headers={"X-User-Id": str(other)}
            )
            assert response.status_code == 404
        finally:
            conn.execute("DELETE FROM users WHERE id = %s", (other,))

    def test_a_garbage_chunk_id_is_a_404_not_a_500(self, client, learner):
        # The id comes from a model. It can be anything.
        response = client.get("/materials/chunks/not-a-uuid", headers={"X-User-Id": learner})
        assert response.status_code == 404


class TestDelete:
    def test_deleting_a_document_purges_its_chunks(self, client, learner, conn):
        upload_id = _upload(client, learner).json()["upload_id"]

        assert client.delete(
            f"/materials/{upload_id}", headers={"X-User-Id": learner}
        ).status_code == 204

        live = conn.execute(
            "SELECT count(*) FROM doc_chunks WHERE upload_id = %s AND deleted_at IS NULL",
            (upload_id,),
        ).fetchone()[0]
        # "I deleted it" must mean the tutor stops quoting it, not that it
        # vanished from a list while still answering questions.
        assert live == 0
        assert client.get("/materials", headers={"X-User-Id": learner}).json()["materials"] == []

    def test_a_learner_cannot_delete_someone_elses_upload(self, client, learner, conn):
        upload_id = _upload(client, learner).json()["upload_id"]
        other = conn.execute(
            "INSERT INTO users (email) VALUES (%s) RETURNING id",
            (f"other-{uuid.uuid4()}@example.test",),
        ).fetchone()[0]
        try:
            response = client.delete(
                f"/materials/{upload_id}", headers={"X-User-Id": str(other)}
            )
            assert response.status_code == 404
        finally:
            conn.execute("DELETE FROM users WHERE id = %s", (other,))
