import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  executeHuyaLiveBrowse,
  findHuyaLiveCardPoints,
  HUYA_LIVE_VALIDATION_MODE,
  isHuyaLiveHome,
  isHuyaLiveRoom,
  isHuyaLiveUnavailable,
} from '../server/src/skills/huya-live.js';

const screen = { width: 1280, height: 2832 };
const app = {
  id: 'huya',
  name: '虎牙',
  packageName: 'com.duowan.kiwi',
  harmonyBundleName: 'com.duowan.hyhos',
};

function readLayout(name) {
  return {
    layout: JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8')),
  };
}

test('Huya home exposes the first live card through dynamic bounds', () => {
  const home = readLayout('huya-home-layout.json');
  const points = findHuyaLiveCardPoints(home, screen);

  assert.equal(isHuyaLiveHome(home), true);
  assert.ok(points.length >= 6);
  assert.deepEqual(points[0], { x: 329, y: 648 });
  assert.deepEqual(points[1], { x: 952, y: 648 });
});

test('Huya room requires room controls and rejects unavailable rooms', () => {
  const room = readLayout('huya-room-layout.json');
  const unavailable = {
    values: ['主播不在家', '聊天', '聊聊天'],
    layout: room.layout,
  };

  assert.equal(isHuyaLiveHome(room), false);
  assert.equal(isHuyaLiveRoom(room), true);
  assert.equal(isHuyaLiveUnavailable(unavailable), true);
  assert.equal(isHuyaLiveRoom(unavailable), false);
});

test('Huya opens the first room and returns to the list before switching', async () => {
  let state = 'home';
  let clock = 0;
  let screenshotIndex = 0;
  const calls = [];
  const home = readLayout('huya-home-layout.json');
  const room = readLayout('huya-room-layout.json');
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-huya',
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

  const result = await executeHuyaLiveBrowse({
    device,
    app,
    durationMs: 5000,
    switchIntervalMs: 2000,
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

  assert.equal(result.validationMode, HUYA_LIVE_VALIDATION_MODE);
  assert.equal(result.effectiveDurationMs, 5000);
  assert.equal(result.effectiveSwitchIntervalMs, 2000);
  assert.equal(result.switchCount, 1);
  assert.equal(result.validationChecks.every((check) => check.status === 'passed'), true);
  assert.deepEqual(
    calls.find((call) => call[0] === 'tap'),
    ['tap', 'home', 329, 648],
  );
  assert.equal(calls.filter((call) => call[0] === 'keyevent').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'swipe').length, 1);
  assert.equal(state, 'room');
});
