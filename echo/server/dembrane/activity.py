"""The heartbeat that says a person is using Twentyseven right now.

On Vercel both containers scale down after five minutes without traffic, and
provisioned memory is billed for as long as an instance lives. The reconcile
cron used to poke the API every two minutes, so neither container ever reached
that window and an empty night cost the same as a busy afternoon.

So the cron asks this key first. Every request a person makes refreshes it;
twenty minutes after the last one it expires and both containers go to sleep.

Only requests under /api, minus the queue's own calls, count. An earlier version
refreshed the key for anything that was not /api/internal/, and never slept: the
platform probes a container's port when it starts, that probe refreshed the key,
the cron woke the container two minutes later, and its probe refreshed the key
again. The queue is excluded for the same reason - it is the cron's own work
coming back, and the work it enqueues already wakes the API on its own.
"""

import time
from logging import getLogger

from dembrane.settings import get_settings
from dembrane.redis_async import get_redis_client

logger = getLogger("activity")

ACTIVITY_KEY = "twentyseven:active"

# Long enough that work started by somebody's last click still finds the cron
# running, short enough that an evening without visitors costs nothing.
ACTIVITY_TTL_SECONDS = 20 * 60

# The TTL is measured in minutes, so one write per process per half minute is
# plenty. Without this a busy dashboard would write on every poll.
_REFRESH_EVERY_SECONDS = 30

_last_written_at = 0.0


def counts_as_activity(path: str) -> bool:
    """Whether this request means a person or an agent is here."""
    return path.startswith("/api/") and not path.startswith("/api/internal/")


async def touch_activity(path: str = "") -> None:
    """Mark Echo as in use. Cheap enough to call on every request."""
    global _last_written_at

    if not get_settings().vercel_jobs.url:
        # Not the Vercel deployment: nothing scales to zero, nothing to gate.
        return

    now = time.monotonic()
    if now - _last_written_at < _REFRESH_EVERY_SECONDS:
        return
    _last_written_at = now

    try:
        client = await get_redis_client()
        await client.set(ACTIVITY_KEY, b"1", ex=ACTIVITY_TTL_SECONDS)
        # Named, so that anything unexpectedly holding the containers awake can
        # be found in the logs instead of guessed at.
        logger.info("activity heartbeat refreshed by %s", path or "an unnamed request")
    except Exception:
        # Let the next request try again rather than wait out the interval. The
        # cron fails open, so a missed write delays sleep; it never drops work.
        _last_written_at = 0.0
        logger.warning("could not refresh the activity heartbeat", exc_info=True)
