"""Uploading the learner's own materials into the retrieval index.

The front door to the sync plane's ingestion half (§7.5: direct uploads take the
same path as Merge-synced content, with different provenance). A file arrives
here and leaves as chunks in `doc_chunks`, which is the only thing the voice
loop reads.

    upload -> extract -> chunk -> embed -> doc_chunks (acl: owner)

Provenance is what makes deletion exact. Every chunk carries the `upload_id` it
came from, so removing a document is one `purge_upload` call rather than a text
match, and re-uploading a corrected version replaces its predecessor's chunks
instead of leaving both to compete for the same query.

**The original bytes are not retained.** The extracted text is in the index and
that is what the tutor teaches from; keeping a second copy of every PDF in
Postgres would be storage with no reader. `uploads.blob_uri` therefore holds an
`upload://` identifier rather than an object key. Add a blob write here if
`show_source` ever needs to render the original page image.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from pydantic import BaseModel
from tutor_agent.retrieval.extract import (
    SUPPORTED_EXTENSIONS,
    ExtractionDependencyError,
    UnsupportedDocumentError,
    extract_text,
)

log = logging.getLogger(__name__)

router = APIRouter(tags=["materials"])

# Held in memory through extraction, so the cap is real. A 25MB PDF is a
# textbook chapter; anything larger is a scan that will fail extraction anyway.
MAX_DOCUMENT_BYTES = 25 * 1024 * 1024


class MaterialOut(BaseModel):
    upload_id: str
    filename: str
    kind: str
    chunks: int
    byte_size: int
    pages: int | None = None
    created_at: datetime | None = None


class MaterialList(BaseModel):
    materials: list[MaterialOut]
    retrieval: dict[str, Any]


class ChunkOut(BaseModel):
    chunk_id: str
    text: str
    uri: str | None = None
    title: str | None = None


def learner_id(x_user_id: Annotated[str | None, Header()] = None) -> str:
    """Auth stub. Materials are per-learner, so unlike persona reads this one
    cannot fall back to a shared library — a missing id is an error, not an
    anonymous request."""
    if not x_user_id:
        raise HTTPException(401, "X-User-Id is required to read or write materials")
    try:
        uuid.UUID(x_user_id)
    except ValueError as exc:
        raise HTTPException(400, f"X-User-Id must be a uuid, got {x_user_id!r}") from exc
    return x_user_id


LearnerDep = Annotated[str, Depends(learner_id)]


def _plane(request: Request):
    plane = getattr(request.app.state, "retrieval", None)
    if plane is None or not plane.available:
        detail = plane.status["detail"] if plane is not None else "retrieval is not configured"
        # 503 rather than 500: nothing is broken, the capability is off.
        raise HTTPException(503, f"materials are unavailable — {detail}")
    return plane


_INSERT_UPLOAD_SQL = """
INSERT INTO uploads (id, user_id, filename, content_type, byte_size, blob_uri)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
"""

_LIST_SQL = """
SELECT u.id::text     AS upload_id,
       u.filename,
       u.content_type,
       u.byte_size,
       u.created_at,
       count(c.id) FILTER (WHERE c.deleted_at IS NULL) AS chunks
