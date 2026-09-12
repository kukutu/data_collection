import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWeiboLiveManualPlan,
  WEIBO_LIVE_WORKFLOW_ID,
} from '../server/src/skills/weibo-live.js';

const app = {
  id: 'weibo',
  name: '微博',
  packageName: 'com.sina.weibo',
  harmonyBundleName: 'com.sina.weibo.stage',
};
const screen = { width: 1280, height: 2832 };

test('Weibo live waits for manual room entry and validates before capture', () => {
  const plan = buildWeiboLiveManualPlan({
    app,
    durationMs: 20_000,
    switchIntervalMs: 5_000,
    screen,
  });

  assert.equal(WEIBO_LIVE_WORKFLOW_ID, 'live:weibo:live-browse');
  assert.equal(plan[0].type, 'manual_confirm');
  assert.equal(plan[0].confirmLabel, '我已进入直播，继续');
  assert.equal(plan.some((step) => step.type === 'launch_app'), false);
  assert.equal(plan.some((step) => step.type === 'force_stop'), false);

  const foregroundIndex = plan.findIndex(
    (step) => step.type === 'assert_foreground_package',
  );
  const motionIndex = plan.findIndex(
    (step) => step.type === 'assert_screen_changes',
  );
  const captureIndex = plan.findIndex((step) => step.type === 'start_capture');
  const firstSwipeIndex = plan.findIndex((step) => step.type === 'swipe');

  assert.ok(foregroundIndex > 0);
  assert.ok(motionIndex > foregroundIndex);
  assert.ok(captureIndex > motionIndex);
  assert.ok(firstSwipeIndex > captureIndex);
});

test('Weibo live uses the configured interval and resolution-scaled swipes', () => {
  const plan = buildWeiboLiveManualPlan({
    app,
    durationMs: 20_000,
    switchIntervalMs: 5_000,
    screen,
  });
  const waits = plan.filter((step) => step.type === 'wait');
  const swipes = plan.filter((step) => step.type === 'swipe');

  assert.deepEqual(
    waits.map((step) => step.ms),
    [5_000, 5_000, 5_000, 5_000],
  );
  assert.equal(swipes.length, 3);
  assert.deepEqual(swipes[0], {
    type: 'swipe',
    x1: 640,
    y1: 2237,
    x2: 640,
    y2: 566,
    durationMs: 420,
    referenceScreen: screen,
    label: '按设置间隔下滑切换微博直播 1',
  });
});
