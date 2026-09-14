import test from 'node:test';
import assert from 'node:assert/strict';

import { loadApps } from '../server/src/app-registry.js';
import { TaskManager, applyRepeatParameters, inferBusinessName } from '../server/src/harness.js';
import { getWorkflowCatalog } from '../server/src/workflow-registry.js';

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

test('repeat parameters are applied to repeatable intents and preserve default single runs', () => {
  const parsed = applyRepeatParameters(
    { intent: 'tencent_quick_meeting' },
    {
      parameters: {
        repeatCount: 5,
        repeatInterval: { amount: 2, unit: '秒' },
      },
    },
  );
  assert.equal(parsed.repeatCount, 5);
  assert.equal(parsed.repeatIntervalMs, 2000);
  assert.deepEqual(
    applyRepeatParameters({ intent: 'watch_feed' }),
    { intent: 'watch_feed' },
  );
  assert.equal(
    applyRepeatParameters({ intent: 'baidu_netdisk_upload' }, { taskText: '上传，重复3次，间隔2秒' }).repeatCount,
    3,
  );
});

test('TaskManager repeats a VoIP workflow and captures each iteration independently', async () => {
  const apps = loadApps();
  const workflows = getWorkflowCatalog(apps);
  const starts = [];
  const stops = [];
  const sessions = new Map();
  let executorCalls = 0;
  const captureManager = {
    async start(options) {
      const id = `capture-${starts.length + 1}`;
      const capture = { id, status: 'capturing', outputDir: `D:\\captures\\${id}`, options };
      sessions.set(id, capture);
      starts.push(id);
      return capture;
    },
    async stop(id, { reason }) {
      const capture = { ...sessions.get(id), status: reason === 'completed' ? 'completed' : reason };
      sessions.set(id, capture);
      stops.push(id);
      return capture;
    },
    snapshot(id) {
      return sessions.get(id) || null;
    },
  };
  const manager = new TaskManager({
    adb: {
      async getDeviceStatus() {
        return { connected: true, provider: 'hdc', serial: 'test-device' };
      },
    },
    apps,
    workflows,
    captureManager,
    meetimeVoipExecutor: async ({ startCapture, sleep, onStep }) => {
      executorCalls += 1;
      onStep(1, `iteration ${executorCalls}`, 1);
      await startCapture();
      await sleep(1);
      return {
        validationMode: 'repeat_test',
        validationChecks: [{ id: 'iteration', status: 'passed' }],
        effectiveDurationMs: 1,
      };
    },
  });

  const started = manager.start({
    taskText: '',
    parseMode: 'rules',
    workflowId: 'voip:meetime:audio-call',
    parameters: {
      phoneNumber: '13145650791',
      duration: { amount: 1, unit: '秒' },
      repeatCount: 3,
      repeatInterval: { amount: 1, unit: '毫秒' },
    },
    capture: { enabled: true, interfaceName: 'WLAN3', outputRoot: 'D:\\captures' },
  });
  const completed = await waitForTask(manager, started.id, (task) => task.status === 'completed');

  assert.equal(executorCalls, 3);
  assert.deepEqual(starts, ['capture-1', 'capture-2', 'capture-3']);
  assert.deepEqual(stops, starts);
  assert.equal(completed.repeatCount, 3);
  assert.equal(completed.captureCount, 3);
  assert.equal(completed.captures.length, 3);
  assert.equal(completed.iterationResults.length, 3);
  assert.ok(completed.iterationResults.every((result) => result.status === 'completed'));
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
