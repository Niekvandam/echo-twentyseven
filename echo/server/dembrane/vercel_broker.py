"""HTTP transport for Dramatiq actors executed by Vercel Queues.

Actor code, results and group callbacks remain shared with the worker runtime.
Vercel owns redelivery; no resident Redis consumer or worker thread is started.
"""

import requests
from dramatiq import Broker, Message
from dramatiq.middleware import AgeLimit, Callbacks, Pipelines


class VercelBroker(Broker):
    def __init__(self, url: str, secret: str) -> None:
        if not url or not secret:
            raise ValueError("Vercel jobs URL and secret are required")
        super().__init__(middleware=[AgeLimit(), Callbacks(), Pipelines()])
        self.url = url.rstrip("/")
        self.secret = secret
        self.actor_options.update({"max_retries", "min_backoff", "max_backoff", "time_limit"})

    def declare_queue(self, queue_name: str) -> None:
        if queue_name not in self.queues:
            self.emit_before("declare_queue", queue_name)
            self.queues[queue_name] = None
            self.emit_after("declare_queue", queue_name)

    def enqueue(self, message: Message, *, delay: int | None = None) -> Message:
        self.emit_before("enqueue", message, delay)
        response = requests.post(
            f"{self.url}/api/enqueue",
            headers={"Authorization": f"Bearer {self.secret}"},
            json={"message": message.asdict(), "delay": delay or 0},
            timeout=30,
        )
        if response.status_code != 202:
            # Provider bodies can contain credentials or task content.
            raise RuntimeError(f"Task enqueue failed ({response.status_code})")
        self.emit_after("enqueue", message, delay)
        return message
