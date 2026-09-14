import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPTURE_LEAD_MS,
  startCaptureBeforeAction,
} from '../server/src/skills/capture-timing.js';

test('capture timing starts capture and waits the one-second lead before the action', async () => {
  const events = [];
  await startCaptureBeforeAction(
    async () => events.push('capture'),
    async (ms) => events.push(`sleep:${ms}`),
  );
  assert.deepEqual(events, ['capture', `sleep:${CAPTURE_LEAD_MS}`]);
});

test('capture timing is a no-op when capture is disabled', async () => {
  let slept = false;
  assert.equal(await startCaptureBeforeAction(null, async () => { slept = true; }), false);
  assert.equal(slept, false);
});
