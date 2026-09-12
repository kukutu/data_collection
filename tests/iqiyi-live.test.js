import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  executeIqiyiLiveBrowse,
  extractIqiyiLiveRoomIdentity,
  findIqiyiLiveCardPoints,
  findIqiyiMoreLiveCardPoints,
  IQIYI_LIVE_VALIDATION_MODE,
  isIqiyiLiveDirectory,
  isIqiyiLiveRoom,
  isIqiyiMoreLivePanel,
} from '../server/src/skills/iqiyi-live.js';

const screen = { width: 1280, height: 2832 };
const app = {
  id: 'iqiyi',
  name: '爱奇艺',
  packageName: 'com.qiyi.video',
  harmonyBundleName: 'com.qiyi.video.hmy',
};

function readLayout(name) {
  return {
    layout: JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8')),
  };
}

test('iQiyi detects the live directory and its large live cards', () => {
  const home = readLayout('iqiyi-home.json');
  const directory = readLayout('iqiyi-live-home.json');
  const lowerDirectory = readLayout('iqiyi-live-lower.json');

  assert.equal(isIqiyiLiveDirectory(home), false);
  assert.equal(isIqiyiLiveDirectory(directory), true);
  assert.equal(isIqiyiLiveDirectory(lowerDirectory), true);
  assert.deepEqual(findIqiyiLiveCardPoints(directory, screen)[0], {
    x: 333,
    y: 1745,
  });
  assert.deepEqual(findIqiyiLiveCardPoints(lowerDirectory, screen)[0], {
    x: 333,
    y: 770,
  });
});

test('iQiyi distinguishes a room from the more-live panel', () => {
  const room = readLayout('iqiyi-live-room.json');
  const switchedRoom = readLayout('iqiyi-live-room-switched.json');
  const panel = readLayout('iqiyi-more-live.json');
  const panelCards = findIqiyiMoreLiveCardPoints(panel, screen);

  assert.equal(isIqiyiLiveRoom(room), true);
  assert.equal(isIqiyiLiveRoom(panel), true);
  assert.equal(isIqiyiMoreLivePanel(room), false);
  assert.equal(isIqiyiMoreLivePanel(panel), true);
  assert.equal(extractIqiyiLiveRoomIdentity(room), '四时良品旗舰店');
  assert.equal(extractIqiyiLiveRoomIdentity(switchedRoom), '醉倾玹甄选');
  assert.ok(panelCards.length >= 4);
  assert.equal(panelCards[0].values.includes('醉倾玹甄选'), true);
});

test('iQiyi tries a room swipe first and falls back to more-live when identity is unchanged', async () => {
  const snapshots = {
    home: readLayout('iqiyi-home.json'),
    directory: readLayout('iqiyi-live-home.json'),
    roomA: readLayout('iqiyi-live-room.json'),
    panel: readLayout('iqiyi-more-live.json'),
    roomB: readLayout('iqiyi-live-room-switched.json'),
  };
  let state = 'stopped';
  let clock = 0;
  let screenshotIndex = 0;
  let captureStarted = false;
  const calls = [];
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-iqiyi',
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
      return snapshots[state];
    },
    async tap(value) {
      calls.push(['tap', state, value.x, value.y]);
      if (state === 'home') state = 'directory';
      else if (state === 'directory') state = 'roomA';
      else if (state === 'roomA') state = 'panel';
      else if (state === 'panel') state = 'roomB';
    },
    async keyevent(code) {
      calls.push(['keyevent', state, code]);
    },
    async swipe(value) {
      calls.push(['swipe', state, value.x1, value.y1, value.x2, value.y2]);
    },
    async screenshotPng() {
      screenshotIndex += 1;
      return Buffer.alloc(4096, screenshotIndex);
    },
  };

  const result = await executeIqiyiLiveBrowse({
    device,
    app,
    durationMs: 5000,
    switchIntervalMs: 2000,
    startCapture: async () => {
      captureStarted = true;
    },
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
      switchSwipeMs: 0,
      moreLiveMs: 0,
      motionMs: 1,
      switchBufferMs: 0,
    },
  });

  assert.equal(result.validationMode, IQIYI_LIVE_VALIDATION_MODE);
  assert.equal(result.switchCount, 1);
  assert.deepEqual(result.browseResult.switchMethods, ['more_live']);
  assert.equal(result.browseResult.swipeSwitchCount, 0);
  assert.equal(result.browseResult.fallbackSwitchCount, 1);
  assert.equal(result.validationChecks.every((check) => check.status === 'passed'), true);
  assert.equal(captureStarted, true);
  assert.equal(state, 'roomB');
  assert.equal(
    calls.some(
      (call) =>
        call[0] === 'swipe' &&
        call[1] === 'roomA' &&
        call[2] === Math.round(screen.width * 0.45),
    ),
    true,
  );
  assert.equal(calls.some((call) => call[0] === 'tap' && call[1] === 'roomA'), true);
  assert.equal(calls.some((call) => call[0] === 'tap' && call[1] === 'panel'), true);
});
