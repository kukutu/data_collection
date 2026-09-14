import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  executeTaobaoLiveBrowse,
  extractTaobaoLiveRoomIdentity,
  findTaobaoCouponClaimPoint,
  isTaobaoLiveRoom,
  isTaobaoVideoPage,
  TAOBAO_LIVE_VALIDATION_MODE,
} from '../server/src/skills/taobao-live.js';

const screen = { width: 1280, height: 2832 };
const app = {
  id: 'taobao',
  name: '淘宝',
  packageName: 'com.taobao.taobao',
  harmonyBundleName: 'com.taobao.taobao4hmos',
};

function readLayout(name) {
  return {
    layout: JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8')),
  };
}

test('Taobao distinguishes the home, video page, and live room', () => {
  const home = readLayout('taobao-cold-home.json');
  const video = readLayout('taobao-video-page.json');
  const room = readLayout('taobao-live-feed.json');
  const switchedRoom = readLayout('taobao-live-switched-2.json');
  const roomWithoutAnnouncement = readLayout('taobao-live-failure-final.json');

  assert.equal(isTaobaoVideoPage(home), false);
  assert.equal(isTaobaoVideoPage(video), true);
  assert.equal(isTaobaoLiveRoom(video), false);
  assert.equal(isTaobaoLiveRoom(room), true);
  assert.equal(isTaobaoLiveRoom(roomWithoutAnnouncement), true);
  assert.equal(extractTaobaoLiveRoomIdentity(room), '天天热卖-严选好物');
  assert.equal(extractTaobaoLiveRoomIdentity(switchedRoom), '小青美食分享');
  assert.equal(
    extractTaobaoLiveRoomIdentity(roomWithoutAnnouncement),
    '周周燃脂紧致塑形',
  );
});

test('Taobao enters video from the bottom, selects live at the top, and verifies a full swipe', async () => {
  const snapshots = {
    home: readLayout('taobao-cold-home.json'),
    video: readLayout('taobao-video-page.json'),
    videoShifted: readLayout('taobao-live-entry-failure.json'),
    roomA: readLayout('taobao-live-feed.json'),
    roomB: readLayout('taobao-live-switched-2.json'),
  };
  snapshots.coupon = {
    layout: {
      attributes: { bounds: '[0,0][1280,2832]' },
      children: [
        snapshots.roomA.layout,
        {
          attributes: {
            type: 'Text',
            text: '直播间优惠券',
            originalText: '直播间优惠券',
            bounds: '[300,1200][980,1320]',
            clickable: 'false',
            zIndex: '20',
          },
          children: [],
        },
        {
          attributes: {
            type: 'Button',
            text: '立即领取',
            originalText: '立即领取',
            bounds: '[760,1600][1100,1740]',
            clickable: 'true',
            zIndex: '21',
          },
          children: [],
        },
      ],
    },
  };
  let state = 'stopped';
  let videoSnapshotReads = 0;
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
        serial: 'harmony-taobao',
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
        activity: 'Taobao_mainAbility',
      };
    },
    async getUiTextSnapshot() {
      if (state === 'video') {
        videoSnapshotReads += 1;
        return videoSnapshotReads === 1
          ? snapshots.video
          : snapshots.videoShifted;
      }
      return snapshots[state];
    },
    async tap(value) {
      calls.push(['tap', state, value.x, value.y]);
      if (state === 'home') state = 'video';
      else if (state === 'video') state = 'coupon';
      else if (state === 'coupon') state = 'roomA';
    },
    async swipe(value) {
      calls.push([
        'swipe',
        state,
        value.x1,
        value.y1,
        value.x2,
        value.y2,
        value.durationMs,
      ]);
      if (state === 'roomA') state = 'roomB';
    },
    async screenshotPng() {
      screenshotIndex += 1;
      return Buffer.alloc(4096, screenshotIndex);
    },
  };

  const result = await executeTaobaoLiveBrowse({
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
      videoPageMs: 0,
      liveRoomMs: 0,
      motionMs: 1,
      switchMs: 0,
      switchBufferMs: 0,
    },
  });

  assert.equal(result.validationMode, TAOBAO_LIVE_VALIDATION_MODE);
  assert.equal(result.switchCount, 1);
  assert.equal(result.couponClaimCount, 1);
  assert.equal(result.validationChecks.every((check) => check.status === 'passed'), true);
  assert.equal(captureStarted, true);
  assert.equal(state, 'roomB');

  const taps = calls.filter((call) => call[0] === 'tap');
  assert.deepEqual(taps[0], ['tap', 'home', 384, 2699]);
  assert.deepEqual(taps[1], ['tap', 'video', 619, 217]);
  assert.deepEqual(taps[2], ['tap', 'coupon', 930, 1670]);
  assert.deepEqual(
    findTaobaoCouponClaimPoint(snapshots.coupon, screen),
    { x: 930, y: 1670 },
  );

  const swipe = calls.find((call) => call[0] === 'swipe');
  assert.deepEqual(swipe, [
    'swipe',
    'roomA',
    Math.round(screen.width * 0.28),
    Math.round(screen.height * 0.81),
    Math.round(screen.width * 0.28),
    Math.round(screen.height * 0.15),
    620,
  ]);
});
