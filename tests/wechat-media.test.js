import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWechatMediaCorrectedSteps,
  executeWechatMediaTransfer,
  WECHAT_MEDIA_VALIDATION_MODE,
} from '../server/src/skills/wechat-media.js';
import { loadApps } from '../server/src/app-registry.js';
import { TaskManager } from '../server/src/harness.js';
import { getWorkflowCatalog } from '../server/src/workflow-registry.js';

const APP = {
  id: 'wechat',
  name: '微信',
  packageName: 'com.tencent.mm',
  harmonyBundleName: 'com.tencent.wechat',
};

test('WeChat media skill sends the first media item to the first conversation', async () => {
  const device = new FakeWechatMediaDevice();
  let captureStarted = false;
  const progress = [];

  const result = await executeWechatMediaTransfer({
    device,
    app: APP,
    startCapture: async () => {
      captureStarted = true;
    },
    onStep: (index, label, total) => progress.push({ index, label, total }),
    sleep: async () => {},
  });

  assert.equal(device.state, 'sent');
  assert.equal(captureStarted, true);
  assert.equal(result.validationMode, WECHAT_MEDIA_VALIDATION_MODE);
  assert.equal(
    result.validationChecks.every((check) => check.status === 'passed'),
    true,
  );
  assert.equal(result.validationChecks.at(-1).id, 'media_sent_1');
  assert.match(result.validationChecks.at(-1).detail, /1 -> 2/);
  assert.equal(result.sentCount, 1);
  assert.equal(result.correctedSteps.length, 5);
  assert.equal(progress.at(-1).index, progress.at(-1).total);
});

test('WeChat media skill repeats by count and waits only between sends', async () => {
  const device = new FakeWechatMediaDevice();
  const waits = [];
  const progress = [];

  const result = await executeWechatMediaTransfer({
    device,
    app: APP,
    parameters: {
      sendMode: 'count',
      count: 3,
      interval: { amount: 2, unit: '秒' },
    },
    onStep: (index, label, total) => progress.push({ index, label, total }),
    sleep: async (ms) => {
      waits.push(ms);
    },
    timings: zeroTimings(),
  });

  assert.equal(result.sentCount, 3);
  assert.equal(device.sentCount, 3);
  assert.equal(result.validationChecks.at(-1).id, 'media_sent_3');
  assert.equal(waits.filter((milliseconds) => milliseconds === 2000).length, 2);
  assert.equal(progress.at(-1).index, progress.at(-1).total);
});

test('WeChat media skill repeats for the requested duration', async () => {
  const device = new FakeWechatMediaDevice();

  const result = await executeWechatMediaTransfer({
    device,
    app: APP,
    parameters: {
      sendMode: 'duration',
      duration: { amount: 5, unit: '秒' },
      interval: { amount: 2, unit: '秒' },
    },
    sleep: async () => {},
    timings: zeroTimings(),
  });

  assert.equal(result.sendMode, 'duration');
  assert.equal(result.sentCount, 3);
  assert.equal(result.effectiveDurationMs, 5000);
  assert.equal(device.sentCount, 3);
});

test('WeChat media skill rejects a send when the chat has no new media node', async () => {
  const device = new FakeWechatMediaDevice({ addMediaAfterSend: false });

  await assert.rejects(
    executeWechatMediaTransfer({
      device,
      app: APP,
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 1)),
      timings: {
        afterLaunchMs: 0,
        afterConversationMs: 0,
        afterMenuMs: 0,
        afterPickerMs: 0,
        afterSelectionMs: 0,
        pollIntervalMs: 1,
        sendTimeoutMs: 2,
      },
    }),
    (error) => {
      assert.equal(error.validationMode, WECHAT_MEDIA_VALIDATION_MODE);
      assert.equal(error.validationChecks.at(-1).id, 'media_sent_1');
      assert.equal(error.validationChecks.at(-1).status, 'failed');
      assert.match(error.message, /未检测到新增媒体消息/);
      return true;
    },
  );
});

test('WeChat media corrected trajectory keeps stable proportional coordinates', () => {
  const steps = buildWechatMediaCorrectedSteps({ width: 1256, height: 2760 });

  assert.deepEqual(
    steps.map((step) => [step.type, step.x, step.y]),
    [
      ['tap', 628, 599],
      ['tap', 1172, 2564],
      ['tap', 183, 2040],
      ['tap', 260, 891],
      ['tap', 1078, 2564],
    ],
  );
});

test('TaskManager gives structured media workflow parameters priority over task text', async () => {
  const apps = loadApps();
  const workflows = getWorkflowCatalog(apps);
  let received = null;
  const manager = new TaskManager({
    adb: {},
    apps,
    workflows,
    wechatMediaExecutor: async (options) => {
      received = options;
      return {
        validationMode: WECHAT_MEDIA_VALIDATION_MODE,
        validationChecks: [],
        sentCount: options.sendCount,
        effectiveDurationMs: null,
      };
    },
  });

  const started = manager.start({
    taskText: '在微信向第一个会话循环发送第一项图片或视频 10分钟 每30秒发送一次',
    parseMode: 'rules',
    workflowId: 'transfer:wechat:send-media',
    parameters: {
      sendMode: 'count',
      count: 4,
      duration: { amount: 10, unit: '分钟' },
      interval: { amount: 3, unit: '秒' },
    },
  });
  const completed = await waitForManagerTask(manager, started.id);

  assert.equal(received.sendMode, 'count');
  assert.equal(received.sendCount, 4);
  assert.equal(received.durationMs, null);
  assert.equal(received.intervalMs, 3000);
  assert.equal(completed.parsed.sendMode, 'count');
  assert.equal(completed.sentCount, 4);
});

