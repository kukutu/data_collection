import test from 'node:test';
import assert from 'node:assert/strict';
import { executeJdLiveBrowse, findJdLiveCardPoint, isJdLiveRoom, jdRoomId } from '../server/src/skills/jd-live.js';

test('JD distinguishes live rooms from product-explanation replays and directory cards', () => {
  const room = { values: ['京东直播 48147211', '聊天框', '观看人次：2952观看'] };
  assert.equal(jdRoomId(room), '48147211');
  assert.equal(isJdLiveRoom(room), true);
  assert.equal(isJdLiveRoom({ values: [...room.values, '拖动进度'] }), false);
  assert.equal(isJdLiveRoom({ values: ['京东华为手机直播间', '看讲解', '2.3万观看'] }), false);
  assert.equal(isJdLiveRoom({ values: [...room.values, '直播已结束'] }), false);
});

test('JD closes a coupon and starts the full viewing timer only after live validation', async () => {
  let state = 'home', clock = 0, capturedAt, coupon = true, swipes = 0;
  const app = { id: 'jd', packageName: 'jd.test' };
  const room = id => ({ values: [`京东直播 ${id}`, '聊天框', '200观看', ...(coupon ? ['领取并使用'] : [])] });
  const device = {
    async getScreenSize() { return { width: 1280, height: 2832 }; },
    async getCurrentFocus() { return { packageName: app.packageName }; },
    async forceStopPackage() {},
    async launchPackage() { state = 'home'; },
    async getUiTextSnapshot() {
      if (state.startsWith('room')) return room(state === 'roomA' ? 1 : 2);
      if (state === 'video') return { layout: { attributes: { text: '直播', bounds: '[252,180][344,246]' } } };
      return state === 'channel'
        ? {
            values: ['看讲解'],
            layout: {
              attributes: { bounds: '[0,0][1280,2832]' },
              children: [{
                attributes: { clickable: 'true', bounds: '[26,1086][615,1872]' },
                children: [],
              }],
            },
          }
        : { values: [] };
    },
    async tap() { state = { home: 'video', video: 'channel', channel: 'roomA' }[state]; },
    async keyevent(code) { assert.equal(code, 'BACK'); coupon = false; },
    async screenshotPng() { return Buffer.from(String(clock)); },
    async swipe(p) {
      assert.equal(p.y1, Math.round(2832 * 0.6));
      swipes++;
      state = 'roomB';
    },
  };
  const result = await executeJdLiveBrowse({ device, app, durationMs: 10000, switchIntervalMs: 4000,
    sleep: async ms => { clock += ms; }, now: () => clock,
    startCapture: async () => { assert.equal(coupon, false); assert.equal(state, 'roomA'); capturedAt = clock; },
  });
  assert.equal(clock - capturedAt, 10000);
  assert.equal(swipes, 1);
  assert.equal(result.switchCount, 1);
});

test('JD waits for the delayed top live tab before entering the channel', async () => {
  let state = 'home';
  let clock = 0;
  let videoReads = 0;
  const app = { id: 'jd', packageName: 'jd.test' };
  const room = { values: ['京东直播 48147211', '聊天框', '200观看'] };
  const device = {
    async getScreenSize() { return { width: 1280, height: 2832 }; },
    async getCurrentFocus() { return { packageName: app.packageName }; },
    async forceStopPackage() {},
    async launchPackage() { state = 'home'; },
    async getUiTextSnapshot() {
      if (state === 'room') return room;
      if (state === 'video') {
        videoReads += 1;
        return videoReads < 3
          ? { values: ['推荐'] }
          : { layout: { attributes: { text: '直播', bounds: '[252,180][344,246]' } } };
      }
      if (state === 'channel') return {
        values: ['看讲解'],
        layout: {
          attributes: { bounds: '[0,0][1280,2832]' },
          children: [{
            attributes: { clickable: 'true', bounds: '[26,1086][615,1872]' },
            children: [],
          }],
        },
      };
      return { values: [] };
    },
    async tap() { state = { home: 'video', video: 'channel', channel: 'room' }[state]; },
    async keyevent() {},
    async screenshotPng() { return Buffer.from(String(clock)); },
    async swipe() {},
  };
  const result = await executeJdLiveBrowse({
    device,
    app,
    durationMs: 1000,
    switchIntervalMs: 1000,
    sleep: async ms => { clock += ms; },
    now: () => clock,
  });
  assert.equal(result.validationMode, 'jd_live_browse_v1');
  assert.equal(state, 'room');
  assert.ok(videoReads >= 3);
});

test('JD derives the first live card point from the current two-column layout', () => {
  assert.deepEqual(
    findJdLiveCardPoint({
      layout: {
        attributes: { bounds: '[0,0][1256,2760]' },
        children: [{
          attributes: { clickable: 'true', bounds: '[26,1086][615,1872]' },
          children: [],
        }],
      },
    }, { width: 1256, height: 2760 }),
    { x: 321, y: 1322 },
  );
});
