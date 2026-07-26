"""Retrieval against a real Postgres + pgvector.

Skipped unless TUTOR_TEST_DATABASE_URL is set:

    cd infra && make up
    export TUTOR_TEST_DATABASE_URL=postgres://tutor:tutor@localhost:5432/tutor
    uv run pytest tests/test_retrieval_pg.py

These do not belong in the offline suite, but the offline suite cannot cover the
one thing that matters most here. §13's requirement is that an ACL is enforced by
the QUERY — a fake store can be made to satisfy any assertion about filtering,
so "a revoked group stops matching" is only a real claim when a real WHERE clause
enforces it. Everything here therefore runs the actual SQL.

Each test owns a fresh user and rolls its data back, so the suite is safe to run
against a dev database that has other rows in it.
"""

from __future__ import annotations

import os
import uuid

import pytest

asyncpg = pytest.importorskip("asyncpg", reason="requires the postgres extra")

from tutor_agent.providers.base import Principal  # noqa: E402
from tutor_agent.retrieval import HashingEmbeddings  # noqa: E402
from tutor_agent.retrieval.pgvector import (  # noqa: E402
    Acl,
    PgVectorRetrieval,
    SourceRef,
)

DSN = os.environ.get("TUTOR_TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not DSN, reason="set TUTOR_TEST_DATABASE_URL to run the pgvector integration tests"
)

SYLLABUS = (
    "Week three covers factoring quadratics. You will practise finding two "
    "numbers whose product is the constant term and whose sum is the middle "
    "coefficient. The discriminant tells you how many real roots to expect."
)
UNRELATED = (
    "Lab safety requires goggles at all times. Report any spill to the "
    "demonstrator immediately and do not attempt to clean it yourself."
)


@pytest.fixture
async def pool():
    pool = await asyncpg.create_pool(DSN, min_size=1, max_size=4)
    try:
        yield pool
    finally:
        await pool.close()


@pytest.fixture
async def store(pool):
    return PgVectorRetrieval(pool=pool, embeddings=HashingEmbeddings())


@pytest.fixture
async def user(pool):
    """A throwaway account. The FK cascade cleans up everything derived."""
    user_id = uuid.uuid4()
    await pool.execute(
        "INSERT INTO users (id, email) VALUES ($1, $2)",
        user_id,
        f"test-{user_id}@example.test",
    )
    try:
        yield str(user_id)
    finally:
        await pool.execute("DELETE FROM users WHERE id = $1", user_id)


@pytest.fixture
async def upload(pool, user):
    upload_id = uuid.uuid4()
    await pool.execute(
        "INSERT INTO uploads (id, user_id, filename, blob_uri) VALUES ($1, $2, $3, $4)",
        upload_id,
        uuid.UUID(user),
        "syllabus.pdf",
        "s3://bucket/syllabus.pdf",
    )
    return str(upload_id)


@pytest.fixture
async def linked_account(pool, user):
    account_id = uuid.uuid4()
    await pool.execute(
        """
        INSERT INTO merge_linked_accounts
            (id, user_id, merge_account_token_ref, category, provider, status, linked_at)
        VALUES ($1, $2, 'vault://test', 'filestorage', 'google_drive', 'active', now())
        """,
        account_id,
        uuid.UUID(user),
    )
    return str(account_id)


