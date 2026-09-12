import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  ActionRecorder,
  parseRecordedTrajectory,
  selectRecordedTrajectory,
} from '../server/src/action-recorder.js';
import {
  WECHAT_AUDIO_CALL_WORKFLOW_ID,
  WECHAT_VOIP_VALIDATION_MODE,
} from '../server/src/skills/wechat-voip.js';
import {
  KUAISHOU_LIVE_VALIDATION_MODE,
  KUAISHOU_LIVE_WORKFLOW_ID,
} from '../server/src/skills/kuaishou-live.js';
import { getWorkflowCatalog } from '../server/src/workflow-registry.js';

test('parses UI recorder actions into replayable trajectory steps', () => {
  const steps = parseRecordedTrajectory(
    [
      'click 100 200',
      'swipe 100 200 100 900 420',
      'keyEvent Back',
    ].join('\n'),
  );

  assert.deepEqual(steps, [
    { type: 'tap', x: 100, y: 200, delayMs: 0 },
    { type: 'swipe', x1: 100, y1: 200, x2: 100, y2: 900, durationMs: 420, delayMs: 0 },
    { type: 'keyevent', code: 'KEYCODE_BACK', delayMs: 0 },
  ]);
});

test('parses Harmony uiRecord JSON fields and nanosecond duration', () => {
  const steps = parseRecordedTrajectory(
    JSON.stringify({
      ABILITY: 'MainAbility',
      BUNDLE: 'com.example.app',
      EVENT_TYPE: 'pointer',
      OP_TYPE: 'swipe',
      duration: 33885000,
      fingerList: [
        {
          X_POSI: '47',
          Y_POSI: '301',
          X2_POSI: '47',
          Y2_POSI: '1200',
        },
      ],
    }),
  );

  assert.deepEqual(steps, [
    {
      type: 'swipe',
      x1: 47,
      y1: 301,
      x2: 47,
      y2: 1200,
      durationMs: 50,
      delayMs: 0,
      context: {
        bundleName: 'com.example.app',
        abilityName: 'MainAbility',
      },
    },
  ]);
});

test('preserves Harmony longClick actions as long presses', () => {
  const steps = parseRecordedTrajectory(
    JSON.stringify({
      OP_TYPE: 'longClick',
      duration: 800000000,
      fingerList: [{ X_POSI: '937', Y_POSI: '1818' }],
    }),
  );

  assert.deepEqual(steps, [
    {
      type: 'long_press',
      x: 937,
      y: 1818,
      durationMs: 800,
      delayMs: 0,
    },
  ]);
});

test('does not duplicate an action from a prefixed JSON recorder line', () => {
  const steps = parseRecordedTrajectory(
    `uiRecord: ${JSON.stringify({
      OP_TYPE: 'click',
      fingerList: [{ X_POSI: '100', Y_POSI: '200' }],
    })}`,
  );

  assert.deepEqual(steps, [{ type: 'tap', x: 100, y: 200, delayMs: 0 }]);
});

test('parses Android getevent touch sequences as taps and swipes', () => {
  const lines = [
    '[ 1.000] /dev/input/event2: EV_KEY BTN_TOUCH 00000001',
    '[ 1.010] /dev/input/event2: EV_ABS ABS_MT_POSITION_X 00000064',
    '[ 1.010] /dev/input/event2: EV_ABS ABS_MT_POSITION_Y 000000c8',
    '[ 1.020] /dev/input/event2: EV_SYN SYN_REPORT 00000000',
    '[ 1.100] /dev/input/event2: EV_KEY BTN_TOUCH 00000000',
  ];

  const steps = parseRecordedTrajectory('', {
    receivedLines: lines.map((line) => ({ line, at: 1000 })),
  });

  assert.deepEqual(steps, [{ type: 'tap', x: 100, y: 200, delayMs: 0 }]);
});

test('merges remote action metadata with live host timestamps', () => {
  const result = selectRecordedTrajectory({
    remoteOutput: [
      JSON.stringify({
        OP_TYPE: 'click',
        fingerList: [{ X_POSI: '100', Y_POSI: '200' }],
        BUNDLE: 'com.example.app',
      }),
      JSON.stringify({
        OP_TYPE: 'click',
        fingerList: [{ X_POSI: '300', Y_POSI: '400' }],
        BUNDLE: 'com.example.app',
      }),
    ].join('\n'),
    receivedLines: [
      { line: 'click 100 200', at: 1000 },
      { line: 'click 300 400', at: 2500 },
    ],
    recordingDurationMs: 2000,
  });

  assert.equal(result.source, 'remote+live-timestamps');
  assert.equal(result.quality, 'exact');
  assert.equal(result.steps[1].delayMs, 1500);
  assert.equal(result.steps[0].context.bundleName, 'com.example.app');
});

test('adds a stable fallback delay when Harmony returns no action timestamps', () => {
  const result = selectRecordedTrajectory({
    remoteOutput: 'click 100 200\nclick 300 400',
    recordingDurationMs: 5000,
  });

  assert.equal(result.quality, 'approximate');
  assert.deepEqual(
    result.steps.map((step) => step.delayMs),
    [0, 400],
  );
  assert.match(result.diagnostics[0], /未返回动作时间戳/);
});

