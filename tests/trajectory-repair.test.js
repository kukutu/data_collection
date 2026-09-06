import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTrajectoryRepairPrompt,
  parseTrajectoryRepairJson,
  repairTrajectoryWithModel,
  validateRepairedSteps,
} from '../server/src/skills/trajectory-repair.js';

test('builds a trajectory-only repair prompt', () => {
  const prompt = buildTrajectoryRepairPrompt({
    appName: '抖音',
    featureName: '短视频',
    screen: { width: 1256, height: 2760 },
    steps: [{ type: 'tap', x: 100, y: 200, delayMs: 0 }],
  });

  assert.match(prompt, /不能访问设备/);
  assert.match(prompt, /"type":"tap"/);
  assert.doesNotMatch(prompt, /apiKey/);
});

test('calls the Responses API and validates the corrected trajectory', async () => {
  const calls = [];
  const result = await repairTrajectoryWithModel({
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    trajectory: {
      appName: '抖音',
      featureName: '短视频',
      screen: { width: 1000, height: 2000 },
      steps: [{ type: 'tap', x: 100, y: 200, delayMs: 0 }],
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            output_text: JSON.stringify({
              steps: [{ type: 'tap', x: 101, y: 201, delayMs: 30 }],
              changes: ['删除一次误触'],
              confidence: 0.8,
            }),
          };
        },
      };
    },
  });

  assert.equal(calls[0].url, 'https://example.test/v1/responses');
  assert.equal(JSON.parse(calls[0].options.body).store, false);
  assert.deepEqual(result, {
    steps: [{ type: 'tap', x: 101, y: 201, delayMs: 30 }],
    changes: ['删除一次误触'],
    confidence: 0.8,
  });
});

test('rejects model actions outside the replay allowlist', () => {
  assert.throws(
    () => validateRepairedSteps([{ type: 'shell', command: 'hdc shell rm -rf /' }]),
    /不支持的动作类型/,
  );
  assert.deepEqual(
    parseTrajectoryRepairJson('```json\n{"steps":[]}\n```'),
    { steps: [] },
  );
});

test('preserves long presses returned by the repair model', () => {
  assert.deepEqual(
    validateRepairedSteps([
      {
        type: 'long_press',
        x: 937,
        y: 1818,
        durationMs: 800,
        delayMs: 250,
      },
    ]),
    [
      {
        type: 'long_press',
        x: 937,
        y: 1818,
        durationMs: 800,
        delayMs: 250,
      },
    ],
  );
});
