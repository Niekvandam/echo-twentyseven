import { randomUUID } from 'node:crypto';
import { QueueClient } from '@vercel/queue';

// Each actor catches up on work that a crash, a closed browser or a missed tick
// left behind. None of them has anything to do while nobody is using Echo.
export const ACTORS = [
  'task_collect_and_finish_unfinished_conversations',
  'task_reconcile_transcribed_flag',
  'task_catch_up_unsummarized_conversations',
  'task_catch_up_uncounted_conversations',
  'task_reconcile_popcorn_tick_tasks',
  'task_process_scheduled_tasks',
];

const queue = new QueueClient();

// The bucket makes a retried cron run idempotent: two firings inside the same
// window enqueue the same key and the queue keeps one.
export async function enqueueReconcile(prefix, bucketMs) {
  for (const actor_name of ACTORS) {
    const message_id = randomUUID();
    await queue.send('echo-tasks', {
      queue_name: 'network', actor_name, args: [],
      kwargs: actor_name === 'task_process_scheduled_tasks' ? { task_type: 'popcorn_tick' } : {},
      options: {},
      message_id, message_timestamp: Date.now(),
    }, { idempotencyKey: `${prefix}:${actor_name}:${Math.floor(Date.now() / bucketMs)}` });
  }
  return ACTORS.length;
}
