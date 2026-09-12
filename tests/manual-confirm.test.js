import test from 'node:test';
import assert from 'node:assert/strict';

import { loadApps } from '../server/src/app-registry.js';
import { TaskManager } from '../server/src/harness.js';
import { getWorkflowCatalog } from '../server/src/workflow-registry.js';

test('TaskManager pauses at manual confirmation and continues after confirmation', async () => {
  const adb = createFakeAdb('com.tencent.qqlive');
  const manager = new TaskManager({ adb, apps: loadApps() });
  const started = manager.start({ taskText: '看1秒腾讯视频', parseMode: 'rules' });

  const waiting = await waitForTask(manager, started.id, (task) => task.status === 'waiting_confirmation');

  assert.equal(waiting.status, 'waiting_confirmation');
  assert.equal(manager.currentSnapshot().id, started.id);
  assert.equal(manager.currentSnapshot().status, 'waiting_confirmation');
  assert.match(waiting.pendingConfirmation.message, /手动打开要观看的腾讯视频/);
  assert.equal(waiting.pendingConfirmation.confirmLabel, '我已点入视频，继续');
  assert.equal(
    adb.keyevents.includes('KEYCODE_MEDIA_PLAY'),
    false,
    'Tencent Video should not resume playback before manual confirmation',
  );

  assert.equal(manager.continue(started.id), true);

  const completed = await waitForTask(manager, started.id, (task) => task.status === 'completed');
  assert.equal(completed.status, 'completed');
  assert.ok(
    adb.keyevents.includes('KEYCODE_MEDIA_PLAY'),
    'Tencent Video should resume playback after confirmation',
  );
});

test('completed tasks do not automatically mark an app as tested', async () => {
  const adb = createFakeAdb();
  const apps = loadApps();
  const douyin = apps.find((app) => app.id === 'douyin');
  douyin.tested = false;
  const manager = new TaskManager({ adb, apps });
  const started = manager.start({ taskText: '打开抖音', parseMode: 'rules' });

  const completed = await waitForTask(manager, started.id, (task) => task.status === 'completed');

  assert.equal(completed.status, 'completed');
  assert.equal(douyin.tested, false);
  assert.equal(completed.deviceSession.serial, 'fake-device-1');
  assert.deepEqual(
    adb.deviceLocks.map((entry) => entry.type),
    ['begin', 'end'],
  );
});

test('TaskManager keeps shortcut workflow metadata while hiding sensitive parameters', async () => {
  const adb = createFakeAdb('com.ss.android.ugc.aweme');
  const manager = new TaskManager({
    adb,
    apps: loadApps(),
    workflows: getWorkflowCatalog(loadApps()),
  });
  const started = manager.start({
    taskText: '打开抖音',
    parseMode: 'rules',
    workflowId: 'short-video:douyin:short-video-feed',
    parameters: {
      duration: { amount: 30, unit: '秒' },
    },
  });

  assert.equal(started.workflowId, 'short-video:douyin:short-video-feed');
  assert.equal(started.workflowName, '抖音短视频');
  assert.deepEqual(started.parameters, {
    duration: { amount: 30, unit: '秒' },
  });
  await waitForTask(manager, started.id, (task) => task.status === 'completed');
});

function createFakeAdb(focusPackage = 'com.xingin.xhs') {
  let screenshotCount = 0;
  const adb = {
    swipes: [],
    keyevents: [],
    deviceLocks: [],
    async beginSession({ owner }) {
      const lock = {
        id: `lock-${adb.deviceLocks.length + 1}`,
        owner,
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'fake-device-1',
        screen: { width: 1260, height: 2800 },
      };
      adb.deviceLocks.push({ type: 'begin', lock });
      return lock;
    },
    async endSession(lock) {
      adb.deviceLocks.push({ type: 'end', lock });
    },
    async forceStopPackage() {},
    async launchPackage() {},
    async keyevent(code) {
      adb.keyevents.push(code);
    },
    async tapResource() {},
    async assertNoSensitivePrompt() {},
    async tapText() {},
    async tapTextInRegion() {},
    async tap() {},
    async getScreenSize() {
      return { width: 1260, height: 2800 };
    },
    async getCurrentFocus() {
      return { packageName: focusPackage, activity: 'com.example.MainActivity' };
    },
    async getDisplayOrientation() {
      return { isLandscape: true, raw: 'landscape' };
    },
    async getMediaPlaybackState() {
      return { isPlaying: true, stateName: 'PLAYING', stateCode: 3 };
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
