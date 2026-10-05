from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from dembrane.api.v2 import auth


@pytest.mark.asyncio
async def test_closed_registration_never_creates_accounts_or_sends_email():
    app = FastAPI()
    app.include_router(auth.router)
    settings = SimpleNamespace(feature_flags=SimpleNamespace(public_registration=False))
    with (
        patch.object(auth, "get_settings", return_value=settings),
        patch.object(auth, "async_directus", AsyncMock()) as directus,
        patch.object(auth, "send_email", AsyncMock()) as email,
        patch.object(auth.httpx, "AsyncClient") as transport,
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/register", json={
                "email": "closed@example.com", "password": "Example-password-938!",
                "first_name": "Test", "verification_url": "https://example.com/verify",
            })
        assert response.status_code == 403
        directus.get_users.assert_not_called()
        email.assert_not_called()
        transport.assert_not_called()
