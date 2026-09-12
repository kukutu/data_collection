import test from 'node:test';
import assert from 'node:assert/strict';

import { loadApps } from '../server/src/app-registry.js';
import { TaskManager, inferBusinessName } from '../server/src/harness.js';

test('TaskManager starts capture after entering the requested app and stops it afterward', async () => {
  const order = [];
  let capture = null;
  const captureManager = {
    async start(options) {
      order.push('capture-start');
      capture = {
        id: 'capture-1',
        status: 'capturing',
        outputDir: 'D:\\data_collect\\抖音\\启动\\session',
        options,
      };
      return capture;
    },
    async stop() {
      order.push('capture-stop');
      capture = { ...capture, status: 'completed' };
      return capture;
    },
    snapshot() {
      return capture;
    },
  };
  const adb = {
    async getDeviceStatus() {
      return { connected: true, provider: 'hdc', serial: 'harmony-1' };
    },
    async launchPackage() {
      order.push('phone-execution');
    },
  };
  const manager = new TaskManager({ adb, apps: loadApps(), captureManager });

  const started = manager.start({
    taskText: '打开抖音',
    parseMode: 'rules',
    capture: {
      enabled: true,
      interfaceName: 'WLAN3',
      outputRoot: 'D:\\data_collect',
    },
  });
  const completed = await waitForTask(manager, started.id, (task) => task.status === 'completed');

  assert.deepEqual(order, ['phone-execution', 'capture-start', 'capture-stop']);
  assert.equal(completed.capture.status, 'completed');
  assert.equal(capture.options.bundleName, 'com.ss.hm.ugc.aweme');
  assert.equal(capture.options.businessName, '启动');
});

test('TaskManager does not start capture when app entry fails', async () => {
  let captureStarts = 0;
  const manager = new TaskManager({
    adb: {
      async launchPackage() {
        throw new Error('app entry failed');
      },
    },
    apps: loadApps(),
    captureManager: {
      async start() {
        captureStarts += 1;
      },
      snapshot() {
        return null;
      },
    },
  });

  const started = manager.start({
    taskText: '打开抖音',
    parseMode: 'rules',
    capture: { enabled: true },
  });
  const failed = await waitForTerminalTask(manager, started.id);

  assert.equal(failed.status, 'failed');
  assert.equal(captureStarts, 0);
  assert.equal(failed.capture, undefined);
});

test('TaskManager does not start capture for a blocked task', async () => {
  let captureStarts = 0;
  const manager = new TaskManager({
    adb: {},
    apps: loadApps(),
    captureManager: {
      async start() {
        captureStarts += 1;
      },
      snapshot() {
        return null;
      },
    },
  });

  const started = manager.start({
    taskText: '自动抢票',
    parseMode: 'rules',
    capture: { enabled: true },
  });
  const blocked = await waitForTask(manager, started.id, (task) => task.status === 'blocked');

  assert.equal(blocked.status, 'blocked');
  assert.equal(captureStarts, 0);
});

test('infers the capture business directory from task intent', () => {
  assert.equal(inferBusinessName({ intent: 'watch_feed' }), '短视频');
  assert.equal(inferBusinessName({ intent: 'watch_live' }), '直播');
  assert.equal(inferBusinessName({ intent: 'tencent_quick_meeting' }), '会议');
  assert.equal(inferBusinessName({ intent: 'ai_chat' }), 'AI应用');
  assert.equal(inferBusinessName({ intent: 'launch_app' }), '启动');
});

async function waitForTask(manager, taskId, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const task = manager.snapshot(taskId);
    if (predicate(task)) return task;
    if (['failed', 'stopped'].includes(task.status)) {
      throw new Error(`Task reached terminal state ${task.status}: ${task.error || ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

async function waitForTerminalTask(manager, taskId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const task = manager.snapshot(taskId);
    if (['completed', 'failed', 'blocked', 'stopped'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}
