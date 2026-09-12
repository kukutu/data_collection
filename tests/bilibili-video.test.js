import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShortVideoPlan } from '../server/src/skills/short-video.js';
import { applyWorkflowParameters } from '../server/src/harness.js';
import { parseTaskFallback } from '../server/src/task-parser.js';
import { getWorkflowDefinition } from '../server/src/workflow-registry.js';

test('real-device-verified Bilibili video shortcut is enabled', () => {
  assert.equal(getWorkflowDefinition('short-video:bilibili:short-video-feed').status, 'verified');
});

const app = { id: 'bilibili', name: 'B站', aliases: ['B站'], packageName: 'tv.danmaku.bili' };

test('Bilibili waits for manual video entry and checks playback before capture', () => {
  const plan = buildShortVideoPlan({ app, durationMs: 20000 });
  assert.deepEqual(plan.slice(0, 4).map(s => s.type), [
    'manual_confirm', 'assert_foreground_package', 'assert_screen_changes', 'start_capture',
  ]);
  assert.equal(plan[0].confirmLabel, '我已进入视频，继续');
  assert.equal(plan.some(s => ['launch_app', 'force_stop', 'tap'].includes(s.type)), false);
  assert.ok(plan.findIndex(s => s.type === 'swipe') > 3);
});

test('Bilibili swipes scale with screen and check foreground before each gesture', () => {
  for (const screen of [{ width: 1280, height: 2832 }, { width: 720, height: 1600 }]) {
    const plan = buildShortVideoPlan({ app, durationMs: 20000, screen });
    for (const [i, step] of plan.entries()) {
      if (step.type !== 'swipe') continue;
      assert.equal(plan[i - 1].type, 'assert_foreground_package');
      assert.equal(step.x1, Math.round(screen.width * 0.5));
      assert.equal(step.y1, Math.round(screen.height * 0.79));
      assert.equal(step.y2, Math.round(screen.height * 0.2));
      assert.deepEqual(step.referenceScreen, screen);
    }
  }
});

test('Bilibili shortcut overrides long-video parsing without changing live routing', () => {
  const parsed = applyWorkflowParameters({ intent: 'play_generic_media' }, {
    workflowId: 'short-video:bilibili:short-video-feed',
    parameters: { duration: { amount: 20, unit: '秒' } },
  });
  assert.equal(parsed.intent, 'watch_feed');
  assert.equal(parsed.durationMs, 20000);
  assert.equal(parseTaskFallback('刷B站20秒', [app]).intent, 'watch_feed');
  assert.equal(parseTaskFallback('看B站直播20秒', [app]).intent, 'live_entry');
  assert.equal(parseTaskFallback('观看B站长视频20秒', [app]).intent, 'play_generic_media');
});
