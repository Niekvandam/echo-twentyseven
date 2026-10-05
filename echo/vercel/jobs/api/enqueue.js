import { send } from '@vercel/queue';
import { authorized } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  if (!authorized(req.headers.authorization, process.env.ECHO_JOBS_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { message, delay = 0 } = req.body ?? {};
  if (!message || typeof message.message_id !== 'string' ||
      typeof message.actor_name !== 'string' || !Array.isArray(message.args) ||
      !message.kwargs || !message.options ||
      !Number.isSafeInteger(delay) || delay < 0 || delay > 86400000 ||
      Buffer.byteLength(JSON.stringify(message)) > 60000) {
    return res.status(400).json({ error: 'Invalid task message' });
  }
  try {
    const result = await send('echo-tasks', message, {
      idempotencyKey: `${message.message_id}:${message.options.retries ?? 0}`,
      delaySeconds: Math.ceil(delay / 1000),
    });
    return res.status(202).json({ messageId: result.messageId });
  } catch {
    return res.status(503).json({ error: 'Queue unavailable' });
  }
}
