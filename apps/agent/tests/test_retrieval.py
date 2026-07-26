"""Chunking, embeddings, and the retrieval provider contract. Offline."""

from __future__ import annotations

import pytest

from tutor_agent.providers.base import Chunk, Principal, RetrievalProvider
from tutor_agent.retrieval import (
    EMBEDDING_DIM,
    HashingEmbeddings,
    chunk_document,
    normalize,
)


class TestNormalize:
    def test_collapses_extraction_whitespace(self):
        assert normalize("a  \t b") == "a b"

    def test_preserves_paragraph_boundaries(self):
        """Paragraph breaks are the author saying where an idea ends."""
        assert normalize("one\n\n\n\n\ntwo") == "one\n\ntwo"

    def test_single_newlines_are_not_paragraph_breaks(self):
        assert normalize("wrapped\nline") == "wrapped\nline"

    def test_handles_crlf(self):
        assert normalize("a\r\n\r\nb") == "a\n\nb"


class TestChunking:
    def test_empty_input_yields_nothing(self):
        """An empty chunk violates doc_chunks_text_nonempty."""
        assert chunk_document("") == []
        assert chunk_document("   \n\n  ") == []

    def test_short_document_is_one_chunk(self):
        chunks = chunk_document("A short note about factoring.")
        assert len(chunks) == 1
        assert chunks[0].ix == 0

    def test_chunks_are_indexed_contiguously_from_zero(self):
        text = "\n\n".join(f"Paragraph {i}. " + "word " * 100 for i in range(10))
        chunks = chunk_document(text)
        assert [c.ix for c in chunks] == list(range(len(chunks)))

    def test_prefers_paragraph_boundaries(self):
        a = "Alpha. " * 40
        b = "Beta. " * 40
        chunks = chunk_document(f"{a.strip()}\n\n{b.strip()}", target_chars=300, overlap_chars=0)
        # No chunk should mix the two paragraphs when they each fit alone.
        mixed = [c for c in chunks if "Alpha" in c.text and "Beta" in c.text]
        assert not mixed

    def test_oversized_paragraph_falls_back_to_sentences(self):
        text = " ".join(f"Sentence number {i} here." for i in range(200))
        chunks = chunk_document(text, target_chars=300, overlap_chars=0)
        assert len(chunks) > 1
        assert all(len(c.text) <= 320 for c in chunks)

    def test_text_with_no_punctuation_is_still_bounded(self):
        """Scraped slides are often one unbroken wall."""
        chunks = chunk_document("word" * 5000, target_chars=400, overlap_chars=0)
        assert all(len(c.text) <= 400 for c in chunks)

    def test_overlap_carries_context_across_the_seam(self):
        first = "The discriminant determines the number of roots. " * 12
        second = "It is negative here. " * 12
        chunks = chunk_document(
            f"{first.strip()}\n\n{second.strip()}", target_chars=600, overlap_chars=120
        )
        assert len(chunks) > 1
        assert "discriminant" in chunks[1].text

    def test_overlap_does_not_open_mid_word(self):
        text = "\n\n".join("Supercalifragilistic content here. " * 20 for _ in range(3))
        for chunk in chunk_document(text, target_chars=400, overlap_chars=90)[1:]:
            assert not chunk.text.startswith("alifragilistic")

    def test_a_trailing_scrap_is_absorbed(self):
        """'Chapter 4' alone retrieves weakly against everything."""
        body = "Real content. " * 100
        chunks = chunk_document(f"{body.strip()}\n\nCh. 4", target_chars=400, overlap_chars=0)
        assert "Ch. 4" in chunks[-1].text
        assert chunks[-1].text != "Ch. 4"

    def test_overlap_must_be_smaller_than_the_target(self):
        with pytest.raises(ValueError, match="never advance"):
            chunk_document("text", target_chars=100, overlap_chars=100)


class TestHashingEmbeddings:
    async def test_dimension_matches_the_column(self):
        """vector(1024) in migration 0012. Disagreement fails every INSERT."""
        vector = await HashingEmbeddings().embed_query("anything")
        assert len(vector) == EMBEDDING_DIM

    async def test_deterministic(self):
        e = HashingEmbeddings()
        assert await e.embed_query("factoring") == await e.embed_query("factoring")

    async def test_unit_length(self):
        vector = await HashingEmbeddings().embed_query("some words here")
        assert sum(v * v for v in vector) == pytest.approx(1.0)

    async def test_empty_text_is_still_a_valid_unit_vector(self):
        """A zero vector has undefined cosine distance."""
        vector = await HashingEmbeddings().embed_query("...")
        assert sum(v * v for v in vector) == pytest.approx(1.0)

    async def test_ranks_a_matching_passage_above_a_mismatched_one(self):
        """Otherwise a broken ORDER BY would pass its tests."""
        e = HashingEmbeddings()
        query = await e.embed_query("how do I factor a quadratic")
        match, other = await e.embed_documents(
            [
                "To factor a quadratic, find two numbers that multiply to c.",
                "The mitochondrion is the powerhouse of the cell.",
            ]
        )
        dot = lambda a, b: sum(x * y for x, y in zip(a, b, strict=True))  # noqa: E731
        assert dot(query, match) > dot(query, other)

    async def test_batches_preserve_order(self):
        e = HashingEmbeddings()
        texts = ["alpha", "beta", "gamma"]
        batch = await e.embed_documents(texts)
        for text, vector in zip(texts, batch, strict=True):
            assert vector == await e.embed_query(text)

    async def test_empty_batch(self):
        assert await HashingEmbeddings().embed_documents([]) == []


