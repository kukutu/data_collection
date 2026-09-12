import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessEvidenceIntegrity,
  buildEvidenceManifest,
  buildSemanticTrajectory,
  enrichRecordedSteps,
  executeStateStep,
  inspectExpectedState,
  resolveSemanticDurationMs,
} from '../server/src/recording-semantics.js';
import { createDeviceProfile } from '../server/src/device-profile.js';

test('enriches a recorded tap with a UI selector and safe-area coordinates', () => {
  const profile = createDeviceProfile({
    status: {
      provider: 'hdc',
      serial: 'harmony-1',
      screen: { width: 1000, height: 2000 },
    },
  });
  const steps = enrichRecordedSteps({
    profile,
    steps: [{ type: 'tap', x: 500, y: 400, delayMs: 0 }],
    contexts: [
      {
        actionIndex: 1,
        nativeLayoutSummary: [
          {
            id: 'call_button',
            text: '音视频通话',
            type: 'Button',
            bounds: { x1: 400, y1: 350, x2: 600, y2: 450 },
          },
        ],
      },
    ],
  });

  assert.equal(steps[0].normalizedX, 0.5);
  assert.equal(steps[0].normalizedY, 0.2);
  assert.equal(steps[0].target.id, 'call_button');
  assert.deepEqual(steps[0].target.texts, ['音视频通话']);
  assert.equal(steps[0].target.required, false);
});

test('converts long action delays and page transitions into semantic steps', () => {
  const contexts = [
    {
      phase: 'recording-start',
      focus: { bundleName: 'com.example.app', abilityName: 'MainAbility' },
      snapshot: { values: ['首页', '最近会话'] },
    },
    {
      actionIndex: 1,
      focus: { bundleName: 'com.example.app', abilityName: 'MainAbility' },
      snapshot: { values: ['聊天详情', '音视频通话'] },
    },
    {
      actionIndex: 2,
      focus: { bundleName: 'com.example.app', abilityName: 'CallAbility' },
      snapshot: { values: ['等待对方', '麦克风', '挂断'] },
    },
  ];
  const semantic = buildSemanticTrajectory({
    steps: [
      { type: 'tap', x: 100, y: 200, delayMs: 0 },
      { type: 'tap', x: 300, y: 400, delayMs: 5000 },
    ],
    contexts,
    parameterSchema: [
      { id: 'duration', type: 'duration' },
    ],
    workflowId: 'voip:example:audio',
    app: {
      packageName: 'com.example.app',
    },
  });

  assert.equal(semantic.filter((step) => step.type === 'tap').length, 2);
  assert.equal(
    semantic.some(
      (step) =>
        step.type === 'hold_state' &&
        step.durationParameter === 'duration',
    ),
    true,
  );
  assert.equal(
    semantic.filter((step) => step.type === 'assert_state').length,
    2,
  );
});

test('checks recorded state and resolves duration parameters', async () => {
  const device = {
    async getCurrentFocus() {
      return {
        bundleName: 'com.example.app',
        abilityName: 'CallAbility',
      };
    },
    async getUiTextSnapshot() {
      return {
        text: '等待对方\n麦克风\n挂断',
        layout: {
          attributes: {
            id: 'call_controls',
            bounds: '[0,0][1000,2000]',
          },
        },
      };
    },
  };
  const state = {
    packages: ['com.example.app'],
    activities: ['CallAbility'],
    textAny: ['等待对方'],
    nodeIds: ['call_controls'],
    strength: 4,
  };
  const inspected = await inspectExpectedState(device, state);
  const asserted = await executeStateStep(device, {
    type: 'assert_state',
    state,
    timeoutMs: 0,
  });

  assert.equal(inspected.passed, true);
  assert.equal(asserted.passed, true);
  assert.equal(
    resolveSemanticDurationMs(
      {
        type: 'hold_state',
        durationParameter: 'duration',
        durationMs: 1000,
      },
      { duration: { amount: 2, unit: '分钟' } },
    ),
    120000,
  );
});

test('reports missing per-action evidence as an incomplete recording', () => {
  const manifest = buildEvidenceManifest({
    steps: [
      { type: 'tap', x: 100, y: 200 },
      { type: 'tap', x: 300, y: 400 },
    ],
    contexts: [
      {
        actionIndex: 1,
        screenshotFile: 'action-001.png',
        nativeLayoutFile: 'action-layout-001.json',
      },
    ],
    provider: 'hdc',
    layoutCaptureSupported: true,
  });
  const integrity = assessEvidenceIntegrity({
    manifest,
    actionCount: 2,
    liveActionCount: 2,
  });

  assert.equal(integrity.status, 'incomplete');
  assert.match(integrity.issues.join('\n'), /动作上下文缺失/);
  assert.match(integrity.issues.join('\n'), /逐动作布局缺失/);
  assert.match(integrity.issues.join('\n'), /逐动作截图缺失/);
});

test('marks an empty evidence manifest as unusable', () => {
  const integrity = assessEvidenceIntegrity({
    manifest: [],
    actionCount: 0,
  });

  assert.equal(integrity.status, 'unusable');
  assert.match(integrity.issues.join('\n'), /没有可核验的动作证据/);
});
