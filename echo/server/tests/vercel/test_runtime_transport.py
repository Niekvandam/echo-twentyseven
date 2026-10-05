from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from dramatiq import Message

from dembrane import coordination
from dembrane.vercel_broker import VercelBroker


def test_managed_coordination_keeps_database_zero_and_tls_verification():
    url = "rediss://example.invalid:6379"
    with (
        patch.object(coordination, "REDIS_URL", url),
        patch.object(
            coordination,
            "settings",
            SimpleNamespace(vercel_jobs=SimpleNamespace(url="https://jobs.invalid")),
        ),
        patch.object(coordination.redis, "from_url") as connect,
    ):
        coordination._get_sync_redis_client()
    connect.assert_called_once_with(url, decode_responses=True)


def test_enqueue_preserves_actor_message_and_delay():
    broker = VercelBroker("https://jobs.invalid", "test-secret")
    message = Message(
        queue_name="network", actor_name="test_actor", args=("conversation",), kwargs={}, options={}
    )
    with patch(
        "dembrane.vercel_broker.requests.post", return_value=MagicMock(status_code=202)
    ) as post:
        assert broker.enqueue(message, delay=1200) is message
    assert post.call_args.kwargs["json"] == {"message": message.asdict(), "delay": 1200}
    assert post.call_args.kwargs["headers"] == {"Authorization": "Bearer test-secret"}


def test_enqueue_does_not_silently_drop_a_rejected_task():
    broker = VercelBroker("https://jobs.invalid", "test-secret")
    message = Message(queue_name="network", actor_name="test_actor", args=(), kwargs={}, options={})
    with patch("dembrane.vercel_broker.requests.post", return_value=MagicMock(status_code=503)):
        with pytest.raises(RuntimeError, match="Task enqueue failed"):
            broker.enqueue(message)