class TestPrincipal:
    def test_owner_carries_no_groups(self):
        """The default has to be fail-closed: ownership, nothing more."""
        principal = Principal.owner("u_1")
        assert principal.user_id == "u_1"
        assert principal.groups == frozenset()

    def test_is_hashable_so_it_can_be_cached(self):
        assert {Principal.owner("u_1"), Principal.owner("u_1")} == {Principal.owner("u_1")}


class TestProviderContract:
    def test_fake_satisfies_the_protocol(self):
        from tutor_agent.providers import FakeRetrieval

        assert isinstance(FakeRetrieval(), RetrievalProvider)

    def test_pgvector_store_satisfies_the_protocol(self):
        pytest.importorskip("asyncpg", reason="requires the postgres extra")
        from tutor_agent.retrieval.pgvector import PgVectorRetrieval

        store = PgVectorRetrieval(pool=object(), embeddings=HashingEmbeddings())
        assert isinstance(store, RetrievalProvider)

    async def test_the_session_passes_a_principal_through(self):
        """§13: the requester must reach the query, not stop at session setup."""
        from tutor_agent.core import RecordingAdapter, TutorSession
        from tutor_agent.persona import load_persona_dir
        from tutor_agent.persona.loader import DEFAULT_PERSONA_DIR
        from tutor_agent.providers import FakeLLM, FakeRetrieval, FakeTTS, ScriptedTurn

        retrieval = FakeRetrieval(
            chunks=[Chunk(chunk_id="c1", text="from the syllabus", uri="s3://x", score=0.9)],
            latency_ms=0,
        )
        principal = Principal(user_id="u_42", groups=frozenset({"g:staff"}))
        session = TutorSession(
            persona=load_persona_dir(DEFAULT_PERSONA_DIR)["ada"],
            llm=FakeLLM([ScriptedTurn(events=["Sure."])]),
            tts=FakeTTS(),
            channel=RecordingAdapter(),
            retrieval=retrieval,
            user_id="u_42",
            principal=principal,
        )

        await session.handle_transcript("what does my syllabus say")

        assert retrieval.principals == [principal]

    async def test_principal_defaults_to_owner_only(self):
        from tutor_agent.core import RecordingAdapter, TutorSession
        from tutor_agent.persona import load_persona_dir
        from tutor_agent.persona.loader import DEFAULT_PERSONA_DIR
        from tutor_agent.providers import FakeLLM, FakeRetrieval, FakeTTS, ScriptedTurn

        retrieval = FakeRetrieval(latency_ms=0)
        session = TutorSession(
            persona=load_persona_dir(DEFAULT_PERSONA_DIR)["ada"],
            llm=FakeLLM([ScriptedTurn(events=["Sure."])]),
            tts=FakeTTS(),
            channel=RecordingAdapter(),
            retrieval=retrieval,
            user_id="u_7",
        )

        await session.handle_transcript("anything")

        assert retrieval.principals == [Principal(user_id="u_7", groups=frozenset())]


class TestVectorEncoding:
    def test_rejects_a_wrong_width_vector(self):
        """Better here than as an opaque INSERT failure."""
        from tutor_agent.retrieval.pgvector import to_pgvector

        with pytest.raises(ValueError, match="vector\\(1024\\)"):
            to_pgvector([0.1, 0.2])

    def test_encodes_pgvector_text_format(self):
        from tutor_agent.retrieval.pgvector import to_pgvector

        encoded = to_pgvector([0.5] * EMBEDDING_DIM)
        assert encoded.startswith("[0.5,")
        assert encoded.endswith("]")

    def test_source_ref_demands_exactly_one_root(self):
        from tutor_agent.retrieval.pgvector import SourceRef

        SourceRef(user_id="u", upload_id="up_1")
        SourceRef(user_id="u", linked_account_id="la_1")
        with pytest.raises(ValueError, match="exactly one"):
            SourceRef(user_id="u")
        with pytest.raises(ValueError, match="exactly one"):
            SourceRef(user_id="u", upload_id="up_1", linked_account_id="la_1")

    def test_acl_json_shapes_match_the_check_constraint(self):
        from tutor_agent.retrieval.pgvector import Acl

        assert Acl.owner().to_json() == {"mode": "owner"}
        assert Acl.shared_with(["b", "a"]).to_json() == {
            "mode": "principals",
            "principals": ["a", "b"],
        }