class FakeWechatMediaDevice {
  constructor({ addMediaAfterSend = true } = {}) {
    this.state = 'idle';
    this.addMediaAfterSend = addMediaAfterSend;
    this.mediaCount = 1;
    this.sentCount = 0;
  }

  async getDeviceStatus() {
    return {
      connected: true,
      provider: 'hdc',
      platform: 'harmony',
      serial: 'harmony-1',
      screen: { width: 1256, height: 2760 },
    };
  }

  async getScreenSize() {
    return { width: 1256, height: 2760 };
  }

  async forceStopPackage() {
    this.state = 'stopped';
  }

  async launchPackage() {
    this.state = 'list';
  }

  async assertNoSensitivePrompt() {}

  async getCurrentFocus() {
    return {
      packageName: APP.packageName,
      bundleName: APP.harmonyBundleName,
    };
  }

  async tap() {
    if (this.state === 'list') this.state = 'chat';
    else if (this.state === 'chat' || this.state === 'sent') this.state = 'menu';
    else if (this.state === 'menu') this.state = 'picker';
    else if (this.state === 'picker') this.state = 'selected';
    else if (this.state === 'selected') {
      this.sentCount += 1;
      if (this.addMediaAfterSend) this.mediaCount += 1;
      this.state = 'sent';
    }
  }

  async getUiTextSnapshot() {
    if (this.state === 'list') {
      return snapshot(
        ['微信', '通讯录', '发现', '我', '测试会话'],
        node(
          { id: 'WechatMainNavigation', type: 'Navigation', bounds: '[0,137][1256,2760]' },
          [
            node({ text: '微信', type: 'Text', bounds: '[550,171][706,254]' }),
            node({ text: '通讯录', type: 'Text', bounds: '[400,2600][520,2670]' }),
            node({
              id: 'Title',
              text: '测试会话',
              type: 'Text',
              bounds: '[280,516][500,599]',
            }),
          ],
        ),
      );
    }
    if (this.state === 'chat') return chatSnapshot(this.mediaCount);
    if (this.state === 'menu') {
      return snapshot(
        ['照片'],
        node(
          { id: 'ChatActionMenu', type: '__Common__', bounds: '[0,1835][1256,2760]' },
          [
            node({
              text: '照片',
              type: 'Text',
              bounds: '[56,2137][311,2186]',
            }),
          ],
        ),
      );
    }
    if (this.state === 'picker') {
      return snapshot(
        ['图片和视频', '02:08', '发送'],
        node(
          { id: 'image_picker', type: '__Common__', bounds: '[0,137][1256,2760]' },
          [
            node(
              {
                id: 'ImageGridItem_Column_0',
                type: 'Column',
                clickable: 'true',
                bounds: '[0,631][309,940]',
              },
              [
                node({
                  id: 'ThirdSelectAlbumGridBase_GridItemfile://media/first.mp4',
                  type: 'CachedImage',
                  bounds: '[0,631][309,940]',
                }),
              ],
            ),
            node({
              id: 'Selector_0',
              type: 'Column',
              clickable: 'true',
              checkable: 'true',
              bounds: '[225,856][295,926]',
            }),
          ],
        ),
      );
    }
    if (this.state === 'selected') {
      return snapshot(
        ['图片和视频', '发送(1)'],
        node(
          { id: 'image_picker', type: '__Common__', bounds: '[0,137][1256,2760]' },
          [
            node({
              text: '发送(1)',
              type: 'Text',
              bounds: '[998,2530][1158,2599]',
            }),
          ],
        ),
      );
    }
    if (this.state === 'sent') {
      return chatSnapshot(this.mediaCount);
    }
    return snapshot([], node({ type: 'root', bounds: '[0,0][1256,2760]' }));
  }
}

function chatSnapshot(mediaCount) {
  const children = [
    node({ id: 'chat_list', type: '__Common__', bounds: '[0,137][1256,2465]' }),
    node({
      id: 'editor',
      type: 'RichEditor',
      clickable: 'true',
      bounds: '[177,2494][929,2634]',
    }),
    node({
      type: 'Image',
      clickable: 'true',
      bounds: '[1116,2508][1228,2620]',
    }),
  ];
  for (let index = 0; index < mediaCount; index += 1) {
    children.push(
      node({
        type: 'RelativeContainer',
        clickable: 'true',
        bounds: `[809,${900 + index * 520}][1032,${1390 + index * 520}]`,
      }),
    );
  }
  return snapshot([], node({ type: 'root', bounds: '[0,0][1256,2760]' }, children));
}

function snapshot(values, layout) {
  return {
    text: values.join('\n'),
    values,
    layout,
  };
}

function node(attributes, children = []) {
  return { attributes, children };
}

function zeroTimings() {
  return {
    afterLaunchMs: 0,
    afterConversationMs: 0,
    afterMenuMs: 0,
    afterPickerMs: 0,
    afterSelectionMs: 0,
    pollIntervalMs: 0,
    sendTimeoutMs: 10,
  };
}

async function waitForManagerTask(manager, taskId) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const task = manager.snapshot(taskId);
    if (task.status === 'completed') return task;
    if (['failed', 'blocked', 'stopped'].includes(task.status)) {
      throw new Error(task.error || task.status);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('TaskManager media task timed out');
}