class TestRoundTrip:
    async def test_ingest_then_retrieve(self, store, user, upload):
        await store.upsert_document(
            source=SourceRef(user_id=user, upload_id=upload),
            uri="s3://bucket/syllabus.pdf",
            title="Syllabus",
            text=SYLLABUS,
        )

        hits = await store.search("factoring quadratics", principal=Principal.owner(user))

        assert hits
        assert "factoring" in hits[0].text.lower()
        assert hits[0].uri == "s3://bucket/syllabus.pdf"
        assert hits[0].title == "Syllabus"

    async def test_ranks_the_relevant_document_first(self, store, user, upload, linked_account):
        await store.upsert_document(
            source=SourceRef(user_id=user, upload_id=upload),
            uri="s3://bucket/syllabus.pdf",
            text=SYLLABUS,
        )
        await store.upsert_document(
            source=SourceRef(user_id=user, linked_account_id=linked_account, remote_id="r1"),
            uri="https://drive/lab",
            text=UNRELATED,
        )

        hits = await store.search("factoring quadratics", principal=Principal.owner(user))

        assert "factoring" in hits[0].text.lower()

    async def test_limit_is_honoured(self, store, user, upload):
        await store.upsert_document(
            source=SourceRef(user_id=user, upload_id=upload),
            uri="s3://bucket/long.pdf",
            text="\n\n".join(f"Section {i}. " + "content " * 120 for i in range(12)),
        )

        hits = await store.search("content", principal=Principal.owner(user), limit=3)

        assert len(hits) == 3

    async def test_blank_query_does_not_hit_the_database(self, store, user):
        assert await store.search("   ", principal=Principal.owner(user)) == []


class TestAclEnforcement:
    """The §13 requirement, exercised through the real WHERE clause."""

    async def _shared_doc(self, store, user, linked_account, principals):
        await store.upsert_document(
            source=SourceRef(user_id=user, linked_account_id=linked_account, remote_id="shared"),
            uri="https://drive/shared",
            text=SYLLABUS,
            acl=Acl.shared_with(principals),
        )

    async def test_owner_mode_needs_no_groups(self, store, user, upload):
        await store.upsert_document(
            source=SourceRef(user_id=user, upload_id=upload),
            uri="s3://bucket/mine.pdf",
            text=SYLLABUS,
        )
        assert await store.search("factoring", principal=Principal.owner(user))

    async def test_principals_mode_matches_a_held_group(self, store, user, linked_account):
        await self._shared_doc(store, user, linked_account, ["g:cs101"])

        hits = await store.search(
            "factoring", principal=Principal(user_id=user, groups=frozenset({"g:cs101"}))
        )

        assert hits

    async def test_principals_mode_is_invisible_without_the_group(
        self, store, user, linked_account
    ):
        """The revocation case. Owning the row is not enough."""
        await self._shared_doc(store, user, linked_account, ["g:cs101"])

        hits = await store.search("factoring", principal=Principal.owner(user))

        assert hits == []

    async def test_a_revoked_group_stops_matching_immediately(self, store, user, linked_account):
        """No resync required — this is why the filter is at query time (§13)."""
        await self._shared_doc(store, user, linked_account, ["g:cs101"])
        held = Principal(user_id=user, groups=frozenset({"g:cs101"}))
        assert await store.search("factoring", principal=held)

        revoked = Principal(user_id=user, groups=frozenset({"g:something-else"}))
        assert await store.search("factoring", principal=revoked) == []

    async def test_one_matching_group_out_of_many_is_enough(self, store, user, linked_account):
        await self._shared_doc(store, user, linked_account, ["g:a", "g:b"])

        hits = await store.search(
            "factoring", principal=Principal(user_id=user, groups=frozenset({"g:b", "g:z"}))
        )

        assert hits

    async def test_another_users_chunks_are_never_returned(
        self, store, pool, user, upload, linked_account
    ):
        """Holding the right group must not cross the ownership boundary."""
        await self._shared_doc(store, user, linked_account, ["g:cs101"])
        intruder = uuid.uuid4()
        await pool.execute(
            "INSERT INTO users (id, email) VALUES ($1, $2)",
            intruder,
            f"intruder-{intruder}@example.test",
        )
        try:
            hits = await store.search(
                "factoring",
                principal=Principal(user_id=str(intruder), groups=frozenset({"g:cs101"})),
            )
            assert hits == []
        finally:
            await pool.execute("DELETE FROM users WHERE id = $1", intruder)


