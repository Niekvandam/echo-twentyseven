import { authorized } from '../lib/auth.js';
import { enqueueReconcile } from '../lib/reconcile.js';

// The daily safety net. The gated cron only runs while someone is using Echo,
// so work stranded after the last person left would otherwise wait for the next
// visit. This one wakes the containers once a night regardless.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!authorized(req.headers.authorization, process.env.CRON_SECRET)) return res.status(401).end();
  try {
    return res.status(202).json({ queued: await enqueueReconcile('sweep', 86400000) });
  } catch { return res.status(503).json({ error: 'The sweep could not be queued' }); }
}
