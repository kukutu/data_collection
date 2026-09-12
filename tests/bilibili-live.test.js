import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BILIBILI_LIVE_VALIDATION_MODE,
  executeBilibiliLiveBrowse,
  findBilibiliLiveCardPoints,
  isBilibiliLiveDirectory,
  isBilibiliLiveRoom,
  isBilibiliLiveUnavailable,
} from '../server/src/skills/bilibili-live.js';

const screen = { width: 1280, height: 2832 };
const app = {
  id: 'bilibili',
  name: 'B站',
  packageName: 'tv.danmaku.bili',
  harmonyBundleName: 'yylx.danmaku.bili',
};

function readLayout(name) {
  return {
    layout: JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8')),
  };
}

test('Bilibili live directory is distinct from the recorded-video home feed', () => {
  const home = readLayout('bilibili-home-layout.json');
  const directory = readLayout('bilibili-live-channel-layout.json');

  assert.equal(isBilibiliLiveDirectory(home), false);
  assert.equal(isBilibiliLiveDirectory(directory), true);
});

test('Bilibili live room requires interaction controls and rejects unavailable rooms', () => {
  const room = readLayout('bilibili-live-room-layout.json');
  const unavailable = {
    values: ['未开播', '关注', '发个弹幕呗~'],
  };

  assert.equal(isBilibiliLiveRoom(room), true);
  assert.equal(isBilibiliLiveUnavailable(unavailable), true);
  assert.equal(isBilibiliLiveRoom(unavailable), false);
});

test('Bilibili live cards are derived from clickable card bounds', () => {
  const directory = readLayout('bilibili-live-channel-layout.json');
  const points = findBilibiliLiveCardPoints(directory, screen);

  assert.ok(points.length >= 4);
  assert.deepEqual(points[0], { x: 324, y: 579 });
  assert.deepEqual(points[1], { x: 956, y: 579 });
  assert.ok(points.every((point) => point.x > 0 && point.x < screen.width));
  assert.ok(points.every((point) => point.y > screen.height * 0.15));
});

test('Bilibili switches rooms by returning to the directory before swiping', async () => {
  let state = 'home';
  let clock = 0;
  let screenshotIndex = 0;
  const calls = [];
  const directory = readLayout('bilibili-live-channel-layout.json');
  const room = readLayout('bilibili-live-room-layout.json');
  const home = readLayout('bilibili-home-layout.json');
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-bilibili',
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
      if (state === 'directory') return directory;
      if (state === 'room') return room;
      return home;
    },
    async tap(value) {
      calls.push(['tap', state, value.x, value.y]);
      if (state === 'home') state = 'directory';
      else if (state === 'directory') state = 'room';
    },
    async keyevent(code) {
      calls.push(['keyevent', state, code]);
      assert.equal(state, 'room');
      state = 'directory';
    },
    async swipe(value) {
      calls.push(['swipe', state, value.x1, value.y1, value.x2, value.y2]);
      assert.equal(state, 'directory');
    },
    async screenshotPng() {
      screenshotIndex += 1;
      return Buffer.alloc(4096, screenshotIndex);
    },
  };

  const result = await executeBilibiliLiveBrowse({
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
      channelMs: 0,
      roomMs: 0,
      recoveryMs: 0,
      listSwipeMs: 0,
      motionMs: 1,
      switchBufferMs: 0,
    },
  });

  assert.equal(result.validationMode, BILIBILI_LIVE_VALIDATION_MODE);
  assert.equal(result.effectiveDurationMs, 5000);
  assert.equal(result.effectiveSwitchIntervalMs, 2000);
  assert.equal(result.switchCount, 1);
  assert.equal(result.validationChecks.every((check) => check.status === 'passed'), true);
  assert.equal(calls.filter((call) => call[0] === 'keyevent').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'swipe').length, 1);
  assert.equal(state, 'room');
});
