import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildKuaishouLiveCorrectedSteps,
  executeKuaishouLiveBrowse,
  KUAISHOU_LIVE_VALIDATION_MODE,
  KUAISHOU_LIVE_WORKFLOW_ID,
  kuaishouLiveDurationToMs,
} from '../server/src/skills/kuaishou-live.js';
import { applyWorkflowParameters } from '../server/src/harness.js';

const screen = { width: 1280, height: 2832 };
const app = {
  id: 'kuaishou',
  name: '快手',
  packageName: 'com.smile.gifmaker',
  harmonyBundleName: 'com.kuaishou.hmapp',
};

test('normalizes Kuaishou live duration and corrected coordinates', () => {
  assert.equal(kuaishouLiveDurationToMs({ amount: 5, unit: '秒' }), 5000);
  assert.equal(kuaishouLiveDurationToMs({ amount: 2, unit: '分钟' }), 120_000);
  assert.throws(
    () => kuaishouLiveDurationToMs({ amount: 0, unit: '秒' }),
    /无效的快手直播观看时长/,
  );

  const steps = buildKuaishouLiveCorrectedSteps(screen);
  assert.deepEqual(
    steps.filter((step) => step.type === 'tap').map((step) => [step.x, step.y]),
    [
      [134, 2671],
      [798, 227],
      [379, 923],
    ],
  );
  assert.ok(steps.some((step) => step.type === 'hold_state'));
  assert.ok(steps.some((step) => step.type === 'swipe'));
});

test('Kuaishou live workflow parameters override parsed duration and switch interval', () => {
  assert.deepEqual(
    applyWorkflowParameters(
      {
        intent: 'live_entry',
        appName: '快手',
        durationMs: 30_000,
        switchIntervalMs: null,
      },
      {
        workflowId: KUAISHOU_LIVE_WORKFLOW_ID,
        parameters: {
          duration: { amount: 2, unit: '分钟' },
          switchInterval: { amount: 5, unit: '秒' },
        },
      },
    ),
    {
      intent: 'live_entry',
      appName: '快手',
      durationMs: 120_000,
      switchIntervalMs: 5000,
    },
  );
});

test('strict Kuaishou live replay skips the ad, enters a room, and verifies one switch', async () => {
  let state = 'idle';
  let clock = 0;
  let screenshotIndex = 0;
  const calls = [];

  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-kuaishou',
        screen,
      };
    },
    async getScreenSize() {
      return screen;
    },
    async forceStopPackage(packageName) {
      calls.push(['force_stop', packageName]);
      state = 'stopped';
    },
    async launchPackage(packageName) {
      calls.push(['launch', packageName]);
      state = 'ad';
    },
    async getCurrentFocus() {
      return {
        packageName: app.packageName,
        bundleName: app.harmonyBundleName,
        activity: 'EntryAbility',
      };
    },
    async getUiTextSnapshot() {
      return snapshotForState(state);
    },
    async tap(point) {
      calls.push(['tap', point.x, point.y]);
      if (state === 'ad') state = 'feed';
      else if (state === 'feed') state = 'home';
      else if (state === 'home') state = 'directory';
      else if (state === 'directory') state = 'room';
    },
    async swipe(value) {
      calls.push(['swipe', value.x1, value.y1, value.x2, value.y2]);
      state = 'switched';
    },
    async screenshotPng() {
      screenshotIndex += 1;
      return Buffer.alloc(4096, screenshotIndex);
    },
  };

  const result = await executeKuaishouLiveBrowse({
    device,
    app,
    parameters: {
      duration: { amount: 5, unit: '秒' },
    },
    validationDurationMs: 5000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });

  assert.equal(result.validationMode, KUAISHOU_LIVE_VALIDATION_MODE);
  assert.equal(result.effectiveDurationMs, 5000);
  assert.equal(result.effectiveSwitchIntervalMs, null);
  assert.equal(result.switchCount, 1);
  assert.equal(result.validationChecks.length, 8);
  assert.equal(
    result.validationChecks.every((check) => check.status === 'passed'),
    true,
  );
  assert.equal(state, 'switched');
  assert.deepEqual(calls.slice(0, 2), [
    ['force_stop', app.packageName],
    ['launch', app.packageName],
  ]);
  assert.ok(calls.some((call) => call[0] === 'swipe'));
  assert.equal(result.correctedSteps.length > 0, true);
});

test('short Kuaishou live task avoids screenshots while observing duration', async () => {
  let state = 'feed';
  let clock = 0;
  let screenshotCount = 0;
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-kuaishou',
        screen,
      };
    },
    async getScreenSize() {
      return screen;
    },
    async forceStopPackage() {
      state = 'stopped';
    },
    async launchPackage() {
      state = 'feed';
    },
    async getCurrentFocus() {
      return {
        packageName: app.packageName,
        bundleName: app.harmonyBundleName,
        activity: 'EntryAbility',
      };
    },
    async getUiTextSnapshot() {
      return snapshotForState(state);
    },
    async tap() {
      if (state === 'feed') state = 'home';
      else if (state === 'home') state = 'directory';
      else if (state === 'directory') state = 'room';
    },
    async swipe() {
      throw new Error('short task should not switch live rooms');
    },
    async screenshotPng() {
      screenshotCount += 1;
      return Buffer.alloc(4096, screenshotCount);
    },
  };

  const result = await executeKuaishouLiveBrowse({
    device,
    app,
    durationMs: 5000,
    parameters: {
      duration: { amount: 30, unit: '分钟' },
      switchInterval: { amount: 5, unit: '秒' },
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    random: () => 0,
  });

  assert.equal(result.effectiveDurationMs, 5000);
  assert.equal(result.effectiveSwitchIntervalMs, 5000);
  assert.equal(result.switchCount, 0);
  assert.equal(screenshotCount, 2);
  assert.equal(
    result.validationChecks.find((check) => check.id === 'duration_observed')?.detail,
    '5000ms，切换直播 0 次，状态检查 1 次',
  );
});

function snapshotForState(state) {
  if (state === 'ad') {
    return snapshot(['广告', '跳过 3'], [
      node('跳过 3', '[1030,80][1210,180]'),
    ]);
  }
  if (state === 'feed') {
    return snapshot(['首页', '精选', '消息', '我']);
  }
  if (state === 'home') {
    return snapshot(
      ['关注', '发现', '同城', '直播', '探索', '首页', '精选', '消息', '我'],
      [node('直播', '[720,150][880,300]')],
    );
  }
  if (state === 'directory') {
    return snapshot([
      '关注',
      '发现',
      '同城',
      '直播',
      '探索',
      '直播中',
      '首页',
      '精选',
      '消息',
      '我',
    ]);
  }
  if (state === 'room') {
    return snapshot(['关注', '游戏频道', '说点什么...']);
  }
  if (state === 'switched') {
    return snapshot(['关注', '精选频道', '点歌', '濮阳第23名', '说点什么...']);
  }
  return snapshot([]);
}

function snapshot(values, children = []) {
  return {
    text: values.join('\n'),
    values,
    layout: {
      attributes: { bounds: '[0,0][1280,2832]' },
      children,
    },
  };
}

function node(text, bounds) {
  return {
    attributes: {
      text,
      originalText: text,
      bounds,
      clickable: 'true',
      type: 'Text',
    },
    children: [],
  };
}