test('merges incomplete remote and live streams without discarding unmatched actions', () => {
  const result = selectRecordedTrajectory({
    remoteOutput: [
      'click 100 200',
      'click 300 400',
      'click 500 600',
    ].join('\n'),
    receivedLines: [
      { line: 'click 100 200', at: 1000 },
      { line: 'click 500 600', at: 3000 },
    ],
    recordingDurationMs: 3000,
    screen: { width: 1000, height: 2000 },
  });

  assert.equal(result.source, 'remote+live-merged');
  assert.equal(result.remoteStepCount, 3);
  assert.equal(result.streamStepCount, 2);
  assert.equal(result.matchedStepCount, 2);
  assert.equal(result.mergedStepCount, 3);
  assert.deepEqual(
    result.steps.map((step) => [step.x, step.y]),
    [
      [100, 200],
      [300, 400],
      [500, 600],
    ],
  );
});

test('uses Harmony console action markers to restore remote action timing', () => {
  const result = selectRecordedTrajectory({
    remoteOutput: [
      'swipe 100 700 100 300 400',
      'swipe 100 700 100 300 400',
    ].join('\n'),
    receivedLines: [
      { line: 'fling , fingerNumber:1 ,', at: 1000 },
      {
        line: 'finger1:from Point(x:100, y:700) to Widget(id: , type: Text, text: item)',
        at: 1001,
      },
      { line: 'fling , fingerNumber:1 ,', at: 2500 },
    ],
    screen: { width: 1000, height: 2000 },
  });

  assert.equal(result.source, 'remote+live-timestamps');
  assert.equal(result.streamStepCount, 2);
  assert.equal(result.matchedStepCount, 2);
  assert.equal(result.quality, 'exact');
  assert.deepEqual(
    result.steps.map((step) => step.delayMs),
    [0, 1500],
  );
});

test('rejects uncontextualized status-bar corner coordinates', () => {
  const result = selectRecordedTrajectory({
    remoteOutput: 'click 14 4\nclick 60 80',
    screen: { width: 1000, height: 2000 },
  });

  assert.equal(result.mergedStepCount, 2);
  assert.equal(result.rejectedStepCount, 1);
  assert.deepEqual(result.steps, [{ type: 'tap', x: 60, y: 80, delayMs: 0 }]);
  assert.match(result.diagnostics[0], /status-bar corner/);
});

