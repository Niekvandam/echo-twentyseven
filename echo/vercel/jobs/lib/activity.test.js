import { test } from 'node:test';
import assert from 'node:assert/strict';
import { someoneIsAround } from './activity.js';
import { ACTORS } from './reconcile.js';

test('an unconfigured or unreachable gate keeps housekeeping running', async () => {
  assert.equal(await someoneIsAround(undefined), true);
  assert.equal(await someoneIsAround(''), true);
  assert.equal(await someoneIsAround('redis://127.0.0.1:1'), true);
});

test('the popcorn tick is still one of the reconciled actors', () => {
  assert.ok(ACTORS.includes('task_process_scheduled_tasks'));
  assert.equal(new Set(ACTORS).size, ACTORS.length);
});
