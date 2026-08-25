import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTencentVideoPlaybackPlan } from '../server/src/skills/tencent-video.js';

test('builds a plan that hands Tencent Video playback entry to the user', () => {
  const plan = buildTencentVideoPlaybackPlan({
    app: { name: '腾讯视频', packageName: 'com.tencent.qqlive' },
    durationMs: 10_000,
    screen: { width: 1260, height: 2800 },
  });

  assert.equal(plan[0].type, 'keyevent');
  assert.equal(plan[1].type, 'tap_resource');
  assert.equal(plan[2].type, 'force_stop');
  assert.equal(plan[3].type, 'launch_app');
  assert.ok(plan.some((step) => step.type === 'manual_confirm'));
  assert.equal(plan.some((step) => step.type === 'tap'), false);
  assert.equal(plan.some((step) => step.type === 'tap_until_orientation'), false);
  assert.ok(plan.some((step) => step.type === 'assert_foreground_package'));
  assert.ok(plan.some((step) => step.type === 'assert_media_playing'));
  assert.equal(plan.some((step) => step.label?.includes('榜单第一条')), false);
  assert.equal(plan.at(-1).type, 'complete');
});

test('verifies fullscreen and playback after manual Tencent Video confirmation', () => {
  const plan = buildTencentVideoPlaybackPlan({
    app: { name: '腾讯视频', packageName: 'com.tencent.qqlive' },
    durationMs: 10_000,
    screen: { width: 1260, height: 2800 },
  });

  const manualConfirm = plan.find((step) => step.type === 'manual_confirm');
  const orientationAssert = plan.find((step) => step.type === 'assert_orientation' && step.landscape);
  const foregroundAssert = plan.find((step) => step.type === 'assert_foreground_package');
  const mediaAssert = plan.find((step) => step.type === 'assert_media_playing');
  const manualConfirmIndex = plan.findIndex((step) => step === manualConfirm);

  assert.ok(manualConfirm, 'Tencent Video should wait for manual playback entry');
  assert.ok(orientationAssert, 'Tencent Video should verify landscape fullscreen');
  assert.ok(foregroundAssert, 'Tencent Video should verify it is still foreground');
  assert.ok(mediaAssert, 'Tencent Video should verify media playback');
  assert.ok(plan.findIndex((step) => step === orientationAssert) > manualConfirmIndex);
  assert.ok(plan.findIndex((step) => step === foregroundAssert) > manualConfirmIndex);
  assert.ok(plan.findIndex((step) => step === mediaAssert) > manualConfirmIndex);
});

test('keeps long Tencent Video playback waits silent', () => {
  const plan = buildTencentVideoPlaybackPlan({
    app: { name: '腾讯视频', packageName: 'com.tencent.qqlive' },
    durationMs: 90_000,
    screen: { width: 1260, height: 2800 },
  });

  assert.ok(plan.some((step) => step.type === 'wait' && step.silent));
  assert.equal(plan.some((step) => step.label?.includes('保持播放')), false);
});
