from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from dembrane.popcorn import model

@pytest.mark.asyncio
async def test_popcorn_output_language_overrides_transcript_language_but_preserves_evidence():
    response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"items": []}'))])
    settings = SimpleNamespace(canvas=SimpleNamespace(popcorn_output_language="English"))
    with patch.object(model, "get_settings", return_value=settings), patch.object(model, "arouter_completion", AsyncMock(return_value=response)) as completion:
        await model._structured_completion(system_prompt="Write in transcript language", user_text="Nederlandse tekst", schema={}, max_tokens=100, fast=False, timeout=5)
    prompt = completion.call_args.kwargs["messages"][0]["content"]
    assert "in English" in prompt
    assert "Preserve verbatim evidence quotes in their original language" in prompt
