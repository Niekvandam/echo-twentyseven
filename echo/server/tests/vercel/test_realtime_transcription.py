from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
import pytest_asyncio
from jose import jwt

from dembrane.api import realtime_transcription as realtime
from dembrane.settings import get_settings


@pytest_asyncio.fixture
async def client():
    app = FastAPI()
    app.include_router(realtime.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client


@pytest.mark.asyncio
async def test_token_rejects_conversation_from_another_project(client):
    project, conversation = uuid4(), uuid4()
    with patch.object(
        realtime.conversation_service,
        "get_by_id_or_raise",
        return_value={"project_id": str(uuid4())},
    ):
        response = await client.post(
            f"/participant/projects/{project}/conversations/{conversation}/realtime-token"
        )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_token_does_not_bypass_anonymization(client):
    project, conversation = uuid4(), uuid4()
    with (
        patch.object(
            realtime.conversation_service,
            "get_by_id_or_raise",
            return_value={"project_id": str(project), "is_anonymized": True},
        ),
        patch.object(
            realtime.project_service,
            "get_by_id_or_raise",
            return_value={"is_conversation_allowed": True},
        ),
    ):
        response = await client.post(
            f"/participant/projects/{project}/conversations/{conversation}/realtime-token"
        )
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_segment_requires_signed_conversation_authorization(client):
    project, conversation = uuid4(), uuid4()
    body = {"id": str(uuid4()), "text": "Test", "timestamp": datetime.now(timezone.utc).isoformat()}
    path = f"/participant/projects/{project}/conversations/{conversation}/realtime-segments"
    assert (await client.post(path, json=body)).status_code == 401
    token = jwt.encode(
        {"sub": str(uuid4()), "project": str(project), "aud": "realtime-transcript"},
        get_settings().directus.secret,
        algorithm="HS256",
    )
    assert (
        await client.post(path, json=body, headers={"Authorization": f"Bearer {token}"})
    ).status_code == 403


def test_replayed_segment_returns_existing_id_without_creating_again():
    project, conversation = str(uuid4()), str(uuid4())
    body = realtime.Segment(id=uuid4(), text="Keep this once", timestamp=datetime.now(timezone.utc))
    directus = MagicMock()
    directus.get_items.return_value = [{"transcript": body.text}]
    context = MagicMock()
    context.__enter__.return_value = directus
    with (
        patch.object(realtime, "validate_conversation"),
        patch.object(realtime.Redis, "from_url"),
        patch("dembrane.directus.directus_client_context", return_value=context),
        patch.object(realtime.conversation_service, "create_chunk") as create,
    ):
        first = realtime.save_segment(project, conversation, body)
        second = realtime.save_segment(project, conversation, body)
        assert first == second
        create.assert_not_called()
        body.text = "Changed text"
        with pytest.raises(realtime.HTTPException) as exc:
            realtime.save_segment(project, conversation, body)
        assert exc.value.status_code == 409