test('writes raw recorder logs and captures serialized context for each live action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-evidence-'));
  const child = new FakeChild();
  let activeDeviceCalls = 0;
  let maxActiveDeviceCalls = 0;
  const withDeviceCall = async (value) => {
    activeDeviceCalls += 1;
    maxActiveDeviceCalls = Math.max(maxActiveDeviceCalls, activeDeviceCalls);
    await new Promise((resolve) => setTimeout(resolve, 1));
    activeDeviceCalls -= 1;
    return value;
  };
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-1',
        screen: { width: 1000, height: 2000 },
      };
    },
    async startUiRecording() {
      return {
        process: child,
        provider: 'hdc',
        serial: 'harmony-1',
        mode: 'uitest-uiRecord',
      };
    },
    async readUiRecording() {
      return 'swipe 100 700 100 300 400\nswipe 300 700 300 400 300';
    },
    async getCurrentFocus() {
      return withDeviceCall({ bundleName: 'com.example.app', activity: 'MainAbility' });
    },
    async getUiTextSnapshot() {
      return withDeviceCall({
        text: 'screen',
        values: ['screen'],
        layout: { attributes: { bounds: '[0,0][1000,2000]' } },
      });
    },
    async screenshotPng() {
      return withDeviceCall(Buffer.from('png'));
    },
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps: [{ id: 'example', name: 'Example' }],
      recordingsRoot: root,
    });
    const started = await recorder.start({
      appId: 'example',
      featureName: 'Evidence',
    });
    child.stdout.write('fling , fingerNumber:1 ,\n');
    child.stdout.write(
      'finger1:from Point(x:100, y:700) to Widget(id: , type: Text, text: item)\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.stdout.write('fling , fingerNumber:1 ,\n');

    const stopped = await recorder.stop(started.id);
    const rawLive = await readFile(stopped.rawLiveFile, 'utf8');
    const rawRemote = await readFile(stopped.rawRemoteFile, 'utf8');
    const contexts = JSON.parse(await readFile(stopped.contextFile, 'utf8'));
    const evidence = JSON.parse(
      await readFile(stopped.evidenceManifestFile, 'utf8'),
    );

    assert.equal(stopped.actionContextCount, 2);
    assert.equal(stopped.contextCount, 4);
    assert.equal(stopped.remoteStepCount, 2);
    assert.equal(stopped.streamStepCount, 2);
    assert.equal(stopped.liveActionEventCount, 2);
    assert.equal(stopped.recordingQuality, 'good');
    assert.equal(stopped.integrityStatus, 'complete');
    assert.equal(evidence.integrityReport.status, 'complete');
    assert.equal(evidence.entries.length, 2);
    assert.equal(maxActiveDeviceCalls, 1);
    assert.match(rawLive, /"source":"stdout"/);
    assert.match(rawLive, /fling , fingerNumber:1/);
    assert.equal(
      rawRemote,
      'swipe 100 700 100 300 400\nswipe 300 700 300 400 300',
    );
    assert.deepEqual(
      contexts.contexts
        .filter((context) => Number.isInteger(context.actionIndex))
        .map((context) => context.actionIndex),
      [1, 2],
    );
    assert.deepEqual(
      contexts.contexts
        .filter((context) => Number.isInteger(context.stepIndex))
        .map((context) => context.evidenceId),
      ['step-001', 'step-002'],
    );
    assert.equal(
      contexts.contexts
        .filter((context) => Number.isInteger(context.stepIndex))
        .every((context) => Number.isFinite(context.captureLatencyMs)),
      true,
    );
    assert.deepEqual(
      contexts.contexts
        .filter((context) => Number.isInteger(context.actionIndex))
        .map((context) => ({
          type: context.action.type,
          x1: context.action.x1,
          y1: context.action.y1,
          x2: context.action.x2,
          y2: context.action.y2,
          durationMs: context.action.durationMs,
        })),
      [
        {
          type: 'swipe',
          x1: 100,
          y1: 700,
          x2: 100,
          y2: 300,
          durationMs: 400,
        },
        {
          type: 'swipe',
          x1: 300,
          y1: 700,
          x2: 300,
          y2: 400,
          durationMs: 300,
        },
      ],
    );
    await access(join(stopped.outputDir, 'action-001.png'));
    await access(join(stopped.outputDir, 'action-002.png'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('records a trajectory, writes a skill draft, and replays it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-'));
  const child = new FakeChild();
  const calls = [];
  const deviceLocks = [];
  let recordingOptions = null;
  const device = {
    async beginSession({ owner }) {
      const screen = owner.startsWith('replay:')
        ? { width: 1200, height: 2400 }
        : { width: 1000, height: 2000 };
      const lock = {
        id: `lock-${deviceLocks.length + 1}`,
        owner,
        connected: true,
        provider: 'hdc',
        serial: 'harmony-1',
        screen,
      };
      deviceLocks.push({ type: 'begin', lock });
      return lock;
    },
    async endSession(lock) {
      deviceLocks.push({ type: 'end', lock });
    },
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-1',
        screen: { width: 1000, height: 2000 },
      };
    },
    async startUiRecording(options) {
      recordingOptions = options;
      return { process: child, provider: 'hdc', serial: 'harmony-1', mode: 'uitest-uiRecord' };
    },
    async readUiRecording() {
      return 'click 100 200\nswipe 100 200 100 900 420';
    },
    async getScreenSize() {
      return { width: 1000, height: 2000 };
    },
    async getCurrentFocus() {
      return { bundleName: 'com.example.app', activity: 'MainAbility' };
    },
    async getUiTextSnapshot() {
      return {
        text: '短视频',
        values: ['短视频'],
        layout: { attributes: { text: '短视频', bounds: '[0,0][1000,2000]' } },
      };
    },
    async screenshotPng() {
      return Buffer.from('png');
    },
    async tap(step) {
      calls.push({ type: 'tap', ...step });
    },
    async swipe(step) {
      calls.push({ type: 'swipe', ...step });
    },
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps: [{ id: 'douyin', name: '抖音' }],
      recordingsRoot: root,
      trajectoryRepair: async () => ({
        steps: [{ type: 'tap', x: 120, y: 220, delayMs: 0 }],
        changes: ['修正点击坐标'],
        confidence: 0.9,
      }),
    });
    const started = await recorder.start({ appId: 'douyin', featureName: '短视频' });
    assert.equal(started.status, 'recording');
    assert.equal(recordingOptions.recordWidgetInfo, true);
    assert.equal(recordingOptions.saveLayout, true);

    const stopped = await recorder.stop(started.id);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.active, false);
    assert.equal(stopped.deviceLock, null);
    assert.deepEqual(
      deviceLocks.map((entry) => [entry.type, entry.lock.owner]),
      [
        ['begin', `recording:${started.id}`],
        ['end', `recording:${started.id}`],
      ],
    );
    assert.equal(stopped.stepCount, 2);
    assert.equal(stopped.contextCount, 2);
    assert.match(await readFile(stopped.trajectoryFile, 'utf8'), /"type": "swipe"/);
    assert.match(await readFile(stopped.skillFile, 'utf8'), /"source": "manual_recording"/);
    assert.match(await readFile(stopped.contextFile, 'utf8'), /recording-start/);

    const replayed = await recorder.replay(started.id, { source: 'raw' });
    assert.equal(replayed.status, 'replayed');
    assert.deepEqual(calls, [
      { type: 'tap', x: 120, y: 240 },
      { type: 'swipe', x1: 120, y1: 240, x2: 120, y2: 1080, durationMs: 420 },
    ]);
    assert.deepEqual(
      deviceLocks.slice(-2).map((entry) => [entry.type, entry.lock.owner]),
      [
        ['begin', `replay:${started.id}`],
        ['end', `replay:${started.id}`],
      ],
    );

    calls.length = 0;
    const repaired = await recorder.repair(started.id, { apiKey: 'test-key' });
    assert.equal(repaired.correctionStatus, 'completed');
    assert.equal(repaired.correctedStepCount, 1);
    assert.equal(repaired.correctedSemanticStepCount, 1);
    const correctedArtifact = await readFile(repaired.correctedSkillFile, 'utf8');
    assert.match(correctedArtifact, /"source": "model_repaired"/);
    assert.match(correctedArtifact, /"semanticSteps"/);

    const correctedReplay = await recorder.replay(started.id);
    assert.equal(correctedReplay.replaySource, 'corrected');
    assert.deepEqual(calls, [{ type: 'tap', x: 144, y: 264 }]);
    assert.deepEqual(
      deviceLocks.slice(-2).map((entry) => [entry.type, entry.lock.owner]),
      [
        ['begin', `replay:${started.id}`],
        ['end', `replay:${started.id}`],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parameterizes recorded text and keeps sensitive values out of snapshots and artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-params-'));
  const child = new FakeChild();
  const calls = [];
  const apps = [{ id: 'tencent-meeting', name: '腾讯会议' }];
  const workflows = getWorkflowCatalog(apps);
  const workflow = workflows.find((item) => item.id === 'meeting:tencent-meeting:join-meeting');
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-1',
        screen: { width: 1000, height: 2000 },
      };
    },
    async startUiRecording() {
      return { process: child, provider: 'hdc', serial: 'harmony-1', mode: 'uitest-uiRecord' };
    },
    async readUiRecording() {
      return [
        JSON.stringify({ type: 'input_text', text: '123456' }),
        JSON.stringify({ type: 'input_text', text: '123456 password' }),
      ].join('\n');
    },
    async getScreenSize() {
      return { width: 1000, height: 2000 };
    },
    async inputText(text) {
      calls.push(text);
    },
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps,
      workflows,
      recordingsRoot: root,
    });
    const started = await recorder.start({
      appId: 'tencent-meeting',
      workflowId: workflow.id,
      parameters: {
        meetingId: '123456',
        meetingPassword: 'password',
        camera: false,
        shareScreen: false,
      },
    });
    const stopped = await recorder.stop(started.id);

    assert.deepEqual(stopped.parameters, {
      meetingId: '123456',
      meetingPassword: '[已隐藏]',
      camera: false,
      shareScreen: false,
    });
    assert.deepEqual(stopped.steps, [
      { type: 'input_text', text: '{{meetingId}}', delayMs: 0 },
      { type: 'input_text', text: '{{meetingId}} {{meetingPassword}}', delayMs: 0 },
    ]);

    const trajectory = await readFile(stopped.trajectoryFile, 'utf8');
    const skill = await readFile(stopped.skillFile, 'utf8');
    const rawRemote = await readFile(stopped.rawRemoteFile, 'utf8');
    assert.doesNotMatch(trajectory, /password/);
    assert.doesNotMatch(skill, /password/);
    assert.doesNotMatch(rawRemote, /password/);

    const replayed = await recorder.replay(started.id);
    assert.equal(replayed.status, 'replayed');
    assert.deepEqual(calls, ['123456', '123456 password']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses media loop parameters but limits count-based replay validation to one send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-wechat-media-'));
  const child = new FakeChild();
  const apps = [{ id: 'wechat', name: '微信', packageName: 'com.tencent.mm' }];
  const workflows = getWorkflowCatalog(apps);
  const workflow = workflows.find(
    (item) => item.id === 'transfer:wechat:send-media',
  );
  const receivedParameters = [];
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-1',
        screen: { width: 1000, height: 2000 },
      };
    },
    async startUiRecording() {
      return {
        process: child,
        provider: 'hdc',
        serial: 'harmony-1',
        mode: 'uitest-uiRecord',
      };
    },
    async readUiRecording() {
      return 'click 100 200';
    },
    async getScreenSize() {
      return { width: 1000, height: 2000 };
    },
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps,
      workflows,
      recordingsRoot: root,
      wechatMediaExecutor: async ({ parameters }) => {
        receivedParameters.push(parameters);
        return {
          validationMode: 'wechat_media_send_v1',
          validationChecks: [
            {
              id: 'media_sent_1',
              label: '发送媒体',
              status: 'passed',
              detail: '1',
            },
          ],
          effectiveDurationMs:
            parameters.sendMode === 'duration' ? 5000 : null,
          replayStepIndex: 1,
          sentCount: 1,
        };
      },
    });
    const started = await recorder.start({
      appId: 'wechat',
      workflowId: workflow.id,
      parameters: {
        sendMode: 'count',
        count: 5,
        duration: { amount: 2, unit: '分钟' },
        interval: { amount: 8, unit: '秒' },
      },
    });
    await recorder.stop(started.id);
    const countReplay = await recorder.replay(started.id, {
      validationDurationMs: 5000,
    });
    await recorder.replay(started.id, {
      parameters: {
        sendMode: 'duration',
        duration: { amount: 2, unit: '分钟' },
      },
      validationDurationMs: 5000,
    });

    assert.equal(receivedParameters[0].sendMode, 'count');
    assert.equal(receivedParameters[0].count, 1);
    assert.deepEqual(receivedParameters[0].duration, {
      amount: 2,
      unit: '分钟',
    });
    assert.equal(countReplay.parameters.count, 5);
    assert.equal(receivedParameters[1].sendMode, 'duration');
    assert.deepEqual(receivedParameters[1].duration, {
      amount: 5,
      unit: '秒',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replaces unverified recordings but preserves a recording after successful replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-replace-'));
  const apps = [{ id: 'douyin', name: '抖音' }];
  const workflows = getWorkflowCatalog(apps);
  const workflow = workflows.find((item) => item.id === 'short-video:douyin:short-video-feed');
  const children = [];
  let activeDeviceLock = null;
  let deviceLockSequence = 0;
  const device = {
    async beginSession({ owner }) {
      if (activeDeviceLock) {
        throw new Error(`Device is already locked by ${activeDeviceLock.owner}`);
      }
      activeDeviceLock = {
        id: `lock-${++deviceLockSequence}`,
        owner,
        connected: true,
        provider: 'hdc',
        serial: 'harmony-1',
        screen: { width: 1000, height: 2000 },
      };
      return { ...activeDeviceLock };
    },
    getActiveSession() {
      return activeDeviceLock ? { ...activeDeviceLock } : null;
    },
    async endSession(lock) {
      if (!activeDeviceLock) return false;
      assert.equal(lock.id, activeDeviceLock.id);
      activeDeviceLock = null;
      return true;
    },
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-1',
        screen: { width: 1000, height: 2000 },
      };
    },
    async startUiRecording() {
      const child = new FakeChild();
      children.push(child);
      return { process: child, provider: 'hdc', serial: 'harmony-1', mode: 'uitest-uiRecord' };
    },
    async readUiRecording() {
      return 'click 100 200';
    },
    async getScreenSize() {
      return { width: 1000, height: 2000 };
    },
    async tap() {},
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps,
      workflows,
      recordingsRoot: root,
    });

    const first = await recorder.start({ appId: 'douyin', workflowId: workflow.id });
    const firstStopped = await recorder.stop(first.id);
    assert.equal(firstStopped.validationStatus, 'unverified');
    assert.equal(await pathExists(firstStopped.outputDir), true);
    recorder.activeId = first.id;
    activeDeviceLock = {
      id: 'orphan-lock',
      owner: `recording:${first.id}`,
      connected: true,
      provider: 'hdc',
      serial: 'harmony-1',
      screen: { width: 1000, height: 2000 },
    };

    const replacement = await recorder.start({ appId: 'douyin', workflowId: workflow.id });
    assert.equal(activeDeviceLock.owner, `recording:${replacement.id}`);
    assert.equal(await pathExists(firstStopped.outputDir), false);
    assert.equal(recorder.list().some((recording) => recording.id === first.id), false);
    await recorder.stop(replacement.id);

    const restartedRecorder = new ActionRecorder({
      device,
      apps,
      workflows,
      recordingsRoot: root,
    });
    const second = await restartedRecorder.start({ appId: 'douyin', workflowId: workflow.id });
    assert.equal(await pathExists(firstStopped.outputDir), false);
    const secondStopped = await restartedRecorder.stop(second.id);

    const verified = await restartedRecorder.replay(second.id);
    assert.equal(verified.validationStatus, 'verified');
    assert.equal(verified.status, 'replayed');
    assert.equal(await pathExists(secondStopped.outputDir), true);

    const third = await restartedRecorder.start({ appId: 'douyin', workflowId: workflow.id });
    assert.equal(await pathExists(secondStopped.outputDir), true);
    await restartedRecorder.stop(third.id);
    assert.equal(children.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replays an empty WeChat audio-call recording through the strict workflow skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-wechat-voip-'));
  const child = new FakeChild();
  const apps = [
    {
      id: 'wechat',
      name: '微信',
      packageName: 'com.tencent.mm',
      harmonyBundleName: 'com.tencent.wechat',
    },
  ];
  const workflows = getWorkflowCatalog(apps);
  let activeLock = null;
  let executorCall = null;
  const device = {
    async beginSession({ owner }) {
      activeLock = {
        id: `lock-${owner}`,
        owner,
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-1',
        screen: { width: 1280, height: 2832 },
      };
      return { ...activeLock };
    },
    async endSession() {
      activeLock = null;
    },
    getActiveSession() {
      return activeLock;
    },
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-1',
        screen: { width: 1280, height: 2832 },
      };
    },
    async getCurrentFocus() {
      return { bundleName: 'com.tencent.wechat', activity: 'EntryAbility' };
    },
    async getUiTextSnapshot() {
      return { text: '微信', values: ['微信'], layout: null };
    },
    async screenshotPng() {
      return Buffer.from('png');
    },
    async startUiRecording() {
      return { process: child, provider: 'hdc', serial: 'harmony-1' };
    },
    async readUiRecording() {
      return '';
    },
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps,
      workflows,
      recordingsRoot: root,
      wechatVoipExecutor: async (options) => {
        executorCall = options;
        return {
          validationMode: WECHAT_VOIP_VALIDATION_MODE,
          validationChecks: [
            {
              id: 'call_ended',
              label: '挂断语音通话',
              status: 'passed',
              detail: '已退出通话页',
            },
          ],
          effectiveDurationMs: 3000,
          replayStepIndex: 9,
          replaySource: WECHAT_VOIP_VALIDATION_MODE,
          correctedSteps: [{ type: 'tap', x: 640, y: 2445, delayMs: 0 }],
          correctionChanges: ['使用严格微信语音通话 skill'],
          correctionConfidence: 0.99,
        };
      },
    });

    const started = await recorder.start({
      appId: 'wechat',
      workflowId: WECHAT_AUDIO_CALL_WORKFLOW_ID,
      parameters: {
        duration: { amount: 30, unit: '秒' },
      },
    });
    const stopped = await recorder.stop(started.id);
    assert.equal(stopped.stepCount, 0);
    assert.equal(stopped.recordingQuality, 'unusable');
    assert.equal(stopped.replayAvailable, true);

    const replayed = await recorder.replay(started.id, {
      validationDurationMs: 5000,
    });
    assert.equal(replayed.status, 'replayed');
    assert.equal(replayed.validationStatus, 'verified');
    assert.equal(replayed.validationSource, 'workflow_skill');
    assert.equal(replayed.skillValidationStatus, 'verified');
    assert.equal(replayed.recordingQuality, 'unusable');
    assert.equal(replayed.validationMode, WECHAT_VOIP_VALIDATION_MODE);
    assert.equal(replayed.correctedStepCount, 1);
    assert.equal(executorCall.callType, 'audio');
    assert.equal(executorCall.workflowId, WECHAT_AUDIO_CALL_WORKFLOW_ID);
    assert.deepEqual(executorCall.parameters.duration, {
      amount: 5,
      unit: '秒',
    });
    assert.deepEqual(replayed.parameters.duration, {
      amount: 30,
      unit: '秒',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('replays Kuaishou live recordings through the strict workflow skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-kuaishou-live-'));
  const child = new FakeChild();
  const apps = [
    {
      id: 'kuaishou',
      name: '快手',
      packageName: 'com.smile.gifmaker',
      harmonyBundleName: 'com.kuaishou.hmapp',
    },
  ];
  const workflows = getWorkflowCatalog(apps);
  let activeLock = null;
  let executorCall = null;
  const device = {
    async beginSession({ owner }) {
      activeLock = {
        id: `lock-${owner}`,
        owner,
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-kuaishou',
        screen: { width: 1280, height: 2832 },
      };
      return { ...activeLock };
    },
    async endSession() {
      activeLock = null;
    },
    getActiveSession() {
      return activeLock;
    },
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-kuaishou',
        screen: { width: 1280, height: 2832 },
      };
    },
    async getCurrentFocus() {
      return { bundleName: 'com.kuaishou.hmapp', activity: 'EntryAbility' };
    },
    async getUiTextSnapshot() {
      return { text: '首页\n精选', values: ['首页', '精选'], layout: null };
    },
    async screenshotPng() {
      return Buffer.from('png');
    },
    async startUiRecording() {
      return { process: child, provider: 'hdc', serial: 'harmony-kuaishou' };
    },
    async readUiRecording() {
      return 'click 134 2671';
    },
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps,
      workflows,
      recordingsRoot: root,
      kuaishouLiveExecutor: async (options) => {
        executorCall = options;
        return {
          validationMode: KUAISHOU_LIVE_VALIDATION_MODE,
          validationChecks: [
            {
              id: 'final_live_state',
              label: '确认任务结束时仍在快手直播间',
              status: 'passed',
              detail: '直播间',
            },
          ],
          effectiveDurationMs: 5000,
          replayStepIndex: 8,
          replaySource: KUAISHOU_LIVE_VALIDATION_MODE,
          correctedSteps: [{ type: 'tap', x: 134, y: 2671, delayMs: 0 }],
          correctionChanges: ['使用严格快手直播 skill'],
          correctionConfidence: 0.99,
        };
      },
    });

    const started = await recorder.start({
      appId: 'kuaishou',
      workflowId: KUAISHOU_LIVE_WORKFLOW_ID,
      parameters: {
        duration: { amount: 30, unit: '秒' },
      },
    });
    await recorder.stop(started.id);
    const replayed = await recorder.replay(started.id, {
      validationDurationMs: 5000,
    });

    assert.equal(replayed.status, 'replayed');
    assert.equal(replayed.validationStatus, 'verified');
    assert.equal(replayed.validationSource, 'workflow_skill');
    assert.equal(replayed.skillValidationStatus, 'verified');
    assert.equal(replayed.validationMode, KUAISHOU_LIVE_VALIDATION_MODE);
    assert.equal(replayed.correctedStepCount, 1);
    assert.equal(executorCall.validationDurationMs, 5000);
    assert.deepEqual(executorCall.parameters.duration, {
      amount: 5,
      unit: '秒',
    });
    assert.deepEqual(replayed.parameters.duration, {
      amount: 30,
      unit: '秒',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retries a transient Harmony recorder connection conflict once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-retry-'));
  const children = [];
  let recoveryCount = 0;
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-1',
        screen: { width: 1000, height: 2000 },
      };
    },
    async startUiRecording() {
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => {
        child.stdout.write(
          children.length === 1
            ? 'Can not connect to AAMS, RET_ERR_CONNECTION_EXIST\n'
            : 'Started Recording Successfully...\n',
        );
      });
      return {
        process: child,
        provider: 'hdc',
        serial: 'harmony-1',
        mode: 'uitest-uiRecord',
        readyMessage: 'Started Recording Successfully',
      };
    },
    async recoverUiRecording() {
      recoveryCount += 1;
    },
    async readUiRecording() {
      return 'click 100 200';
    },
    async getCurrentFocus() {
      return { bundleName: 'com.example.app', activity: 'MainAbility' };
    },
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps: [{ id: 'example', name: 'Example' }],
      recordingsRoot: root,
    });
    const started = await recorder.start({
      appId: 'example',
      featureName: 'Retry',
    });
    const stopped = await recorder.stop(started.id);

    assert.equal(children.length, 2);
    assert.equal(recoveryCount, 1);
    assert.equal(stopped.stepCount, 1);
    assert.match(stopped.diagnostics.join('\n'), /已清理残留状态/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports a changed screen with no captured actions as an unusable recording', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-no-events-'));
  const child = new FakeChild();
  let snapshotCount = 0;
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-1',
        screen: { width: 1000, height: 2000 },
      };
    },
    async startUiRecording() {
      return { process: child, provider: 'hdc', serial: 'harmony-1' };
    },
    async readUiRecording() {
      return '';
    },
    async getCurrentFocus() {
      return { bundleName: 'com.example.app', activity: 'MainAbility' };
    },
    async getUiTextSnapshot() {
      snapshotCount += 1;
      return snapshotCount === 1
        ? { text: '首页\n最近会话', values: ['首页', '最近会话'], layout: null }
        : { text: '视频通话\n挂断', values: ['视频通话', '挂断'], layout: null };
    },
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps: [{ id: 'example', name: 'Example' }],
      recordingsRoot: root,
    });
    const started = await recorder.start({
      appId: 'example',
      featureName: 'No events',
    });
    const stopped = await recorder.stop(started.id);

    assert.equal(stopped.recordingQuality, 'unusable');
    assert.equal(stopped.qualityScore, 0);
    assert.equal(stopped.integrityStatus, 'unusable');
    assert.match(stopped.qualityIssues.join('\n'), /界面内容发生明显变化/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('records complete per-action HDC layout evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-layout-evidence-'));
  const child = new FakeChild();
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-layout',
        screen: { width: 1000, height: 2000 },
      };
    },
    async startUiRecording() {
      return {
        process: child,
        provider: 'hdc',
        serial: 'harmony-layout',
        readUiRecording: async () => 'click 500 1000',
        readUiRecordingLayouts: async (_output, { outputDir }) => [
          {
            actionIndex: 1,
            remoteFile: '/data/local/tmp/layout_action_1.json',
            localFile: join(outputDir, 'action-layout-001.json'),
            summary: [
              {
                id: 'open_button',
                text: '打开',
                type: 'Button',
                bounds: { x1: 400, y1: 900, x2: 600, y2: 1100 },
              },
            ],
          },
        ],
      };
    },
    async getCurrentFocus() {
      return { bundleName: 'com.example.app', activity: 'MainAbility' };
    },
    async getUiTextSnapshot() {
      return {
        text: '首页',
        values: ['首页'],
        layout: { attributes: { bounds: '[0,0][1000,2000]' } },
      };
    },
    async screenshotPng() {
      return Buffer.from('png');
    },
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps: [{ id: 'example', name: 'Example' }],
      recordingsRoot: root,
    });
    const started = await recorder.start({
      appId: 'example',
      featureName: 'Layout evidence',
    });
    child.stdout.write('click , fingerNumber:1 ,\n');
    child.stdout.write(
      'finger1:click at Point(x:500, y:1000) at Widget(id:open_button, text:打开, type:Button)\n',
    );
    const stopped = await recorder.stop(started.id);
    const evidence = JSON.parse(
      await readFile(stopped.evidenceManifestFile, 'utf8'),
    );

    assert.equal(stopped.recordedLayoutCount, 1);
    assert.equal(stopped.actionContextCount, 1);
    assert.equal(stopped.integrityStatus, 'complete');
    assert.equal(evidence.entries[0].nativeLayoutFile.endsWith('action-layout-001.json'), true);
    assert.equal(evidence.integrityReport.layoutCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('classifies late and orphan Harmony action details without duplicating actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-detail-timing-'));
  const child = new FakeChild();
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-timing',
        screen: { width: 1000, height: 2000 },
      };
    },
    async startUiRecording() {
      return {
        process: child,
        provider: 'hdc',
        serial: 'harmony-timing',
      };
    },
    async readUiRecording() {
      return 'click 100 200';
    },
    async getCurrentFocus() {
      return { bundleName: 'com.example.app', activity: 'MainAbility' };
    },
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps: [{ id: 'example', name: 'Example' }],
      recordingsRoot: root,
    });
    const started = await recorder.start({
      appId: 'example',
      featureName: 'Detail timing',
    });
    child.stdout.write('finger9:from Point(x:1, y:2) to Widget(id:orphan, text:none, type:Text)\n');
    child.stdout.write('click , fingerNumber:1 ,\n');
    await new Promise((resolve) => setTimeout(resolve, 380));
    child.stdout.write(
      'finger1:click at Point(x:100, y:200) at Widget(id:late, text:late, type:Button)\n',
    );
    const stopped = await recorder.stop(started.id);

    assert.equal(stopped.liveActionEventCount, 1);
    assert.equal(stopped.actionDetailTiming.headerOnlyCount, 1);
    assert.equal(stopped.actionDetailTiming.lateDetailCount, 1);
    assert.equal(stopped.actionDetailTiming.orphanDetailCount, 1);
    assert.equal(stopped.integrityStatus, 'incomplete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persists replay recovery statistics and separate device baselines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'action-recorder-replay-stats-'));
  const child = new FakeChild();
  let activeOwner = '';
  let replayFocusCalls = 0;
  let replayTapCount = 0;
  const device = {
    async beginSession({ owner }) {
      activeOwner = owner;
      return {
        id: `lock-${owner}`,
        owner,
        connected: true,
        provider: 'hdc',
        serial: owner.startsWith('replay:') ? 'harmony-target' : 'harmony-source',
        screen: owner.startsWith('replay:')
          ? { width: 1200, height: 2400 }
          : { width: 1000, height: 2000 },
      };
    },
    async endSession() {
      activeOwner = '';
    },
    async startUiRecording() {
      return {
        process: child,
        provider: 'hdc',
        serial: 'harmony-source',
      };
    },
    async readUiRecording() {
      return 'click 100 200';
    },
    async getScreenSize() {
      return activeOwner.startsWith('replay:')
        ? { width: 1200, height: 2400 }
        : { width: 1000, height: 2000 };
    },
    async getCurrentFocus() {
      if (!activeOwner.startsWith('replay:')) {
        return {
          bundleName: 'com.example.app',
          abilityName: 'MainAbility',
        };
      }
      replayFocusCalls += 1;
      return {
        bundleName: 'com.example.app',
        abilityName: replayFocusCalls >= 3 ? 'ReadyAbility' : 'MainAbility',
      };
    },
    async getUiTextSnapshot() {
      return {
        text: '下一步',
        values: ['下一步'],
        layout: { attributes: { bounds: '[0,0][1200,2400]' } },
      };
    },
    async tap() {
      if (activeOwner.startsWith('replay:')) replayTapCount += 1;
    },
  };

  try {
    const apps = [
      {
        id: 'example',
        name: 'Example',
        packageName: 'com.example.app',
      },
    ];
    const recorder = new ActionRecorder({
      device,
      apps,
      recordingsRoot: root,
    });
    const started = await recorder.start({
      appId: 'example',
      featureName: 'Recovery stats',
    });
    await recorder.stop(started.id);
    recorder.sessions.get(started.id).semanticSteps = [
      {
        type: 'tap',
        x: 100,
        y: 200,
        normalizedX: 0.1,
        normalizedY: 0.1,
        coordinateSpace: 'safe_area',
        target: { texts: ['下一步'], required: false },
      },
      {
        type: 'assert_state',
        state: {
          packages: ['com.example.app'],
          activities: ['ReadyAbility'],
          textAny: [],
          nodeIds: [],
          strength: 2,
        },
        timeoutMs: 0,
        recovery: {
          relaunchApp: true,
          retryPreviousAction: true,
        },
      },
    ];

    const replayed = await recorder.replay(started.id);
    assert.equal(replayed.status, 'replayed');
    assert.equal(replayTapCount, 2);
    assert.equal(replayed.replayStats.attempts, 1);
    assert.equal(replayed.replayStats.passed, 1);
    assert.equal(replayed.replayStats.recoveredAttempts, 1);
    assert.equal(replayed.deviceBaselines.length, 2);

    const reloaded = new ActionRecorder({
      device,
      apps,
      recordingsRoot: root,
    });
    await reloaded.loadFromDisk();
    const restored = reloaded.snapshot(started.id);
    assert.equal(restored.replayStats.attempts, 1);
    assert.equal(restored.replayStats.recoveredAttempts, 1);
    assert.equal(restored.deviceBaselines.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writes failed-start evidence and rebuilds missing integrity data for old recordings', async () => {
  const failedRoot = await mkdtemp(join(tmpdir(), 'action-recorder-failed-evidence-'));
  const legacyRoot = await mkdtemp(join(tmpdir(), 'action-recorder-legacy-evidence-'));
  try {
    const failedRecorder = new ActionRecorder({
      device: {
        async getDeviceStatus() {
          return {
            connected: true,
            provider: 'hdc',
            serial: 'harmony-failed',
            screen: { width: 1000, height: 2000 },
          };
        },
        async startUiRecording() {
          throw new Error('recorder unavailable');
        },
      },
      apps: [{ id: 'example', name: 'Example' }],
      recordingsRoot: failedRoot,
    });
    await assert.rejects(
      failedRecorder.start({
        appId: 'example',
        featureName: 'Failed evidence',
      }),
      /recorder unavailable/,
    );
    const failed = failedRecorder.list()[0];
    const failedEvidence = JSON.parse(
      await readFile(failed.evidenceManifestFile, 'utf8'),
    );
    assert.equal(failed.integrityStatus, 'unusable');
    assert.equal(failedEvidence.integrityReport.status, 'unusable');
    assert.deepEqual(failedEvidence.entries, []);

    const child = new FakeChild();
    const legacyDevice = {
      async getDeviceStatus() {
        return {
          connected: true,
          provider: 'adb',
          serial: 'android-legacy',
          screen: { width: 1000, height: 2000 },
        };
      },
      async startUiRecording() {
        return { process: child, provider: 'adb', serial: 'android-legacy' };
      },
      async readUiRecording() {
        return 'click 100 200';
      },
      async getCurrentFocus() {
        return { packageName: 'com.example.app', activity: 'MainActivity' };
      },
      async getUiTextSnapshot() {
        return {
          text: '首页',
          values: ['首页'],
          layout: null,
        };
      },
      async screenshotPng() {
        return Buffer.from('png');
      },
    };
    const apps = [{ id: 'example', name: 'Example' }];
    const legacyRecorder = new ActionRecorder({
      device: legacyDevice,
      apps,
      recordingsRoot: legacyRoot,
    });
    const started = await legacyRecorder.start({
      appId: 'example',
      featureName: 'Legacy evidence',
    });
    child.stdout.write('click , fingerNumber:1 ,\n');
    child.stdout.write(
      'finger1:click at Point(x:100, y:200) at Widget(id:legacy, text:打开, type:Button)\n',
    );
    const stopped = await legacyRecorder.stop(started.id);
    const metadata = JSON.parse(await readFile(stopped.trajectoryFile, 'utf8'));
    delete metadata.semanticSteps;
    delete metadata.evidenceManifest;
    delete metadata.integrityStatus;
    delete metadata.integrityIssues;
    delete metadata.integrityReport;
    await writeFile(
      stopped.trajectoryFile,
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8',
    );

    const reloaded = new ActionRecorder({
      device: legacyDevice,
      apps,
      recordingsRoot: legacyRoot,
    });
    await reloaded.loadFromDisk();
    const restored = reloaded.snapshot(started.id);
    assert.equal(restored.semanticStepCount > 0, true);
    assert.equal(restored.evidenceManifest.length, 1);
    assert.notDeepEqual(restored.integrityReport, {});
    assert.equal(restored.integrityStatus, 'complete');
  } finally {
    await rm(failedRoot, { recursive: true, force: true });
    await rm(legacyRoot, { recursive: true, force: true });
  }
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill() {
    if (this.exitCode !== null) return false;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
