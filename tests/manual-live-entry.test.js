import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveEntryPlan } from '../server/src/skills/live-entry.js';
import { parseTaskFallback } from '../server/src/task-parser.js';

const apps = [
  { id: 'migu-video', name: '咪咕视频', packageName: 'com.cmcc.cmvideo' },
  { id: 'tencent-sports', name: '腾讯体育', packageName: 'com.tencent.qqsports' },
];

for (const app of apps) {
  test(`${app.name} uses manual room takeover without switching`, () => {
    const plan = buildLiveEntryPlan({ app, durationMs: 5_000 });
    assert.equal(plan[0].type, 'manual_confirm');
    assert.equal(plan[0].confirmLabel, '我已进入直播，继续');
    assert.equal(plan.some(step => step.type === 'swipe'), false);
    assert.equal(plan.filter(step => step.type === 'start_capture').length, 1);
    assert.deepEqual(plan.filter(step => step.type === 'wait').map(step => step.ms), [5_000]);
  });

  test(`${app.name} live text parses as a supported live entry`, () => {
    const parsed = parseTaskFallback(`看30秒${app.name}直播`, apps);
    assert.equal(parsed.intent, 'live_entry');
    assert.equal(parsed.appName, app.name);
  });
}
