import test from 'node:test';
import assert from 'node:assert/strict';

import { loadApps } from '../server/src/app-registry.js';
import { TaskManager } from '../server/src/harness.js';

test('TaskManager pauses at manual confirmation and continues after confirmation', async () => {
  const adb = createFakeAdb();
  const manager = new TaskManager({ adb, apps: loadApps() });
  const started = manager.start({ taskText: '刷8秒小红书视频', parseMode: 'rules' });

  const waiting = await waitForTask(manager, started.id, (task) => task.status === 'waiting_confirmation');

  assert.equal(waiting.status, 'waiting_confirmation');
  assert.equal(manager.currentSnapshot().id, started.id);
  assert.equal(manager.currentSnapshot().status, 'waiting_confirmation');
  assert.match(waiting.pendingConfirmation.message, /手动点入/);
  assert.equal(adb.swipes.length, 0, 'XHS should not swipe before manual confirmation');

  assert.equal(manager.continue(started.id), true);

  const completed = await waitForTask(manager, started.id, (task) => task.status === 'completed');
  assert.equal(completed.status, 'completed');
  assert.ok(adb.swipes.length > 0, 'feed swipes should happen after confirmation');
});

function createFakeAdb() {
  let screenshotCount = 0;
  const adb = {
    swipes: [],
    async forceStopPackage() {},
    async launchPackage() {},
    async assertNoSensitivePrompt() {},
    async tapText() {},
    async tapTextInRegion() {},
    async tap() {},
    async getScreenSize() {
      return { width: 1260, height: 2800 };
    },
    async getCurrentFocus() {
      return { packageName: 'com.xingin.xhs', activity: 'com.xingin.matrix.notedetail.NoteDetailActivity' };
    },
    async getUiTextSnapshot() {
      return { text: 'RED' };
    },
    async screenshotPng() {
      screenshotCount += 1;
      return Buffer.from(`screen-${screenshotCount}`);
    },
    async swipe(step) {
      adb.swipes.push(step);
    },
  };
  return adb;
}

async function waitForTask(manager, taskId, predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const task = manager.snapshot(taskId);
    if (predicate(task)) return task;
    if (['failed', 'blocked', 'stopped'].includes(task.status)) {
      throw new Error(`Task reached terminal state ${task.status}: ${task.error || ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}