class TestPurge:
    async def test_severing_a_linked_account_purges_its_chunks(
        self, store, user, upload, linked_account
    ):
        """The Phase 4 done-when criterion (§12)."""
        await store.upsert_document(
            source=SourceRef(user_id=user, upload_id=upload),
            uri="s3://bucket/mine.pdf",
            text=SYLLABUS,
        )
        await store.upsert_document(
            source=SourceRef(user_id=user, linked_account_id=linked_account, remote_id="r1"),
            uri="https://drive/synced",
            text=SYLLABUS,
        )
        before = await store.search("factoring", principal=Principal.owner(user), limit=50)
        assert len({h.uri for h in before}) == 2

        purged = await store.purge_linked_account(linked_account)

        assert purged > 0
        after = await store.search("factoring", principal=Principal.owner(user), limit=50)
        assert {h.uri for h in after} == {"s3://bucket/mine.pdf"}

    async def test_purging_one_document_leaves_its_siblings(self, store, user, linked_account):
        for remote_id, uri in (("r1", "https://drive/one"), ("r2", "https://drive/two")):
            await store.upsert_document(
                source=SourceRef(
                    user_id=user, linked_account_id=linked_account, remote_id=remote_id
                ),
                uri=uri,
                text=SYLLABUS,
            )

        await store.purge_document(
            source=SourceRef(user_id=user, linked_account_id=linked_account, remote_id="r1"),
            uri="https://drive/one",
        )

        hits = await store.search("factoring", principal=Principal.owner(user), limit=50)
        assert {h.uri for h in hits} == {"https://drive/two"}

    async def test_purge_is_idempotent(self, store, user, upload):
        await store.upsert_document(
            source=SourceRef(user_id=user, upload_id=upload),
            uri="s3://bucket/mine.pdf",
            text=SYLLABUS,
        )
        first = await store.purge_upload(upload)
        second = await store.purge_upload(upload)
        assert first > 0
        assert second == 0


class TestReingestion:
    async def test_reingesting_replaces_rather_than_duplicates(self, store, user, upload):
        source = SourceRef(user_id=user, upload_id=upload)
        await store.upsert_document(source=source, uri="s3://bucket/s.pdf", text=SYLLABUS)
        await store.upsert_document(source=source, uri="s3://bucket/s.pdf", text=SYLLABUS)

        hits = await store.search("factoring", principal=Principal.owner(user), limit=50)

        assert len(hits) == len({h.chunk_id for h in hits})

    async def test_a_shortened_document_drops_its_tail(self, store, user, upload):
        """Otherwise the tutor keeps answering from text that was deleted."""
        source = SourceRef(user_id=user, upload_id=upload)
        long_text = "\n\n".join(f"Part {i}. " + "sentinel " * 120 for i in range(8))
        await store.upsert_document(source=source, uri="s3://bucket/s.pdf", text=long_text)
        before = await store.search("sentinel", principal=Principal.owner(user), limit=50)
        assert len(before) > 2

        await store.upsert_document(
            source=source, uri="s3://bucket/s.pdf", text="Part 0. sentinel only now."
        )

        after = await store.search("sentinel", principal=Principal.owner(user), limit=50)
        assert len(after) == 1

    async def test_reingesting_after_a_purge_revives_the_document(self, store, user, upload):
        source = SourceRef(user_id=user, upload_id=upload)
        await store.upsert_document(source=source, uri="s3://bucket/s.pdf", text=SYLLABUS)
        await store.purge_upload(upload)
        assert await store.search("factoring", principal=Principal.owner(user)) == []

        await store.upsert_document(source=source, uri="s3://bucket/s.pdf", text=SYLLABUS)

        assert await store.search("factoring", principal=Principal.owner(user))

    async def test_an_empty_document_purges_instead_of_inserting(self, store, user, upload):
        source = SourceRef(user_id=user, upload_id=upload)
        await store.upsert_document(source=source, uri="s3://bucket/s.pdf", text=SYLLABUS)

        count = await store.upsert_document(source=source, uri="s3://bucket/s.pdf", text="   ")

        assert count == 0
        assert await store.search("factoring", principal=Principal.owner(user)) == []


