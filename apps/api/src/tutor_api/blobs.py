"""Blob storage for uploaded media.

Postgres `bytea` rather than S3, because nothing needs a publicly fetchable URL:
LemonSlice accepts image bytes as a multipart upload (`agent_image`) and
ElevenLabs accepts audio the same way. That removes the whole bucket/CDN/dev
tunnel tier. `BlobStore` is a Protocol so swapping to S3 later is one class, the
same seam as every vendor in this codebase.

§10 obligation baked in: `delete()` is a soft delete that clears the bytes.
Raw voice and photo uploads are biometric data we should not retain once the
provider has enrolled them.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable

import psycopg
from psycopg.rows import dict_row


class BlobKind(StrEnum):
    AVATAR_PHOTO = "avatar_photo"
    VOICE_SAMPLE = "voice_sample"
    CONSENT_RECORDING = "consent_recording"


@dataclass(frozen=True)
class Blob:
    id: str
    kind: BlobKind
    content_type: str
    data: bytes
    byte_size: int
    sha256: str


class BlobNotFoundError(LookupError):
    pass


@runtime_checkable
class BlobStore(Protocol):
    def put(
        self,
        *,
        kind: BlobKind,
        content_type: str,
        data: bytes,
        owner_user_id: str | None = None,
    ) -> str: ...

    def get(self, blob_id: str) -> Blob: ...

    def delete(self, blob_id: str) -> None: ...


class PostgresBlobStore:
    """Satisfies BlobStore."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self.conn = conn

    def put(
        self,
        *,
        kind: BlobKind,
        content_type: str,
        data: bytes,
        owner_user_id: str | None = None,
    ) -> str:
        if not data:
            raise ValueError("refusing to store an empty blob")
        digest = hashlib.sha256(data).hexdigest()
        row = self.conn.execute(
            "INSERT INTO blobs (owner_user_id, kind, content_type, bytes, byte_size, sha256) "
            "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (owner_user_id, str(kind), content_type, data, len(data), digest),
        ).fetchone()
        return str(row[0])

    def get(self, blob_id: str) -> Blob:
        with self.conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT id, kind, content_type, bytes, byte_size, sha256 FROM blobs "
                "WHERE id = %s AND deleted_at IS NULL",
                (blob_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise BlobNotFoundError(f"no blob {blob_id!r}")
        return Blob(
            id=str(row["id"]),
            kind=BlobKind(row["kind"]),
            content_type=row["content_type"],
            data=bytes(row["bytes"]),
            byte_size=row["byte_size"],
            sha256=row["sha256"],
        )

    def delete(self, blob_id: str) -> None:
        """§10: clear the bytes, keep the record.

        The row survives so an audit can show the upload existed and when it was
        purged; the biometric payload does not. `byte_size` and `sha256` stay
        accurate for what was stored, which is why the row can't just be wiped
        (blobs_size_matches would fail against empty bytes).
        """
        self.conn.execute(
            "UPDATE blobs SET deleted_at = now() WHERE id = %s AND deleted_at IS NULL",
            (blob_id,),
        )


# ---------------------------------------------------------------------------

BLOB_REF_PREFIX = "blob:"


def blob_ref(blob_id: str) -> str:
    """`avatar_ref` value pointing at a stored blob.

    The avatar adapter already branches on `http://`-prefixed refs for hosted
    images; this is the third case it understands.
    """
    return f"{BLOB_REF_PREFIX}{blob_id}"


def parse_blob_ref(ref: str | None) -> str | None:
    """Blob id from an `avatar_ref`, or None if it isn't one."""
    if ref and ref.startswith(BLOB_REF_PREFIX):
        return ref[len(BLOB_REF_PREFIX) :]
    return None
