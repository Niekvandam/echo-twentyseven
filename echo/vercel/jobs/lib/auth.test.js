import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized } from './auth.js';

test('internal jobs fail closed without a configured secret', () => {
  assert.equal(authorized('Bearer undefined', undefined), false);
  assert.equal(authorized('Bearer ', ''), false);
});
test('only the complete bearer credential is accepted', () => {
  assert.equal(authorized('Bearer test-secret', 'test-secret'), true);
  for (const value of [undefined, '', 'test-secret', 'Bearer wrong', ['Bearer test-secret']]) {
    assert.equal(authorized(value, 'test-secret'), false);
  }
});
