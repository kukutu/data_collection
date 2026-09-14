import test from 'node:test';
import assert from 'node:assert/strict';

import { applyWorkflowParameters } from '../server/src/harness.js';
import {
  buildWechatVoipCorrectedSteps,
  executeWechatVoipCall,
  WECHAT_AUDIO_CALL_WORKFLOW_ID,
  WECHAT_VIDEO_CALL_WORKFLOW_ID,
  WECHAT_VOIP_VALIDATION_MODE,
} from '../server/src/skills/wechat-voip.js';

const APP = {
  id: 'wechat',
  name: '微信',
  packageName: 'com.tencent.mm',
  harmonyBundleName: 'com.tencent.wechat',
};

for (const [callType, workflowId] of [
  ['audio', WECHAT_AUDIO_CALL_WORKFLOW_ID],
  ['video', WECHAT_VIDEO_CALL_WORKFLOW_ID],
]) {
  test(`WeChat ${callType} call selects the correct type and hangs up normally`, async () => {
    const device = new FakeWechatVoipDevice();
    const waits = [];
    const result = await executeWechatVoipCall({
      device,
      app: APP,
      workflowId,
      callType,
      parameters: {
        duration: { amount: 12, unit: '秒' },
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
      timings: {
        afterLaunchMs: 0,
        afterConversationMs: 0,
        afterDetailsMs: 0,
        afterProfileMs: 0,
        afterTypeSheetMs: 0,
        callObservationMs: 0,
        controlsSettleMs: 0,
        hangupSettleMs: 0,
      },
    });

    assert.equal(result.validationMode, WECHAT_VOIP_VALIDATION_MODE);
    assert.equal(result.callType, callType);
    assert.equal(result.validationChecks.every((check) => check.status === 'passed'), true);
    assert.equal(device.selectedCallType, callType);
    assert.equal(device.state, 'profile');
    assert.equal(device.controlsRevealed, true);
    assert.equal(device.hangupCount, 1);
    assert.equal(result.effectiveDurationMs, 12_000);
    assert.equal(waits.includes(12_000), true);
    const physicalSteps = result.correctedSteps.filter((step) => step.type === 'tap');
    assert.equal(physicalSteps.length, 7);
    assert.equal(
      result.correctedSteps.filter((step) => step.type === 'assert_state').length,
      6,
    );
    assert.equal(
      result.correctedSteps.some(
        (step) =>
          step.type === 'hold_state' &&
          step.durationParameter === 'duration',
      ),
      true,
    );
    assert.equal(
      physicalSteps[4].normalizedY,
      callType === 'video' ? 0.755 : 0.831,
    );
  });
}

test('WeChat VoIP expands a collapsed video surface before hanging up', async () => {
  const device = new FakeWechatVoipDevice();
  const originalGetUiTextSnapshot = device.getUiTextSnapshot.bind(device);
  let callSnapshotReads = 0;
  device.getUiTextSnapshot = async () => {
    const current = await originalGetUiTextSnapshot();
    if (device.state === 'call' && ++callSnapshotReads >= 2) {
      return snapshot(
        ['切换画面'],
        node({ type: 'Button', text: '切换画面', bounds: '[755,252][1256,1110]' }),
      );
    }
    return current;
  };

  const result = await executeWechatVoipCall({
    device,
    app: APP,
    workflowId: WECHAT_VIDEO_CALL_WORKFLOW_ID,
    callType: 'video',
    parameters: { duration: { amount: 1, unit: '秒' } },
    sleep: async () => {},
    timings: {
      afterLaunchMs: 0,
      afterConversationMs: 0,
      afterDetailsMs: 0,
      afterProfileMs: 0,
      afterTypeSheetMs: 0,
      callObservationMs: 0,
      controlsSettleMs: 0,
      hangupSettleMs: 0,
    },
  });

  assert.equal(result.validationChecks.every((check) => check.status === 'passed'), true);
  assert.equal(device.hangupCount, 1);
  assert.equal(device.state, 'profile');
});

test('WeChat VoIP workflow parameters override the generic unsupported parser result', () => {
  assert.deepEqual(
    applyWorkflowParameters(
      { intent: 'unsupported_flow', reason: 'not implemented' },
      { workflowId: WECHAT_AUDIO_CALL_WORKFLOW_ID },
    ),
    {
      intent: 'wechat_voip_call',
      reason: 'not implemented',
      appName: '微信',
      targetMode: 'first',
      callType: 'audio',
      durationMs: 30 * 1000,
    },
  );
  assert.equal(
    applyWorkflowParameters(
      { intent: 'unsupported_flow' },
      {
        workflowId: WECHAT_VIDEO_CALL_WORKFLOW_ID,
        parameters: { duration: { amount: 2, unit: '分钟' } },
      },
    ).durationMs,
    2 * 60 * 1000,
  );
  assert.equal(
    applyWorkflowParameters(
      { intent: 'unsupported_flow' },
      { workflowId: WECHAT_VIDEO_CALL_WORKFLOW_ID },
    ).callType,
    'video',
  );
});

test('WeChat VoIP corrected coordinates retain normalized resolution data', () => {
  const steps = buildWechatVoipCorrectedSteps({ width: 1280, height: 2832 }, 'video');
  const physicalSteps = steps.filter((step) => step.type === 'tap');

  assert.deepEqual(
    physicalSteps.map((step) => [step.x, step.y]),
    [
      [640, 615],
      [1180, 212],
      [128, 450],
      [640, 1617],
      [786, 2138],
      [640, 1399],
      [644, 2444],
    ],
  );
  assert.equal(
    physicalSteps.every((step) => step.referenceScreen.width === 1280),
    true,
  );
});

class FakeWechatVoipDevice {
  constructor() {
    this.state = 'idle';
    this.selectedCallType = null;
    this.controlsRevealed = false;
    this.hangupCount = 0;
  }

  async getDeviceStatus() {
    return {
      connected: true,
      provider: 'hdc',
      platform: 'harmony',
      serial: 'harmony-1',
      screen: { width: 1280, height: 2832 },
    };
  }

  async forceStopPackage() {
    this.state = 'idle';
  }

  async launchPackage() {
    this.state = 'list';
  }

  async assertNoSensitivePrompt() {}

  async getCurrentFocus() {
    return {
      packageName: APP.packageName,
      bundleName: APP.harmonyBundleName,
      activity: 'EntryAbility',
    };
  }

  async tap({ x, y }) {
    if (this.state === 'list') {
      this.state = 'chat';
      return;
    }
    if (this.state === 'chat') {
      if (y >= 290) throw new Error('selected the contact avatar instead of chat details');
      this.state = 'details';
      return;
    }
    if (this.state === 'details') {
      this.state = 'profile';
      return;
    }
    if (this.state === 'profile') {
      this.state = 'sheet';
      return;
    }
    if (this.state === 'sheet') {
      this.selectedCallType = y < 2250 ? 'video' : 'audio';
      this.state = 'call';
      this.controlsRevealed = true;
      return;
    }
    if (this.state === 'call' && !this.controlsRevealed) {
      this.controlsRevealed = true;
      return;
    }
    if (this.state === 'call') {
      if (x >= 486 && x <= 766 && y >= 2223 && y <= 2566) {
        this.hangupCount += 1;
        this.state = 'profile';
      }
    }
  }

  async getUiTextSnapshot() {
    if (this.state === 'list') {
      return snapshot(
        ['微信', '通讯录', '发现', '我', '测试联系人'],
        node(
          { id: 'WechatMainNavigation', bounds: '[0,137][1280,2832]' },
          node({ text: '微信', bounds: '[550,171][706,254]' }),
          node({ text: '通讯录', bounds: '[300,2580][500,2700]' }),
          node({
            id: 'Title',
            text: '测试联系人',
            clickable: 'true',
            bounds: '[280,500][1180,700]',
          }),
        ),
      );
    }
    if (this.state === 'chat') {
      return snapshot(
        ['测试联系人'],
        node(
          { id: 'WechatMainNavigation', bounds: '[0,137][1280,2832]' },
          node({ id: 'chat_list', clickable: 'true', bounds: '[0,137][1280,2537]' }),
          node({ type: 'RichEditor', clickable: 'true', bounds: '[177,2566][953,2706]' }),
          node({ clickable: 'true', bounds: '[1098,257][1238,397]' }),
          node({ clickable: 'true', bounds: '[1084,137][1280,288]' }),
        ),
      );
    }
    if (this.state === 'details') {
      return snapshot(
        ['聊天详情', '测试联系人'],
        node(
          { bounds: '[0,0][1280,2832]' },
          node({ text: '聊天详情', bounds: '[521,172][759,255]' }),
          node({
            type: 'GridItem',
            clickable: 'true',
            bounds: '[0,332][256,573]',
          }),
        ),
      );
    }
    if (this.state === 'profile') {
      return snapshot(
        ['发消息', '音视频通话'],
        node(
          { bounds: '[0,0][1280,2832]' },
          node({ text: '发消息', bounds: '[600,1380][779,1463]' }),
          node(
            { type: 'Column', clickable: 'true', bounds: '[0,1520][1280,1717]' },
            node({ text: '音视频通话', bounds: '[540,1577][838,1660]' }),
          ),
        ),
      );
    }
    if (this.state === 'sheet') {
      return snapshot(
        ['发消息', '音视频通话', '视频通话', '语音通话', '取消'],
        node(
          { bounds: '[0,0][1280,2832]' },
          node(
            { type: 'Column', clickable: 'true', bounds: '[0,2061][1280,2257]' },
            node({ text: '视频通话', bounds: '[570,2117][808,2201]' }),
          ),
          node(
            { type: 'Column', clickable: 'true', bounds: '[0,2258][1280,2454]' },
            node({ text: '语音通话', bounds: '[570,2314][808,2398]' }),
          ),
          node(
            { type: 'Column', clickable: 'true', bounds: '[0,2482][1280,2832]' },
            node({ text: '取消', bounds: '[581,2482][700,2678]' }),
          ),
        ),
      );
    }
    if (this.state === 'call') {
      const typeValues =
        this.selectedCallType === 'video'
          ? ['摄像头已开', '翻转', '模糊背景']
          : ['扬声器已关'];
      const hangupText = this.selectedCallType === 'video' ? '挂断' : '取消';
      return snapshot(
        ['等待对方接受邀请', '麦克风已开', hangupText, ...typeValues],
        node(
          { clickable: 'true', bounds: '[0,0][1280,2832]' },
          node({
            'content-desc': hangupText,
            type: 'Button',
            clickable: 'false',
            bounds: '[486,2223][766,2566]',
          }),
        ),
      );
    }
    return snapshot([], node({ bounds: '[0,0][1280,2832]' }));
  }
}

function snapshot(values, layout) {
  return {
    text: values.join('\n'),
    values,
    layout,
  };
}

function node(attributes, ...children) {
  return {
    attributes,
    children,
  };
}