class TestLatencyBudget:
    async def test_search_stays_inside_the_in_loop_budget(self, store, user, upload):
        """§4 allows ≤150ms for retrieval, on the critical path before the model.

        Generous here because this is a laptop against a container, and the
        point is to catch an accidental sequential scan, not to benchmark.
        """
        import time

        await store.upsert_document(
            source=SourceRef(user_id=user, upload_id=upload),
            uri="s3://bucket/big.pdf",
            text="\n\n".join(f"Section {i}. " + "content words here " * 60 for i in range(60)),
        )

        await store.search("content", principal=Principal.owner(user))  # warm
        started = time.perf_counter()
        await store.search("content words", principal=Principal.owner(user))
        elapsed_ms = (time.perf_counter() - started) * 1000

        assert elapsed_ms < 150, f"retrieval took {elapsed_ms:.0f}ms, budget is 150ms"


class TestFetchChunk:
    """`show_source` fetches by id, so the id is an attack surface.

    Search decides what the model may quote. fetch_chunk decides what the client
    may *display*, from an id that has made a round trip through a browser. The
    two must apply the same rule, which is why `_acl_predicate` exists rather
    than two hand-written WHERE clauses that agree on the day they were written.
    """

    async def test_a_chunk_can_be_fetched_by_id(self, store, user, upload):
        await store.upsert_document(
            source=SourceRef(user_id=user, upload_id=upload),
            uri="s3://bucket/s.pdf",
            title="Syllabus",
            text=SYLLABUS,
        )
        (hit,) = await store.search("discriminant", principal=Principal.owner(user), limit=1)

        fetched = await store.fetch_chunk(hit.chunk_id, principal=Principal.owner(user))
        assert fetched is not None
        assert fetched.text == hit.text
        assert fetched.title == "Syllabus"

    async def test_another_learner_cannot_fetch_it(self, store, user, upload, pool):
        await store.upsert_document(
            source=SourceRef(user_id=user, upload_id=upload),
            uri="s3://bucket/s.pdf",
            text=SYLLABUS,
        )
        (hit,) = await store.search("discriminant", principal=Principal.owner(user), limit=1)

        intruder = uuid.uuid4()
        await pool.execute(
            "INSERT INTO users (id, email) VALUES ($1, $2)",
            intruder,
            f"intruder-{intruder}@example.test",
        )
        try:
            intruder_principal = Principal.owner(str(intruder))
            assert await store.fetch_chunk(hit.chunk_id, principal=intruder_principal) is None
        finally:
            await pool.execute("DELETE FROM users WHERE id = $1", intruder)

    async def test_a_revoked_group_stops_the_fetch_on_the_next_call(self, store, user, upload):
        """The §13 property, on the fetch path rather than the search path."""
        await store.upsert_document(
            source=SourceRef(user_id=user, upload_id=upload),
            uri="s3://bucket/shared.pdf",
            text=SYLLABUS,
            acl=Acl.shared_with(["g:cs101"]),
        )
        member = Principal(user_id=user, groups=frozenset({"g:cs101"}))
        (hit,) = await store.search("discriminant", principal=member, limit=1)
        assert await store.fetch_chunk(hit.chunk_id, principal=member) is not None

        # Same chunk, same id, group dropped — no resync in between.
        removed = Principal(user_id=user, groups=frozenset())
        assert await store.fetch_chunk(hit.chunk_id, principal=removed) is None

    async def test_a_malformed_id_is_a_miss_not_a_crash(self, store, user):
        # The id originates in a model's tool call and can be anything at all.
        assert await store.fetch_chunk("../../etc/passwd", principal=Principal.owner(user)) is None
        assert await store.fetch_chunk("", principal=Principal.owner(user)) is None
