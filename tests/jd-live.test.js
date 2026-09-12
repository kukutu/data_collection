import test from 'node:test';
import assert from 'node:assert/strict';
import { executeJdLiveBrowse, isJdLiveRoom, jdRoomId } from '../server/src/skills/jd-live.js';

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
      return { values: state === 'channel' ? ['看讲解'] : [] };
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
