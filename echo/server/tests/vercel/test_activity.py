from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from dembrane import activity


@pytest.fixture(autouse=True)
def quiet_throttle():
    activity._last_written_at = 0.0
    yield
    activity._last_written_at = 0.0


def on_vercel(url="https://twentyseven-echo-jobs.vercel.app"):
    settings = MagicMock()
    settings.vercel_jobs.url = url
    return patch.object(activity, "get_settings", return_value=settings)


@pytest.mark.asyncio
async def test_no_heartbeat_where_nothing_scales_to_zero():
    redis = AsyncMock()
    with on_vercel(url=""), patch.object(activity, "get_redis_client", return_value=redis):
        await activity.touch_activity()
    redis.set.assert_not_called()


@pytest.mark.asyncio
async def test_the_key_carries_its_own_expiry():
    redis = AsyncMock()
    with on_vercel(), patch.object(activity, "get_redis_client", return_value=redis):
        await activity.touch_activity()
    redis.set.assert_awaited_once_with(
        activity.ACTIVITY_KEY, b"1", ex=activity.ACTIVITY_TTL_SECONDS
    )


@pytest.mark.asyncio
async def test_a_busy_dashboard_writes_once_per_interval():
    redis = AsyncMock()
    with on_vercel(), patch.object(activity, "get_redis_client", return_value=redis):
        for _ in range(25):
            await activity.touch_activity()
    assert redis.set.await_count == 1


@pytest.mark.asyncio
async def test_a_failed_write_is_retried_by_the_next_request():
    redis = AsyncMock()
    redis.set.side_effect = [ConnectionError("upstash is having a moment"), None]
    with on_vercel(), patch.object(activity, "get_redis_client", return_value=redis):
        await activity.touch_activity()
        await activity.touch_activity()
    assert redis.set.await_count == 2


@pytest.mark.parametrize(
    "path, counts",
    [
        ("/api/v2/me", True),
        ("/api/participant/projects/p/conversations/c/ping", True),
        ("/api/mcp", True),
        # The queue calling itself.
        ("/api/internal/tasks", False),
        ("/api/internal/tasks/abc", False),
        # The platform probing the container port on a cold start. Counting this
        # kept the cron and the container waking each other indefinitely.
        ("/", False),
        ("/docs", False),
        ("/openapi.json", False),
        ("/.well-known/oauth-protected-resource/api/mcp", False),
    ],
)
def test_only_people_and_agents_count_as_activity(path, counts):
    assert activity.counts_as_activity(path) is counts
