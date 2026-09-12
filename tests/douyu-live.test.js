import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DOUYU_LIVE_VALIDATION_MODE,
  executeDouyuLiveBrowse,
  findDouyuLiveCardPoints,
  isDouyuLiveHome,
  isDouyuLiveRoom,
  isDouyuLiveUnavailable,
} from '../server/src/skills/douyu-live.js';

const screen = { width: 1280, height: 2832 };
const app = {
  id: 'douyu',
  name: '斗鱼',
  packageName: 'air.tv.douyu.android',
  harmonyBundleName: 'com.douyu.ho.app',
};

function readLayout(name) {
  return {
    layout: JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8')),
  };
}

test('Douyu home exposes standard live cards and excludes the top banner', () => {
  const home = readLayout('douyu-home-layout.json');
  const points = findDouyuLiveCardPoints(home, screen);

  assert.equal(isDouyuLiveHome(home), true);
  assert.equal(points.length, 4);
  assert.deepEqual(points[0], { x: 330, y: 1320 });
  assert.deepEqual(points[1], { x: 951, y: 1320 });
  assert.equal(points.some((point) => point.y < 1100), false);
});

test('Douyu room requires player, chat tab and interaction evidence', () => {
  const room = readLayout('douyu-room-layout.json');
  const unavailable = {
    values: ['主播不在家', '聊天', '来撩主播吧...'],
    layout: room.layout,
  };

  assert.equal(isDouyuLiveHome(room), false);
  assert.equal(isDouyuLiveRoom(room), true);
  assert.equal(isDouyuLiveUnavailable(unavailable), true);
  assert.equal(isDouyuLiveRoom(unavailable), false);
});

test('Douyu opens the first standard card and returns home before switching', async () => {
  let state = 'home';
  let clock = 0;
  let screenshotIndex = 0;
  const calls = [];
  const home = readLayout('douyu-home-layout.json');
  const room = readLayout('douyu-room-layout.json');
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-douyu',
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
      state = 'home';
    },
    async getCurrentFocus() {
      return {
        packageName: app.packageName,
        bundleName: app.harmonyBundleName,
        activity: 'EntryAbility',
      };
    },
    async getUiTextSnapshot() {
      return state === 'room' ? room : home;
    },
    async tap(value) {
      calls.push(['tap', state, value.x, value.y]);
      if (state === 'home') state = 'room';
    },
    async keyevent(code) {
      calls.push(['keyevent', state, code]);
      assert.equal(state, 'room');
      state = 'home';
    },
    async swipe(value) {
      calls.push(['swipe', state, value.x1, value.y1, value.x2, value.y2]);
      assert.equal(state, 'home');
    },
    async screenshotPng() {
      screenshotIndex += 1;
      return Buffer.alloc(4096, screenshotIndex);
    },
  };

  const result = await executeDouyuLiveBrowse({
    device,
    app,
    durationMs: 5000,
    switchIntervalMs: 2000,
    startCapture: async () => {
      calls.push(['capture', state]);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timings: {
      startupMs: 0,
      roomMs: 0,
      recoveryMs: 0,
      listSwipeMs: 0,
      motionMs: 1,
      switchBufferMs: 0,
    },
  });

  assert.equal(result.validationMode, DOUYU_LIVE_VALIDATION_MODE);
  assert.equal(result.effectiveDurationMs, 5000);
  assert.equal(result.effectiveSwitchIntervalMs, 2000);
  assert.equal(result.switchCount, 1);
  assert.equal(result.validationChecks.every((check) => check.status === 'passed'), true);
  assert.deepEqual(
    calls.find((call) => call[0] === 'tap'),
    ['tap', 'home', 330, 1320],
  );
  assert.deepEqual(
    calls.find((call) => call[0] === 'capture'),
    ['capture', 'room'],
  );
  assert.ok(
    calls.findIndex((call) => call[0] === 'capture') <
      calls.findIndex((call) => call[0] === 'keyevent'),
  );
  assert.equal(calls.filter((call) => call[0] === 'keyevent').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'swipe').length, 1);
  assert.equal(state, 'room');
});
