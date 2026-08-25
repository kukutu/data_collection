import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAmapNavigationPlan } from '../server/src/skills/amap-navigation.js';

test('builds a route deep-link and start-navigation tap', () => {
  const plan = buildAmapNavigationPlan({
    app: { name: '高德地图', packageName: 'com.autonavi.minimap' },
    destination: '北京站',
    durationMs: 10_000,
    screen: { width: 1260, height: 2800 },
  });

  assert.equal(plan[0].type, 'open_uri');
  assert.equal(plan[0].packageName, 'com.autonavi.minimap');
  assert.match(plan[0].uri, /androidamap:\/\/route/);
  assert.match(plan[0].uri, /%E5%8C%97%E4%BA%AC%E7%AB%99/);
  assert.ok(plan.some((step) => step.type === 'tap' && step.label.includes('开始导航')));
  assert.equal(plan.at(-1).type, 'complete');
});