FROM uploads u
LEFT JOIN doc_chunks c ON c.upload_id = u.id
WHERE u.user_id = $1::uuid AND u.deleted_at IS NULL
GROUP BY u.id
ORDER BY u.created_at DESC
"""


@router.post("/materials", response_model=MaterialOut, status_code=201)
async def upload_material(
    request: Request,
    learner: LearnerDep,
    file: Annotated[UploadFile, File()],
    title: str | None = None,
) -> MaterialOut:
    """Index one document so the tutor can teach from it."""
    plane = _plane(request)

    data = await file.read()
    if not data:
        raise HTTPException(400, "empty upload")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise HTTPException(413, f"upload is {len(data)} bytes; limit is {MAX_DOCUMENT_BYTES}")

    filename = file.filename or "upload"
    try:
        document = extract_text(data, filename=filename, content_type=file.content_type)
    except UnsupportedDocumentError as exc:
        # 415 with the reason. "Unsupported" and "this PDF is a scan" send the
        # learner to two completely different next actions.
        raise HTTPException(
            415, {"detail": str(exc), "supported": list(SUPPORTED_EXTENSIONS)}
        ) from exc
    except ExtractionDependencyError as exc:
        raise HTTPException(503, str(exc)) from exc

    from tutor_agent.retrieval.pgvector import Acl, SourceRef

    upload_id = str(uuid.uuid4())
    uri = f"upload://{upload_id}/{filename}"

    try:
        await plane.pool.execute(
            _INSERT_UPLOAD_SQL,
            upload_id,
            learner,
            filename,
            file.content_type,
            len(data),
            uri,
        )
    except Exception as exc:
        # The most likely cause by far: user_id has no row, because the caller
        # invented an id instead of starting a session.
        raise HTTPException(400, f"could not record the upload: {exc}") from exc

    chunks = await plane.store.upsert_document(
        source=SourceRef(user_id=learner, upload_id=upload_id),
        uri=uri,
        title=title or filename,
        text=document.text,
        acl=Acl.owner(),
    )

    if chunks == 0:
        # Nothing indexable. Roll the upload back rather than leaving a row the
        # UI will list as a material the tutor cannot actually use.
        await plane.pool.execute("DELETE FROM uploads WHERE id = $1::uuid", upload_id)
        raise HTTPException(422, f"{filename} produced no indexable text")

    log.info("indexed %s (%d chunks) for %s", filename, chunks, learner)
    return MaterialOut(
        upload_id=upload_id,
        filename=filename,
        kind=document.kind,
        chunks=chunks,
        byte_size=len(data),
        pages=document.pages,
    )


@router.get("/materials", response_model=MaterialList)
async def list_materials(request: Request, learner: LearnerDep) -> MaterialList:
    plane = getattr(request.app.state, "retrieval", None)
    if plane is None or not plane.available:
        # A list is a read: return an empty one with the reason attached rather
        # than a 503, so the panel can render its own "retrieval is off" state.
        return MaterialList(
            materials=[],
            retrieval=plane.status if plane is not None else {"available": False},
        )

    rows = await plane.pool.fetch(_LIST_SQL, learner)
    return MaterialList(
        materials=[
            MaterialOut(
                upload_id=row["upload_id"],
                filename=row["filename"],
                kind=row["content_type"] or "",
                chunks=row["chunks"],
                byte_size=row["byte_size"] or 0,
                created_at=row["created_at"],
            )
            for row in rows
        ],
        retrieval=plane.status,
    )


@router.delete("/materials/{upload_id}", status_code=204)
async def delete_material(request: Request, learner: LearnerDep, upload_id: str):
    """Remove a document and everything derived from it.

    The chunk purge runs first. Reversed, a failure between the two steps would
    leave chunks with no upload row — invisible in the UI and still answering
    questions, which is the one outcome a delete must never produce.
    """
    plane = _plane(request)
    try:
        uuid.UUID(upload_id)
    except ValueError as exc:
        raise HTTPException(400, "upload_id must be a uuid") from exc

    owned = await plane.pool.fetchval(
        "SELECT 1 FROM uploads WHERE id = $1::uuid AND user_id = $2::uuid AND deleted_at IS NULL",
        upload_id,
        learner,
    )
    if not owned:
        raise HTTPException(404, f"no upload {upload_id}")

    await plane.store.purge_upload(upload_id)
    await plane.pool.execute(
        "UPDATE uploads SET deleted_at = now() WHERE id = $1::uuid", upload_id
    )
    return Response(status_code=204)


@router.get("/materials/chunks/{chunk_id}", response_model=ChunkOut)
async def get_chunk(request: Request, learner: LearnerDep, chunk_id: str) -> ChunkOut:
    """One chunk's text, for rendering `show_source` on the board.

    The ACL is re-checked here even though the model only names chunks it was
    given: the id makes a round trip through the browser, and a check that runs
    only on the way out is not a check.
    """
    from tutor_agent.providers.base import Principal

    plane = _plane(request)
    # Groups are not resolved yet — no group membership table exists — so this
    # is owner-only, which fails closed. When groups arrive, they load here.
    chunk = await plane.store.fetch_chunk(chunk_id, principal=Principal.owner(learner))
    if chunk is None:
        raise HTTPException(404, f"no chunk {chunk_id} visible to this learner")
    return ChunkOut(
        chunk_id=chunk.chunk_id, text=chunk.text, uri=chunk.uri, title=chunk.title
    )
