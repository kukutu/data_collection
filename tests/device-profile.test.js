import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotateStepCoordinates,
  createDeviceProfile,
  resolveProfiledPoint,
  selectDeviceProfile,
  upsertDeviceBaseline,
} from '../server/src/device-profile.js';

test('infers safe-area insets and maps recorded coordinates between devices', () => {
  const source = createDeviceProfile({
    status: {
      provider: 'hdc',
      serial: 'source',
      screen: { width: 1000, height: 2000 },
    },
    contexts: [
      {
        snapshot: {
          layout: {
            attributes: { bounds: '[0,50][1000,1950]' },
          },
        },
      },
    ],
  });
  const target = createDeviceProfile({
    status: {
      provider: 'hdc',
      serial: 'target',
      screen: { width: 1200, height: 2400 },
      safeArea: { left: 0, top: 100, right: 0, bottom: 100 },
    },
  });
  const step = annotateStepCoordinates(
    { type: 'tap', x: 500, y: 1000 },
    source,
  );
  const point = resolveProfiledPoint(step, source, target);

  assert.deepEqual(source.safeArea, {
    left: 0,
    top: 50,
    right: 0,
    bottom: 50,
  });
  assert.equal(step.normalizedX, 0.5);
  assert.equal(step.normalizedY, 0.5);
  assert.deepEqual(point, { x: 600, y: 1200 });
});

test('stores separate replay baselines and reuses a matching device profile', () => {
  const first = createDeviceProfile({
    status: {
      provider: 'hdc',
      serial: 'harmony-1',
      model: 'Mate',
      screen: { width: 1280, height: 2832 },
      safeArea: { top: 96, bottom: 72 },
    },
  });
  const second = createDeviceProfile({
    status: {
      provider: 'hdc',
      serial: 'harmony-2',
      model: 'Pura',
      screen: { width: 1256, height: 2760 },
    },
  });
  let baselines = upsertDeviceBaseline([], first, {
    passed: true,
    at: '2026-09-07T00:00:00.000Z',
  });
  baselines = upsertDeviceBaseline(baselines, second, {
    passed: false,
    at: '2026-09-07T00:01:00.000Z',
  });
  const selected = selectDeviceProfile(baselines, {
    ...first,
    safeArea: { left: 0, top: 0, right: 0, bottom: 0 },
  });

  assert.equal(baselines.length, 2);
  assert.equal(baselines[0].successfulReplays, 1);
  assert.equal(baselines[1].failedReplays, 1);
  assert.equal(selected.safeArea.top, 96);
});
