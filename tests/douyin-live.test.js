import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDouyinLiveManualPlan,
  DOUYIN_LIVE_WORKFLOW_ID,
} from '../server/src/skills/douyin-live.js';
import { buildLiveEntryPlan } from '../server/src/skills/live-entry.js';

const app = {
  id: 'douyin',
  name: '抖音',
  packageName: 'com.ss.android.ugc.aweme',
  harmonyBundleName: 'com.ss.hm.ugc.aweme',
};
const screen = { width: 1280, height: 2832 };

test('Douyin live waits for manual room entry and validates before capture', () => {
  const plan = buildDouyinLiveManualPlan({
    app,
    durationMs: 20_000,
    switchIntervalMs: 5_000,
    screen,
  });

  assert.equal(DOUYIN_LIVE_WORKFLOW_ID, 'live:douyin:live-browse');
  assert.equal(plan[0].type, 'manual_confirm');
  assert.equal(plan[0].confirmLabel, '我已进入直播，继续');
  assert.equal(plan.some((step) => step.type === 'launch_app'), false);
  assert.equal(plan.some((step) => step.type === 'force_stop'), false);

  const foregroundIndex = plan.findIndex(
    (step) => step.type === 'assert_foreground_package',
  );
  const roomIndex = plan.findIndex(
    (step) => step.type === 'assert_ui_text_or_activity',
  );
  const motionIndex = plan.findIndex(
    (step) => step.type === 'assert_screen_changes',
  );
  const captureIndex = plan.findIndex((step) => step.type === 'start_capture');
  const firstSwipeIndex = plan.findIndex((step) => step.type === 'swipe');

  assert.ok(foregroundIndex > 0);
  assert.ok(roomIndex > foregroundIndex);
  assert.ok(motionIndex > roomIndex);
  assert.ok(captureIndex > motionIndex);
  assert.ok(firstSwipeIndex > captureIndex);
});

test('Douyin live uses configured timing and resolution-scaled swipes', () => {
  const plan = buildDouyinLiveManualPlan({
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
    label: '按设置间隔下滑切换抖音直播 1',
  });
});

test('shared live entry builder delegates Douyin to manual takeover', () => {
  const plan = buildLiveEntryPlan({
    app,
    durationMs: 10_000,
    switchIntervalMs: 5_000,
    screen,
  });

  assert.equal(plan[0].type, 'manual_confirm');
  assert.equal(plan.some((step) => step.type === 'launch_app'), false);
  assert.ok(plan.some((step) => step.type === 'assert_ui_text_or_activity'));
});
