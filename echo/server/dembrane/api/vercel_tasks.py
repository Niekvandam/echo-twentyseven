"""Authenticated entry point used only by the Vercel queue consumer."""

import json
import secrets
from typing import Any

from redis import Redis
from fastapi import Header, Depends, APIRouter, HTTPException
from dramatiq import Message
from pydantic import Field, BaseModel
from dramatiq.broker import MessageProxy
from dramatiq.middleware import SkipMessage

from dembrane.settings import get_settings
from dembrane.async_helpers import run_in_thread_pool

router = APIRouter()


def authorize(authorization: str = Header(default="")) -> None:
    secret = get_settings().vercel_jobs.secret
    if not secret or not secrets.compare_digest(authorization, f"Bearer {secret}"):
        raise HTTPException(401, "Unauthorized")


class TaskBody(BaseModel):
    queue_name: str
    actor_name: str
    args: list[Any]
    kwargs: dict[str, Any]
    options: dict[str, Any]
    message_id: str = Field(min_length=1, max_length=128)
    message_timestamp: int


def execute_task(body: TaskBody, delivery_count: int) -> dict:
    from dembrane.tasks import broker

    settings = get_settings()
    if not settings.vercel_jobs.url:
        raise HTTPException(503, "Vercel task runtime is disabled")
    client = Redis.from_url(settings.cache.redis_url)
    key = f"twentyseven:jobs:{body.message_id}"
    lock = client.lock(f"{key}:lock", timeout=900, blocking=False)
    if not lock.acquire():
        raise HTTPException(409, "Task is already running")
    try:
        previous = client.get(key)
        if previous:
            return json.loads(previous)
        actor = broker.get_actor(body.actor_name)
        proxy = MessageProxy(Message(**body.model_dump()))
        status = {"status": "completed", "actor": body.actor_name}
        try:
            # Unlike Broker.emit_*, propagate callback persistence failures so
            # the durable queue does not acknowledge incomplete processing.
            for middleware in broker.middleware:
                middleware.before_process_message(broker, proxy)
            result = actor(*body.args, **body.kwargs)
            for middleware in reversed(broker.middleware):
                middleware.after_process_message(broker, proxy, result=result)
        except SkipMessage:
            status["status"] = "skipped"
        except Exception as exc:
            max_retries = body.options.get("max_retries", actor.options.get("max_retries", 20))
            if max_retries is None:
                max_retries = 20
            permanent = isinstance(
                exc, (TypeError, SyntaxError, AttributeError, ImportError, NotImplementedError)
            )
            if not permanent and delivery_count <= max_retries:
                raise HTTPException(503, "Task failed; retry required") from None
            status = {
                "status": "failed",
                "actor": body.actor_name,
                "error_type": type(exc).__name__,
            }
        client.set(key, json.dumps(status), ex=7 * 24 * 3600)
        return status
    finally:
        lock.release()
        client.close()


@router.post("/internal/tasks", dependencies=[Depends(authorize)])
async def execute(body: TaskBody, x_delivery_count: int = Header(default=1, ge=1)) -> dict:
    return await run_in_thread_pool(execute_task, body, x_delivery_count)


@router.get("/internal/tasks/{message_id}", dependencies=[Depends(authorize)])
async def status(message_id: str) -> dict:
    def read() -> dict:
        with Redis.from_url(get_settings().cache.redis_url) as client:
            value = client.get(f"twentyseven:jobs:{message_id}")
            return json.loads(value) if value else {"status": "pending"}

    return await run_in_thread_pool(read)
