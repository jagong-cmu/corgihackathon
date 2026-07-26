"""Persona CRUD and media upload.

Turns "custom tutor" from *edit a YAML file and restart the worker* into an API
call. Because `PersonaSpec` is already a pydantic model, FastAPI takes it as a
request body directly — which means full persona authoring (catchphrases,
pedagogy, few-shot exchanges) costs almost nothing here, and the consent rules
in §9/§10 enforce themselves on every write.

Auth is a stub: `X-User-Id` names the owner. Real auth, and the §10 18+
attestation gate (`users.adult_attested_at`), are not built.
"""

from __future__ import annotations

import logging
import os
from typing import Annotated, Any

import psycopg
from fastapi import Depends, FastAPI, File, Header, HTTPException, Response, UploadFile
from pydantic import BaseModel, ValidationError
from tutor_agent.persona import PersonaNotFoundError, PersonaSpec
from tutor_agent.persona.store import ConsentViolationError, PostgresPersonaStore
from tutor_agent.providers.elevenlabs_voices import (
    ElevenLabsVoices,
    VoiceCloningUnavailableError,
)

from .blobs import BlobKind, BlobNotFoundError, PostgresBlobStore, blob_ref

log = logging.getLogger(__name__)


def resolve_dsn() -> str:
    """Same precedence as infra/scripts/migrate.sh.

    DATABASE_URL wins; otherwise assemble from POSTGRES_*. Getting this wrong is
    a confusing failure — a compose stack brought up with POSTGRES_PORT set
    keeps that published port for the container's whole life, so a hardcoded
    5432 connects to nothing while `docker compose ps` cheerfully reports the
    database is running.
    """
    explicit = os.environ.get("DATABASE_URL")
    if explicit:
        return explicit
    user = os.environ.get("POSTGRES_USER", "tutor")
    password = os.environ.get("POSTGRES_PASSWORD", "tutor")
    port = os.environ.get("POSTGRES_PORT", "5432")
    database = os.environ.get("POSTGRES_DB", "tutor")
    host = os.environ.get("POSTGRES_HOST", "localhost")
    return f"postgres://{user}:{password}@{host}:{port}/{database}"


DEFAULT_DSN = resolve_dsn()

# Uploads are held in memory before hitting Postgres, so the cap is real.
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_AUDIO_BYTES = 25 * 1024 * 1024

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
ALLOWED_AUDIO_TYPES = {"audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/webm"}

app = FastAPI(
    title="Tutor API",
    description="Create custom tutors: personas, avatars, and voices.",
    version="0.1.0",
)


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------


def get_conn():
    """One connection per request. No pool yet — add one before real traffic."""
    dsn = resolve_dsn()
    with psycopg.connect(dsn, autocommit=True) as conn:
        yield conn


ConnDep = Annotated[psycopg.Connection, Depends(get_conn)]


def owner_id(x_user_id: Annotated[str | None, Header()] = None) -> str | None:
    """Stub for auth. `None` means the curated library, which in a real
    deployment must not be writable by an arbitrary caller."""
    return x_user_id


OwnerDep = Annotated[str | None, Depends(owner_id)]


def _personas(conn: psycopg.Connection) -> PostgresPersonaStore:
    return PostgresPersonaStore(conn)


def _blobs(conn: psycopg.Connection) -> PostgresBlobStore:
    return PostgresBlobStore(conn)


def _voices() -> ElevenLabsVoices:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise HTTPException(503, "ELEVENLABS_API_KEY is not configured")
    return ElevenLabsVoices(api_key=key)


