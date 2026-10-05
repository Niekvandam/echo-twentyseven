import { QueueClient } from '@vercel/queue';

const queue = new QueueClient();
export default queue.handleNodeCallback(async (message, metadata) => {
  const base = process.env.ECHO_API_URL;
  const secret = process.env.ECHO_JOBS_SECRET;
  if (!base || !secret) throw new Error('Task runtime is not configured');
  const response = await fetch(`${base}/api/internal/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'X-Delivery-Count': String(metadata.deliveryCount),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(750000),
  });
  if (!response.ok) throw new Error(`Task execution returned ${response.status}`);
}, { visibilityTimeoutSeconds: 900 });
