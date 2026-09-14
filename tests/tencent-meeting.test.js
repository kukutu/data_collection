import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { ActionRecorder } from '../server/src/action-recorder.js';
import {
  applyWorkflowParameters,
  TaskManager,
} from '../server/src/harness.js';
import {
  durationParameterToMs,
  executeTencentJoinMeeting,
  executeTencentQuickMeeting,
  inspectTencentCameraToggle,
  inspectTencentShareStatusPixels,
  selectTencentShareSteps,
  TENCENT_JOIN_MEETING_WORKFLOW_ID,
  TENCENT_QUICK_MEETING_WORKFLOW_ID,
} from '../server/src/skills/tencent-meeting.js';
import { getWorkflowCatalog } from '../server/src/workflow-registry.js';

const APP = {
  id: 'tencent-meeting',
  name: '腾讯会议',
  packageName: 'com.tencent.wemeet.app',
  harmonyBundleName: 'com.tencent.meeting.app',
};

test('converts meeting duration units without applying replay speed', () => {
  assert.equal(durationParameterToMs({ amount: 2, unit: '秒' }), 2000);
  assert.equal(durationParameterToMs({ amount: 3, unit: '分钟' }), 180000);
  assert.equal(durationParameterToMs({ amount: 1.5, unit: '小时' }), 5400000);
  assert.throws(
    () => durationParameterToMs({ amount: 0, unit: '分钟' }),
    /无效的会议持续时间/,
  );
});

test('reads Tencent Meeting camera toggle state from Harmony layout geometry', () => {
  assert.equal(inspectTencentCameraToggle(buildSetupLayout(true)).enabled, true);
  assert.equal(inspectTencentCameraToggle(buildSetupLayout(false)).enabled, false);
});

test('extracts in-meeting share actions and restores a legacy longClick', () => {
  const selected = selectTencentShareSteps([
    { type: 'tap', x: 717, y: 2579, delayMs: 0 },
    { type: 'tap', x: 634, y: 2606, delayMs: 0 },
    { type: 'tap', x: 800, y: 2228, delayMs: 0 },
    { type: 'tap', x: 937, y: 1818, delayMs: 0 },
    { type: 'tap', x: 593, y: 1674, delayMs: 0 },
    { type: 'tap', x: 1161, y: 185, delayMs: 0 },
    { type: 'tap', x: 787, y: 2371, delayMs: 0 },
  ]);

  assert.equal(selected.length, 4);
  assert.equal(selected[0].index, 1);
  assert.equal(selected[2].step.type, 'long_press');
  assert.equal(selected[2].step.durationMs, 800);
});

test('recognizes the Harmony Tencent Meeting share status screen by pixels', () => {
  const width = 100;
  const height = 200;
  const data = Buffer.alloc(width * height * 4, 0);
  paintRect(data, width, 4, [42, 68, 58, 100], [0, 220, 140, 255]);
  paintRect(data, width, 4, [42, 112, 58, 144], [240, 70, 70, 255]);

  const result = inspectTencentShareStatusPixels({
    width,
    height,
    data,
    channels: 4,
  });

  assert.equal(result.active, true);
  assert.ok(result.darkRatio > 0.72);
  assert.ok(result.greenRatio > 0.015);
  assert.ok(result.redRatio > 0.015);
});

test('executes quick meeting parameters, waits the requested duration, and strictly validates sharing', async () => {
  const sleepCalls = [];
  const device = createMeetingDevice({
    recoveryOnLaunch: true,
    permissionOnEnter: true,
  });
  const replayedSteps = [];
  let captureState = null;

  const result = await executeTencentQuickMeeting({
    device,
    app: APP,
    parameters: {
      duration: { amount: 2, unit: '秒' },
      camera: true,
      shareScreen: true,
    },
    recordedSteps: [
      { type: 'tap', x: 717, y: 2579, delayMs: 0 },
      { type: 'tap', x: 634, y: 2606, delayMs: 0 },
      { type: 'tap', x: 1161, y: 185, delayMs: 0 },
    ],
    executeStep: async (step) => {
      replayedSteps.push(step);
      device.openShareDialog();
    },
    startCapture: async () => {
      captureState = device.currentState();
    },
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    timings: zeroTimings(),
  });

  assert.equal(result.validationMode, 'tencent_quick_meeting_v1');
  assert.equal(result.effectiveDurationMs, 2000);
  assert.ok(result.validationChecks.every((check) => check.status === 'passed'));
  assert.ok(
    result.validationChecks.some((check) => check.id === 'share_dialog_opened'),
  );
  assert.ok(
    result.validationChecks.some((check) => check.id === 'share_started'),
  );
  assert.ok(sleepCalls.includes(2000));
  assert.equal(replayedSteps.length, 1);
  assert.equal(device.cameraEnabled(), true);
  assert.equal(device.shareConfirmation(), '允许');
  assert.equal(device.currentState(), 'home');
  assert.equal(device.recoveryCancelled(), true);
  assert.equal(device.permissionGranted(), true);
  assert.equal(captureState, 'setup');
  assert.ok(
    result.validationChecks.some((check) => check.id === 'capture_started'),
  );
});