def _readable_errors(exc: ValidationError) -> list[dict[str, Any]]:
    """JSON-safe view of a pydantic error.

    pydantic's errors() embeds the original exception object under ctx, which
    the response encoder cannot serialize.
    """
    return [
        {"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]}
        for e in exc.errors(include_url=False)
    ]


async def _read_upload(file: UploadFile, *, allowed: set[str], max_bytes: int) -> bytes:
    if file.content_type not in allowed:
        raise HTTPException(
            415,
            f"unsupported content type {file.content_type!r}; expected one of {sorted(allowed)}",
        )
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty upload")
    if len(data) > max_bytes:
        raise HTTPException(413, f"upload is {len(data)} bytes; limit is {max_bytes}")
    return data


# ---------------------------------------------------------------------------
# Personas
# ---------------------------------------------------------------------------


class PersonaList(BaseModel):
    personas: list[PersonaSpec]


@app.get("/personas", response_model=PersonaList)
def list_personas(conn: ConnDep, owner: OwnerDep) -> PersonaList:
    return PersonaList(personas=_personas(conn).list(owner))


@app.get("/personas/{slug}", response_model=PersonaSpec)
def get_persona(slug: str, conn: ConnDep, owner: OwnerDep) -> PersonaSpec:
    try:
        return _personas(conn).get(slug, owner)
    except PersonaNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.post("/personas", response_model=PersonaSpec, status_code=201)
def create_persona(spec: PersonaSpec, conn: ConnDep, owner: OwnerDep) -> PersonaSpec:
    """Create or replace a persona.

    FastAPI validates the body as a `PersonaSpec`, so §9's consent rules run
    before this function is entered — a real-person persona without granted,
    in-session-captured consent is a 422 and never reaches the database.
    """
    try:
        _personas(conn).upsert(spec, owner)
    except ConsentViolationError as exc:
        # The database is the second wall. Name which rule fired.
        raise HTTPException(422, {"constraint": exc.constraint, "detail": str(exc)}) from exc
    return spec


@app.patch("/personas/{slug}", response_model=PersonaSpec)
def update_persona(slug: str, patch: dict[str, Any], conn: ConnDep, owner: OwnerDep) -> PersonaSpec:
    """Partial update. Merged onto the stored spec, then re-validated whole —
    a patch cannot sneak a persona past the consent rules one field at a time."""
    store = _personas(conn)
    try:
        current = store.get(slug, owner)
    except PersonaNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    merged = current.model_dump(mode="json") | patch
    merged["id"] = slug  # the slug is the identity; a patch may not move it
    try:
        updated = PersonaSpec.model_validate(merged)
    except ValidationError as exc:
        # This validation runs inside the handler rather than on the request
        # body, so FastAPI won't turn it into a 422 for us. Without this the
        # consent rules still hold, but a rejected patch surfaces as a 500 —
        # indistinguishable from the server being broken.
        #
        # Only msg/loc/type: pydantic puts the raw exception object in `ctx`,
        # which the JSON encoder can't serialize, turning the 422 back into a
        # 500 on the way out.
        raise HTTPException(422, _readable_errors(exc)) from exc

    try:
        store.upsert(updated, owner)
    except ConsentViolationError as exc:
        raise HTTPException(422, {"constraint": exc.constraint, "detail": str(exc)}) from exc
    return updated


@app.post("/personas/{slug}/revoke", status_code=204)
def revoke_persona(slug: str, conn: ConnDep, owner: OwnerDep) -> Response:
    """§9: the person cloned may withdraw consent at any time.

    Soft state, not a delete — the row survives so the §10 sweep can find it and
    delete the voice and avatar vendor-side. `get_persona()` stops serving it
    immediately.
    """
    try:
        _personas(conn).revoke(slug, owner)
    except PersonaNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    return Response(status_code=204)


@app.delete("/personas/{slug}", status_code=204)
def delete_persona(slug: str, conn: ConnDep, owner: OwnerDep) -> Response:
    """Soft delete. A hard DELETE fails once any session references the persona."""
    _personas(conn).soft_delete(slug, owner)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Avatar
# ---------------------------------------------------------------------------


class AvatarUploaded(BaseModel):
    blob_id: str
    avatar_ref: str


@app.post("/personas/{slug}/avatar", response_model=AvatarUploaded)
async def upload_avatar(
    slug: str, conn: ConnDep, owner: OwnerDep, file: Annotated[UploadFile, File()]
) -> AvatarUploaded:
    """Attach a photo. LemonSlice builds the avatar from it with no training,
    which is what makes this a 30-second onboarding step (§3)."""
    data = await _read_upload(file, allowed=ALLOWED_IMAGE_TYPES, max_bytes=MAX_IMAGE_BYTES)

    store = _personas(conn)
    try:
        persona = store.get(slug, owner)
    except PersonaNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    blob_id = _blobs(conn).put(
        kind=BlobKind.AVATAR_PHOTO,
        content_type=file.content_type or "application/octet-stream",
        data=data,
        owner_user_id=owner,
    )
    ref = blob_ref(blob_id)
    avatar_update: dict[str, Any] = {"avatar_ref": ref}
    # Uploading a photo is asking for a face. LemonSlice is the vendor that
    # builds one from a single photo, so a voice-only persona flips to it;
    # an explicit simli/lemonslice choice is kept.
    if persona.avatar.provider in ("", "none"):
        avatar_update["provider"] = "lemonslice"
    updated = persona.model_copy(
        update={"avatar": persona.avatar.model_copy(update=avatar_update)}
    )
    store.upsert(updated, owner)
    return AvatarUploaded(blob_id=blob_id, avatar_ref=ref)


@app.get("/blobs/{blob_id}")
def download_blob(blob_id: str, conn: ConnDep) -> Response:
    try:
        blob = _blobs(conn).get(blob_id)
    except BlobNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    return Response(content=blob.data, media_type=blob.content_type)


# ---------------------------------------------------------------------------
# Voice
# ---------------------------------------------------------------------------


class VoiceCapabilitiesOut(BaseModel):
    tier: str
    can_clone_instant: bool
    can_clone_professional: bool
    voice_limit: int
    voices_used: int
    slots_remaining: int


@app.get("/voices/capabilities", response_model=VoiceCapabilitiesOut)
async def voice_capabilities() -> VoiceCapabilitiesOut:
    """Ask before offering cloning in a UI.

    Cloning is plan-gated, and a form that collects a voice sample and then
    fails is worse than one that never offered it.
    """
    voices = _voices()
    try:
        caps = await voices.capabilities()
        return VoiceCapabilitiesOut(
            tier=caps.tier,
            can_clone_instant=caps.can_clone_instant,
            can_clone_professional=caps.can_clone_professional,
            voice_limit=caps.voice_limit,
            voices_used=caps.voices_used,
            slots_remaining=caps.slots_remaining,
        )
    finally:
        await voices.aclose()


@app.get("/voices")
async def list_voices() -> dict[str, Any]:
    """The library — usable on any plan, including free."""
    voices = _voices()
    try:
        return {
            "voices": [
                {
                    "voice_id": v.voice_id,
                    "name": v.name,
                    "category": v.category,
                    "labels": v.labels,
                    "preview_url": v.preview_url,
                }
                for v in await voices.list_voices()
            ]
        }
    finally:
        await voices.aclose()


class VoiceAssigned(BaseModel):
    voice_id: str
    cloned: bool


@app.post("/personas/{slug}/voice", response_model=VoiceAssigned)
async def assign_voice(
    slug: str,
    conn: ConnDep,
    owner: OwnerDep,
    voice_id: str | None = None,
    file: Annotated[UploadFile | None, File()] = None,
) -> VoiceAssigned:
    """Give a persona a voice, either from the library or by cloning a sample.

    Pass `voice_id` to pick an existing voice, or upload audio to clone one.
    Cloning is Instant Voice Clone (1-2 min of audio, ready in seconds), not
    Professional — see providers/elevenlabs_voices.py for why.
    """
    if (voice_id is None) == (file is None):
        raise HTTPException(400, "provide exactly one of voice_id or an audio file")

    store = _personas(conn)
    try:
        persona = store.get(slug, owner)
    except PersonaNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    cloned = False
    if file is not None:
        data = await _read_upload(file, allowed=ALLOWED_AUDIO_TYPES, max_bytes=MAX_AUDIO_BYTES)
        blobs = _blobs(conn)
        blob_id = blobs.put(
            kind=BlobKind.VOICE_SAMPLE,
            content_type=file.content_type or "application/octet-stream",
            data=data,
            owner_user_id=owner,
        )
        voices = _voices()
        try:
            voice_id = await voices.clone_instant(
                name=f"{persona.identity.name} ({slug})",
                samples=[(file.filename or "sample.mp3", data, file.content_type or "audio/mpeg")],
            )
        except VoiceCloningUnavailableError as exc:
            # 402: the fix is a billing action, not a retry.
            raise HTTPException(402, {"code": exc.code, "detail": str(exc)}) from exc
        finally:
            await voices.aclose()
        cloned = True
        # §10: the voice now lives vendor-side; the raw sample is biometric data
        # we no longer need. Purge it rather than letting it accumulate.
        blobs.delete(blob_id)

    voice = (
        persona.voice.model_copy(update={"voice_id": voice_id})
        if persona.voice
        else _default_voice(voice_id)
    )
    store.upsert(persona.model_copy(update={"voice": voice}), owner)
    return VoiceAssigned(voice_id=voice_id, cloned=cloned)


def _default_voice(voice_id: str):
    from tutor_agent.persona import VoiceConfig

    return VoiceConfig(voice_id=voice_id)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
