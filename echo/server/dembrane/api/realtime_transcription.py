"""ElevenLabs token issuance and idempotent committed transcript ingestion."""

from uuid import UUID, uuid5
from datetime import datetime, timezone, timedelta

import httpx
from jose import JWTError, jwt
from redis import Redis
from fastapi import Header, Request, Response, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.service import project_service, conversation_service
from dembrane.settings import get_settings
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.rate_limit import create_rate_limiter

router = APIRouter(prefix="/participant/projects/{project_id}/conversations/{conversation_id}")
token_limit = create_rate_limiter(name="elevenlabs-token", capacity=30, window_seconds=3600)
ip_limit = create_rate_limiter(name="elevenlabs-ip", capacity=60, window_seconds=3600)
segment_limit = create_rate_limiter(name="elevenlabs-segment", capacity=120, window_seconds=60)


def validate_conversation(project_id: str, conversation_id: str) -> dict:
    from dembrane.service.project import ProjectNotFoundException
    from dembrane.service.conversation import ConversationNotFoundException

    try:
        conversation = conversation_service.get_by_id_or_raise(conversation_id)
        if conversation["project_id"] != project_id:
            raise HTTPException(404, "Conversation not found")
        project = project_service.get_by_id_or_raise(project_id)
    except (ConversationNotFoundException, ProjectNotFoundException):
        raise HTTPException(404, "Conversation not found") from None
    if not project.get("is_conversation_allowed") or conversation.get("is_finished"):
        raise HTTPException(403, "Conversation is closed")
    if conversation.get("is_anonymized"):
        raise HTTPException(409, "Live transcription is not available for anonymized conversations")
    return conversation


@router.post("/realtime-token")
async def token(
    project_id: UUID, conversation_id: UUID, request: Request, response: Response
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    project, conversation = str(project_id), str(conversation_id)
    await run_in_thread_pool(validate_conversation, project, conversation)
    await token_limit.check(conversation)
    await ip_limit.check(request.client.host if request.client else "unknown")
    settings = get_settings()
    key = settings.transcription.elevenlabs_api_key
    if not key:
        raise HTTPException(503, "Live transcription is not configured")
    async with httpx.AsyncClient(timeout=20) as client:
        provider_response = await client.post(
            "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
            headers={"xi-api-key": key},
        )
    if provider_response.status_code != 200:
        raise HTTPException(502, "Unable to start live transcription")
    participant_token = jwt.encode(
        {
            "sub": conversation,
            "project": project,
            "aud": "realtime-transcript",
            "exp": datetime.now(timezone.utc) + timedelta(hours=12),
        },
        settings.directus.secret,
        algorithm="HS256",
    )
    return {"token": provider_response.json()["token"], "participant_token": participant_token}


class Segment(BaseModel):
    id: UUID
    text: str = Field(min_length=1, max_length=20000)
    timestamp: datetime


def save_segment(project_id: str, conversation_id: str, body: Segment) -> dict:
    from dembrane.directus import directus_client_context

    validate_conversation(project_id, conversation_id)
    chunk_id = str(uuid5(UUID(conversation_id), str(body.id)))
    with Redis.from_url(get_settings().cache.redis_url) as redis:
        with redis.lock(f"twentyseven:segment:{chunk_id}", timeout=60, blocking_timeout=5):
            with directus_client_context() as client:
                existing = client.get_items(
                    "conversation_chunk",
                    {"query": {"filter": {"id": {"_eq": chunk_id}}, "limit": 1}},
                )
            if existing:
                if existing[0].get("transcript") != body.text:
                    raise HTTPException(409, "Segment already exists with different text")
                return {"id": chunk_id}
            conversation_service.create_chunk(
                conversation_id=conversation_id,
                chunk_id=chunk_id,
                timestamp=body.timestamp,
                source="PORTAL_ELEVENLABS",
                transcript=body.text,
            )
    return {"id": chunk_id}


@router.post("/realtime-segments")
async def segment(
    project_id: UUID, conversation_id: UUID, body: Segment, authorization: str = Header(default="")
) -> dict:
    try:
        claims = jwt.decode(
            authorization.removeprefix("Bearer "),
            get_settings().directus.secret,
            algorithms=["HS256"],
            audience="realtime-transcript",
        )
        if claims.get("sub") != str(conversation_id) or claims.get("project") != str(project_id):
            raise HTTPException(403, "Wrong conversation")
    except JWTError:
        raise HTTPException(401, "Invalid participant token") from None
    if not body.text.strip():
        raise HTTPException(400, "Transcript is empty")
    await segment_limit.check(str(conversation_id))
    result = await run_in_thread_pool(save_segment, str(project_id), str(conversation_id), body)
    from dembrane.monitor_stream import publish_monitor_dirty

    await publish_monitor_dirty(str(project_id))
    return result
