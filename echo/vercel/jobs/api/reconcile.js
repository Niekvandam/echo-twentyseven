import { authorized } from '../lib/auth.js';
import { someoneIsAround } from '../lib/activity.js';
import { enqueueReconcile } from '../lib/reconcile.js';

// Runs every two minutes, which is the cadence a live Popcorn session needs.
// While nobody is around it reads one Redis key and stops there, so the API and
// Directus containers reach their five-minute idle window and scale to zero.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!authorized(req.headers.authorization, process.env.CRON_SECRET)) return res.status(401).end();
  if (!(await someoneIsAround())) return res.status(200).json({ queued: 0, skipped: 'idle' });
  try {
    return res.status(202).json({ queued: await enqueueReconcile('reconcile', 120000) });
  } catch { return res.status(503).json({ error: 'Reconciliation could not be queued' }); }
}
