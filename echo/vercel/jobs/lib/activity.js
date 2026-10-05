import { createClient } from 'redis';

// The API refreshes this key on every request a person makes. It is the whole
// signal: both containers scale down after five minutes without traffic, so
// housekeeping that runs while nobody is here buys nothing and keeps them awake.
export const ACTIVITY_KEY = 'twentyseven:active';

export async function someoneIsAround(url = process.env.REDIS_URL) {
  // An unconfigured gate is not a reason to stop housekeeping.
  if (!url) return true;
  const client = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } });
  try {
    await client.connect();
    return (await client.exists(ACTIVITY_KEY)) === 1;
  } catch {
    // A Redis hiccup should cost money, never correctness.
    return true;
  } finally {
    try { client.destroy(); } catch { /* never connected */ }
  }
}