test('Tencent Meeting workflow parameters override the generic unsupported parser result', () => {
  assert.deepEqual(
    applyWorkflowParameters(
      { intent: 'unsupported_flow', reason: 'meeting not implemented' },
      {
        workflowId: TENCENT_QUICK_MEETING_WORKFLOW_ID,
        parameters: {
          duration: { amount: 2, unit: '分钟' },
          camera: true,
          shareScreen: false,
        },
      },
    ),
    {
      intent: 'tencent_quick_meeting',
      appName: '腾讯会议',
      durationMs: 120_000,
      camera: true,
      shareScreen: false,
    },
  );
});

test('Tencent join meeting parameters allow an empty password and preserve duration and toggles', () => {
  assert.deepEqual(
    applyWorkflowParameters(
      { intent: 'unsupported_flow', reason: 'meeting not implemented' },
      {
        workflowId: TENCENT_JOIN_MEETING_WORKFLOW_ID,
        parameters: {
          meetingId: '660-739-282',
          meetingPassword: '',
          duration: { amount: 3, unit: '分钟' },
          camera: true,
          shareScreen: true,
        },
      },
    ),
    {
      intent: 'tencent_join_meeting',
      appName: '腾讯会议',
      meetingId: '660-739-282',
      meetingPassword: null,
      durationMs: 180_000,
      camera: true,
      shareScreen: true,
    },
  );
});

test('joins Tencent Meeting by meeting ID, shares the screen, waits, and leaves without ending the meeting', async () => {
  const sleepCalls = [];
  const device = createJoinMeetingDevice({ rememberedSharePermission: true });

  const result = await executeTencentJoinMeeting({
    device,
    app: APP,
    parameters: {
      meetingId: '660-739-282',
      meetingPassword: '',
      duration: { amount: 2, unit: '秒' },
      camera: true,
      shareScreen: true,
    },
    recordedSteps: [
      { type: 'tap', x: 717, y: 2579, delayMs: 0 },
      { type: 'tap', x: 634, y: 2606, delayMs: 0 },
      { type: 'tap', x: 1161, y: 185, delayMs: 0 },
    ],
    executeStep: async () => {
      throw new Error('dynamic sharing path should not use recorded fallback');
    },
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    timings: zeroTimings(),
  });

  assert.equal(result.validationMode, 'tencent_join_meeting_v1');
  assert.equal(result.effectiveDurationMs, 2000);
  assert.equal(device.enteredMeetingId(), '660739282');
  assert.equal(device.cameraEnabled(), true);
  assert.equal(device.shareConfirmation(), null);
  assert.equal(device.leaveConfirmed(), true);
  assert.equal(device.endMeetingSelected(), false);
  assert.equal(device.currentState(), 'home');
  assert.ok(sleepCalls.includes(2000));
  assert.ok(
    result.validationChecks.some(
      (check) =>
        check.id === 'meeting_password_not_required' &&
        check.status === 'passed',
    ),
  );
  assert.ok(
    result.validationChecks.some(
      (check) =>
        check.id === 'share_dialog_opened' &&
        check.detail.includes('系统权限已复用'),
    ),
  );
  assert.ok(
    result.validationChecks.some(
      (check) =>
        check.id === 'meeting_cleanup' &&
        check.detail.includes('正常离开会议'),
    ),
  );
});

test('TaskManager executes Tencent quick meeting from verified recording data without nesting device locks', async () => {
  const workflows = getWorkflowCatalog([APP]);
  const locks = [];
  const taps = [];
  let executorOptions = null;
  const adb = {
    async beginSession({ owner }) {
      const lock = {
        id: 'task-lock',
        owner,
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-current',
        screen: { width: 1280, height: 2832 },
      };
      locks.push(['begin', lock]);
      return lock;
    },
    async endSession(lock) {
      locks.push(['end', lock]);
    },
    async tap(point) {
      taps.push(point);
    },
  };
  const manager = new TaskManager({
    adb,
    apps: [APP],
    workflows,
    workflowExecutionProvider: (workflowId) => {
      assert.equal(workflowId, TENCENT_QUICK_MEETING_WORKFLOW_ID);
      return {
        recordingId: 'verified-recording',
        workflowId,
        validationStatus: 'verified',
        steps: [{ type: 'tap', x: 628, y: 1380 }],
        screen: { width: 1256, height: 2760 },
        recordingProfile: {
          screen: { width: 1256, height: 2760 },
        },
      };
    },
    tencentQuickMeetingExecutor: async (options) => {
      executorOptions = options;
      await options.executeStep(options.recordedSteps[0], {
        targetScreen: { width: 1280, height: 2832 },
      });
      options.onStep(1);
      return {
        validationMode: 'tencent_quick_meeting_v1',
        validationChecks: [
          {
            id: 'meeting_cleanup',
            label: '会议清理',
            status: 'passed',
            detail: '已正常结束会议',
          },
        ],
        effectiveDurationMs: 2000,
        replayStepIndex: 1,
      };
    },
  });

  const started = manager.start({
    taskText: '在腾讯会议发起快速会议',
    parseMode: 'rules',
    workflowId: TENCENT_QUICK_MEETING_WORKFLOW_ID,
    parameters: {
      duration: { amount: 2, unit: '秒' },
      camera: true,
      shareScreen: false,
    },
  });
  const completed = await waitForManagerTask(manager, started.id);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.parsed.intent, 'tencent_quick_meeting');
  assert.deepEqual(executorOptions.parameters, {
    duration: { amount: 2, unit: '秒' },
    camera: true,
    shareScreen: false,
  });
  assert.deepEqual(taps, [{ x: 640, y: 1416 }]);
  assert.deepEqual(
    locks.map(([type]) => type),
    ['begin', 'end'],
  );
  assert.equal(completed.validationMode, 'tencent_quick_meeting_v1');
  assert.equal(completed.effectiveDurationMs, 2000);
  assert.equal(completed.totalSteps, 0);
});

test('TaskManager executes Tencent join meeting with quick-meeting sharing evidence', async () => {
  const workflows = getWorkflowCatalog([APP]);
  let requestedEvidenceWorkflowId = null;
  let executorOptions = null;
  const adb = {
    async beginSession() {
      return {
        id: 'task-lock',
        connected: true,
        provider: 'hdc',
        platform: 'harmony',
        serial: 'harmony-current',
        screen: { width: 1280, height: 2832 },
      };
    },
    async endSession() {},
    async tap() {},
  };
  const manager = new TaskManager({
    adb,
    apps: [APP],
    workflows,
    workflowExecutionProvider: (workflowId) => {
      requestedEvidenceWorkflowId = workflowId;
      return {
        recordingId: 'verified-quick-meeting-recording',
        workflowId,
        validationStatus: 'verified',
        steps: [{ type: 'tap', x: 628, y: 1380 }],
        screen: { width: 1256, height: 2760 },
      };
    },
    tencentJoinMeetingExecutor: async (options) => {
      executorOptions = options;
      return {
        validationMode: 'tencent_join_meeting_v1',
        validationChecks: [
          {
            id: 'meeting_cleanup',
            label: '会议清理',
            status: 'passed',
            detail: '已正常离开会议',
          },
        ],
        effectiveDurationMs: 2000,
        replayStepIndex: 0,
      };
    },
  });

  const started = manager.start({
    taskText: '加入腾讯会议',
    parseMode: 'rules',
    workflowId: TENCENT_JOIN_MEETING_WORKFLOW_ID,
    parameters: {
      meetingId: '660-739-282',
      meetingPassword: '',
      duration: { amount: 2, unit: '秒' },
      camera: true,
      shareScreen: true,
    },
  });
  const completed = await waitForManagerTask(manager, started.id);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.parsed.intent, 'tencent_join_meeting');
  assert.equal(completed.parsed.meetingId, '660-739-282');
  assert.equal(completed.parsed.meetingPassword, null);
  assert.equal(requestedEvidenceWorkflowId, TENCENT_QUICK_MEETING_WORKFLOW_ID);
  assert.deepEqual(executorOptions.parameters, {
    duration: { amount: 2, unit: '秒' },
    meetingId: '660-739-282',
    meetingPassword: null,
    camera: true,
    shareScreen: true,
  });
  assert.equal(completed.validationMode, 'tencent_join_meeting_v1');
  assert.equal(completed.parameters.meetingPassword, '[已隐藏]');
});

test('fails replay when the Harmony screen sharing confirmation window never appears', async () => {
  const device = createMeetingDevice();

  await assert.rejects(
    executeTencentQuickMeeting({
      device,
      app: APP,
      parameters: {
        duration: { amount: 1, unit: '秒' },
        camera: false,
        shareScreen: true,
      },
      recordedSteps: [
        { type: 'tap', x: 717, y: 2579, delayMs: 0 },
        { type: 'tap', x: 634, y: 2606, delayMs: 0 },
        { type: 'tap', x: 1161, y: 185, delayMs: 0 },
      ],
      executeStep: async () => {},
      sleep: async () => {},
      timings: zeroTimings(),
    }),
    (error) => {
      assert.match(error.message, /SCBSysDialogDefault48/);
      assert.equal(
        error.validationChecks.at(-1).id,
        'share_dialog_opened',
      );
      assert.equal(error.validationChecks.at(-1).status, 'failed');
      return true;
    },
  );

  assert.equal(device.currentState(), 'home');
});

test('ActionRecorder applies replay parameter overrides and only verifies returned checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tencent-recorder-'));
  const child = new FakeChild();
  const workflows = getWorkflowCatalog([APP]);
  const workflow = workflows.find(
    (item) => item.id === 'meeting:tencent-meeting:quick-meeting',
  );
  let receivedParameters = null;
  const device = {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-1',
        screen: { width: 1256, height: 2760 },
      };
    },
    async startUiRecording() {
      return { process: child, provider: 'hdc', serial: 'harmony-1' };
    },
    async readUiRecording() {
      return 'click 717 2579';
    },
    async getScreenSize() {
      return { width: 1256, height: 2760 };
    },
  };

  try {
    const recorder = new ActionRecorder({
      device,
      apps: [APP],
      workflows,
      recordingsRoot: root,
      quickMeetingExecutor: async ({ parameters }) => {
        receivedParameters = parameters;
        return {
          validationMode: 'tencent_quick_meeting_v1',
          validationChecks: [
            {
              id: 'meeting_sustained',
              label: '会议保持',
              status: 'passed',
              detail: '',
            },
          ],
          effectiveDurationMs: 5000,
          replayStepIndex: 1,
        };
      },
    });
    const started = await recorder.start({
      appId: APP.id,
      workflowId: workflow.id,
      parameters: {
        duration: { amount: 30, unit: '分钟' },
        camera: true,
        shareScreen: true,
      },
    });
    await recorder.stop(started.id);
    const replayed = await recorder.replay(started.id, {
      speed: 10,
      parameters: {
        duration: { amount: 3, unit: '秒' },
        camera: false,
      },
      validationDurationMs: 5000,
    });

    assert.deepEqual(receivedParameters, {
      duration: { amount: 5, unit: '秒' },
      camera: false,
      shareScreen: true,
    });
    assert.equal(replayed.validationStatus, 'verified');
    assert.equal(replayed.effectiveDurationMs, 5000);
    assert.deepEqual(replayed.parameters.duration, {
      amount: 3,
      unit: '秒',
    });
    assert.match(
      await readFile(replayed.trajectoryFile, 'utf8'),
      /"effectiveDurationMs": 5000/,
    );
    const execution = recorder.getVerifiedWorkflowExecution(workflow.id);
    assert.equal(execution.recordingId, replayed.id);
    assert.equal(execution.validationStatus, 'verified');
    assert.equal(execution.validationMode, 'tencent_quick_meeting_v1');
    assert.equal(execution.steps.length, 1);
    assert.deepEqual(execution.screen, { width: 1256, height: 2760 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restores recordings, canonicalizes workflow names, and downgrades legacy verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recording-load-'));
  const workflows = getWorkflowCatalog([
    APP,
    { id: 'douyin', name: '抖音' },
    { id: 'wechat', name: '微信' },
  ]);
  const oldTencent = {
    version: 1,
    id: 'legacy-tencent',
    appId: APP.id,
    appName: APP.name,
    featureName: '快速会议',
    workflowId: 'meeting:tencent-meeting:quick-meeting',
    recordingKey: 'meeting:tencent-meeting:quick-meeting',
    params: workflows.find(
      (item) => item.id === 'meeting:tencent-meeting:quick-meeting',
    ).params,
    parameters: {
      duration: { amount: 30, unit: '分钟' },
      camera: true,
      shareScreen: true,
    },
    validationStatus: 'verified',
    validatedAt: '2026-09-03T13:37:21.343Z',
    startedAt: '2026-09-03T13:35:36.587Z',
    stoppedAt: '2026-09-03T13:36:21.185Z',
    steps: [{ type: 'tap', x: 717, y: 2579, delayMs: 0 }],
  };
  const oldDouyin = {
    version: 1,
    id: 'legacy-douyin',
    appId: 'douyin',
    appName: '抖音',
    featureName: '抖音短视频',
    workflowId: 'short-video:douyin:short-video-feed',
    recordingKey: 'short-video:douyin:short-video-feed',
    params: [],
    parameters: {},
    validationStatus: 'verified',
    validatedAt: '2026-09-03T12:00:00.000Z',
    startedAt: '2026-09-03T11:59:00.000Z',
    stoppedAt: '2026-09-03T12:00:00.000Z',
    steps: [{ type: 'tap', x: 100, y: 200, delayMs: 0 }],
  };
  const oldWechatVoip = {
    version: 4,
    id: 'legacy-wechat-voip',
    appId: 'wechat',
    appName: '微信',
    featureName: '音视频通话',
    workflowId: 'voip:wechat:video-call',
    workflowName: '音视频通话',
    recordingKey: 'voip:wechat:video-call',
    params: [],
    parameters: {},
    validationStatus: 'unverified',
    startedAt: '2026-09-04T09:51:57.885Z',
    stoppedAt: '2026-09-04T09:52:01.830Z',
    steps: [],
  };

  try {
    const tencentFile = await writeTrajectory(
      root,
      ['腾讯会议', '快速会议', 'legacy'],
      oldTencent,
    );
    await writeTrajectory(
      root,
      ['抖音', '抖音短视频', 'legacy'],
      oldDouyin,
    );
    await writeTrajectory(
      root,
      ['微信', '音视频通话', 'legacy'],
      oldWechatVoip,
    );
    const recorder = new ActionRecorder({
      device: {},
      apps: [APP, { id: 'douyin', name: '抖音' }, { id: 'wechat', name: '微信' }],
      workflows,
      recordingsRoot: root,
    });

    assert.deepEqual(await recorder.loadFromDisk(), {
      loaded: 3,
      downgraded: 1,
    });
    const restored = recorder.snapshot('legacy-tencent');
    assert.equal(restored.status, 'stopped');
    assert.equal(restored.validationStatus, 'unverified');
    assert.match(restored.validationError, /缺少严格业务状态验证/);
    assert.deepEqual(
      [...recorder.getVerifiedWorkflowIds()],
      ['short-video:douyin:short-video-feed'],
    );
    const restoredWechatVoip = recorder.snapshot('legacy-wechat-voip');
    assert.equal(restoredWechatVoip.workflowName, '视频通话');
    assert.equal(restoredWechatVoip.featureName, '视频通话');
    assert.equal(restoredWechatVoip.parameterSchema[0].id, 'duration');
    assert.equal(restoredWechatVoip.parameterSchema[0].label, '通话时长');

    const persisted = JSON.parse(await readFile(tencentFile, 'utf8'));
    assert.equal(persisted.version, 5);
    assert.equal(persisted.validationStatus, 'unverified');
    assert.equal(persisted.validatedAt, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createMeetingDevice({
  exposeShareDialogFocus = false,
  recoveryOnLaunch = false,
  permissionOnEnter = false,
} = {}) {
  let state = 'idle';
  let camera = false;
  let shareConfirmation = null;
  let cancelledRecovery = false;
  let grantedPermission = false;

  return {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-1',
        screen: { width: 1256, height: 2760 },
      };
    },
    async forceStopPackage() {
      state = 'stopped';
    },
    async launchPackage() {
      state = recoveryOnLaunch ? 'recovery' : 'home';
    },
    async getCurrentFocus() {
      if (state === 'stopped') return null;
      if (state === 'permission') {
        return {
          packageName: 'com.huawei.hmos.security.privacycenter',
          bundleName: 'com.huawei.hmos.security.privacycenter',
          activity: 'PermissionStateSheetPage',
        };
      }
      if (state === 'share-dialog' && exposeShareDialogFocus) {
        return {
          packageName: 'SCBSysDialogDefault48',
          bundleName: 'SCBSysDialogDefault48',
          activity: 'ShareConfirmAbility',
        };
      }
      return {
        packageName: APP.packageName,
        bundleName: APP.harmonyBundleName,
        activity: 'NXHostUIAbility',
      };
    },
    async getScreenSize() {
      return { width: 1256, height: 2760 };
    },
    async getUiTextSnapshot() {
      if (state === 'recovery') {
        return {
          text: '腾讯会议\n加入会议\n快速会议\n检测到您上次异常退出，是否要恢复会议？\n取消\n恢复',
          layout: buildRecoveryLayout(),
        };
      }
      if (state === 'setup') {
        return {
          text: '快速会议\n开启视频\n进入会议',
          layout: buildSetupLayout(camera),
        };
      }
      if (state === 'share-dialog') {
        return {
          text: '允许“腾讯会议”使用你的屏幕？\n不允许\n允许',
          layout: buildShareDialogLayout(),
        };
      }
      if (state === 'permission') {
        return {
          text: '麦克风权限\n麦克风访问权限\n允许\n不允许\n确定',
          layout: buildPermissionLayout(),
        };
      }
      if (state === 'share-active') {
        return {
          text: '您正在共享屏幕\n共享音频：开\n停止共享',
          layout: buildMeetingLayout(),
        };
      }
      if (state === 'end-dialog') {
        return {
          text: '离开会议\n结束会议\n取消',
          layout: buildEndDialogLayout(),
        };
      }
      if (state === 'meeting') {
        return {
          text: '',
          layout: buildMeetingLayout(),
        };
      }
      return {
        text: '腾讯会议\n加入会议\n快速会议\n预定会议\n共享屏幕',
        layout: buildHomeLayout(),
      };
    },
    async tap({ x, y }) {
      if (state === 'recovery') {
        cancelledRecovery = x < 640;
        state = cancelledRecovery ? 'home' : 'meeting';
      } else if (state === 'home') {
        state = 'setup';
      } else if (state === 'setup' && y < 1000) {
        camera = !camera;
      } else if (state === 'setup') {
        state = permissionOnEnter ? 'permission' : 'meeting';
      } else if (state === 'permission') {
        if (y >= 2500) {
          grantedPermission = true;
          state = 'meeting';
        }
      } else if (state === 'share-dialog') {
        if (x >= 600) {
          shareConfirmation = '允许';
          state = 'share-active';
        } else {
          shareConfirmation = '不允许';
          state = 'meeting';
        }
      } else if (state === 'end-dialog') {
        state = 'home';
      }
    },
    async keyevent() {
      if (state === 'share-active') {
        state = 'meeting';
      } else if (state === 'meeting') {
        state = 'end-dialog';
      }
    },
    openShareDialog() {
      state = 'share-dialog';
    },
    currentState() {
      return state;
    },
    cameraEnabled() {
      return camera;
    },
    shareConfirmation() {
      return shareConfirmation;
    },
    recoveryCancelled() {
      return cancelledRecovery;
    },
    permissionGranted() {
      return grantedPermission;
    },
  };
}

function createJoinMeetingDevice({ rememberedSharePermission = false } = {}) {
  let state = 'idle';
  let camera = false;
  let meetingId = '';
  let keyboardVisible = false;
  let shareConfirmation = null;
  let confirmedLeave = false;
  let selectedEndMeeting = false;

  return {
    async getDeviceStatus() {
      return {
        connected: true,
        provider: 'hdc',
        serial: 'harmony-join',
        screen: { width: 1280, height: 2832 },
      };
    },
    async forceStopPackage() {
      state = 'stopped';
    },
    async launchPackage() {
      state = 'home';
    },
    async getCurrentFocus() {
      if (state === 'stopped') return null;
      return {
        packageName: APP.packageName,
        bundleName: APP.harmonyBundleName,
        activity: 'NXHostUIAbility',
      };
    },
    async getScreenSize() {
      return { width: 1280, height: 2832 };
    },
    async getUiTextSnapshot() {
      if (state === 'join-setup') {
        return {
          text: `加入会议\n会议号\n${meetingId ? '660 739 282' : '请输入会议号'}\n您的名称\n开启视频`,
          values: keyboardVisible ? ['+', '-', '=', '/'] : [],
          layout: buildJoinSetupLayout({ cameraEnabled: camera, meetingId }),
        };
      }
      if (state === 'share-dialog') {
        return {
          text: '允许“腾讯会议”使用你的屏幕？\n不允许\n允许',
          layout: buildShareDialogLayout(),
        };
      }
      if (state === 'share-menu') {
        return {
          text: '腾讯会议\n离开\n共享屏幕\n共享屏幕\n共享白板\n取消',
          layout: buildShareMenuLayout(),
        };
      }
      if (state === 'share-active') {
        return {
          text: '您正在共享屏幕\n停止共享',
          layout: buildMeetingLayout(),
        };
      }
      if (state === 'share-active-hidden') {
        return {
          text: '',
          layout: buildMeetingLayout(),
        };
      }
      if (state === 'meeting') {
        return {
          text: '腾讯会议\n离开\n共享屏幕',
          layout: buildJoinMeetingLayout(),
        };
      }
      if (state === 'leave-dialog') {
        return {
          text: '确定离开会议吗？\n离开会议\n取消',
          layout: buildLeaveMeetingDialogLayout(),
        };
      }
      return {
        text: '腾讯会议\n加入会议\n快速会议\n预定会议\n进行中\n入会',
        layout: buildHomeLayout(),
      };
    },
    async tap({ x, y }) {
      if (state === 'home') {
        state = 'join-setup';
      } else if (state === 'join-setup' && x >= 1000) {
        camera = !camera;
      } else if (state === 'join-setup' && y >= 1400) {
        state = 'meeting';
      } else if (state === 'share-menu') {
        state = rememberedSharePermission
          ? 'share-active-hidden'
          : 'share-dialog';
      } else if (state === 'share-dialog') {
        shareConfirmation = x >= 600 ? '允许' : '不允许';
        state = shareConfirmation === '允许' ? 'share-active' : 'meeting';
      } else if (state === 'share-active-hidden') {
        state = 'share-active';
      } else if (state === 'meeting' && y >= 2500) {
        state = 'share-menu';
      } else if (state === 'meeting' && y < 500) {
        state = 'leave-dialog';
      } else if (state === 'leave-dialog') {
        confirmedLeave = true;
        selectedEndMeeting = false;
        state = 'home';
      }
    },
    async inputText(text) {
      if (state === 'join-setup') {
        meetingId = String(text);
        keyboardVisible = true;
      }
    },
    async keyevent() {
      if (state === 'join-setup') keyboardVisible = false;
      if (state === 'share-active') state = 'meeting';
    },
    openShareDialog() {
      state = 'share-dialog';
    },
    currentState() {
      return state;
    },
    enteredMeetingId() {
      return meetingId;
    },
    cameraEnabled() {
      return camera;
    },
    shareConfirmation() {
      return shareConfirmation;
    },
    leaveConfirmed() {
      return confirmedLeave;
    },
    endMeetingSelected() {
      return selectedEndMeeting;
    },
  };
}

function buildSetupLayout(cameraEnabled) {
  return {
    attributes: { bounds: '[0,0][1256,2760]' },
    children: [
      {
        attributes: {
          text: '开启视频',
          originalText: '开启视频',
          bounds: '[56,392][280,469]',
        },
        children: [],
      },
      {
        attributes: {
          text: '进入会议',
          originalText: '进入会议',
          bounds: '[530,2536][727,2593]',
        },
        children: [],
      },
      {
        attributes: {
          bounds: '[1053,388][1200,472]',
          id: 'camera-switch',
        },
        children: [
          {
            attributes: {
              bounds: '[1053,388][1200,472]',
              id: 'camera-switch-track',
            },
            children: [
              {
                attributes: {
                  bounds: cameraEnabled
                    ? '[1053,388][1193,465]'
                    : '[1053,388][1130,465]',
                  id: 'camera-switch-indicator',
                },
                children: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildJoinSetupLayout({ cameraEnabled, meetingId }) {
  return {
    attributes: { bounds: '[0,0][1280,2832]' },
    children: [
      {
        attributes: {
          text: '加入会议',
          originalText: '加入会议',
          bounds: '[528,180][752,246]',
        },
        children: [],
      },
      {
        attributes: {
          text: '会议号',
          originalText: '会议号',
          bounds: '[56,392][336,469]',
        },
        children: [],
      },
      {
        attributes: {
          text: meetingId ? '660 739 282' : '请输入会议号',
          originalText: meetingId ? '660 739 282' : '请输入会议号',
          type: meetingId ? 'TextInput' : 'Text',
          bounds: '[336,360][1084,500]',
        },
        children: [],
      },
      {
        attributes: {
          text: '您的名称',
          originalText: '您的名称',
          bounds: '[56,588][336,665]',
        },
        children: [],
      },
      {
        attributes: {
          text: '开启视频',
          originalText: '开启视频',
          bounds: '[56,1414][280,1491]',
        },
        children: [],
      },
      {
        attributes: {
          bounds: '[1070,1405][1220,1495]',
          id: 'camera-switch',
        },
        children: [
          {
            attributes: {
              bounds: '[1070,1405][1220,1495]',
              id: 'camera-switch-track',
            },
            children: [
              {
                attributes: {
                  bounds: cameraEnabled
                    ? '[1070,1405][1213,1488]'
                    : '[1070,1405][1148,1488]',
                  id: 'camera-switch-indicator',
                },
                children: [],
              },
            ],
          },
        ],
      },
      {
        attributes: {
          text: '加入会议',
          originalText: '加入会议',
          bounds: '[542,1509][739,1566]',
        },
        children: [],
      },
    ],
  };
}

function buildMeetingLayout() {
  return {
    attributes: {
      bounds: '[0,0][1256,2760]',
      abilityName: 'NXHostUIAbility',
    },
    children: [
      {
        attributes: {
          bounds: '[0,0][1256,2760]',
          id: 'NxHostView_4',
        },
        children: [],
      },
    ],
  };
}

function buildJoinMeetingLayout() {
  const layout = buildMeetingLayout();
  layout.children.push(
    {
      attributes: {
        text: '离开',
        originalText: '离开',
        bounds: '[1126,182][1238,259]',
      },
      children: [],
    },
    {
      attributes: {
        text: '共享屏幕',
        originalText: '共享屏幕',
        bounds: '[601,2679][742,2735]',
      },
      children: [],
    },
  );
  return layout;
}

function buildShareMenuLayout() {
  const layout = buildJoinMeetingLayout();
  layout.children.push(
    {
      attributes: {
        text: '共享屏幕',
        originalText: '共享屏幕',
        bounds: '[528,2267][752,2333]',
      },
      children: [],
    },
    {
      attributes: {
        text: '共享白板',
        originalText: '共享白板',
        bounds: '[528,2440][752,2506]',
      },
      children: [],
    },
  );
  return layout;
}

function buildHomeLayout() {
  const layout = buildMeetingLayout();
  layout.children.push({
    attributes: {
      text: '快速会议',
      originalText: '快速会议',
      bounds: '[403,792][572,841]',
    },
    children: [],
  });
  return layout;
}

function buildShareDialogLayout() {
  return {
    attributes: { bounds: '[0,0][1256,2760]' },
    children: [
      {
        attributes: {
          text: '不允许',
          originalText: '不允许',
          bounds: '[120,1750][500,1900]',
        },
        children: [],
      },
      {
        attributes: {
          text: '允许',
          originalText: '允许',
          bounds: '[760,1750][1120,1900]',
        },
        children: [],
      },
    ],
  };
}

function buildRecoveryLayout() {
  return {
    attributes: { bounds: '[0,0][1256,2760]' },
    children: [
      {
        attributes: {
          text: '快速会议',
          originalText: '快速会议',
          bounds: '[400,780][570,840]',
        },
        children: [],
      },
      {
        attributes: {
          text: '加入会议',
          originalText: '加入会议',
          bounds: '[70,780][240,840]',
        },
        children: [],
      },
      {
        attributes: {
          text: '取消',
          originalText: '取消',
          bounds: '[168,1469][598,1665]',
        },
        children: [],
      },
      {
        attributes: {
          text: '恢复',
          originalText: '恢复',
          bounds: '[683,1469][1113,1665]',
        },
        children: [],
      },
    ],
  };
}

function buildPermissionLayout() {
  return {
    attributes: { bounds: '[0,0][1256,2760]' },
    children: [
      {
        attributes: {
          text: '允许',
          originalText: '允许',
          bounds: '[70,2075][1210,2243]',
        },
        children: [],
      },
      {
        attributes: {
          text: '确定',
          originalText: '确定',
          bounds: '[56,2538][1224,2678]',
        },
        children: [],
      },
    ],
  };
}

function buildEndDialogLayout() {
  return {
    attributes: { bounds: '[0,0][1256,2760]' },
    children: [
      {
        attributes: {
          text: '结束会议',
          originalText: '结束会议',
          bounds: '[430,2240][830,2390]',
        },
        children: [],
      },
    ],
  };
}

function buildLeaveMeetingDialogLayout() {
  return {
    attributes: { bounds: '[0,0][1280,2832]' },
    children: [
      {
        attributes: {
          text: '确定离开会议吗？',
          originalText: '确定离开会议吗？',
          bounds: '[416,2244][864,2310]',
        },
        children: [],
      },
      {
        attributes: {
          text: '离开会议',
          originalText: '离开会议',
          bounds: '[528,2417][752,2483]',
        },
        children: [],
      },
    ],
  };
}

function zeroTimings() {
  return {
    afterOverlayDismissMs: 0,
    afterStopMs: 0,
    afterLaunchMs: 0,
    afterRecoveryDismissMs: 0,
    afterQuickMeetingTapMs: 0,
    afterJoinMeetingTapMs: 0,
    afterMeetingIdInputMs: 0,
    afterPasswordInputMs: 0,
    afterCameraTapMs: 0,
    afterEnterMeetingMs: 0,
    afterPermissionChoiceMs: 0,
    afterPermissionConfirmMs: 0,
    stateTimeoutMs: 0,
    pollIntervalMs: 0,
    shareStepDelayMs: 0,
    shareDialogTimeoutMs: 0,
    afterShareConfirmMs: 0,
    afterEndDialogMs: 0,
    afterEndConfirmMs: 0,
  };
}

async function writeTrajectory(root, segments, metadata) {
  const directory = join(root, ...segments);
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'trajectory.json');
  await writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return file;
}

async function waitForManagerTask(manager, taskId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const task = manager.snapshot(taskId);
    if (['completed', 'failed', 'blocked', 'stopped'].includes(task.status)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`TaskManager timed out for ${taskId}`);
}

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

function paintRect(data, width, channels, [x1, y1, x2, y2], color) {
  for (let y = y1; y < y2; y += 1) {
    for (let x = x1; x < x2; x += 1) {
      const offset = (y * width + x) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        data[offset + channel] = color[channel];
      }
    }
  }
}
