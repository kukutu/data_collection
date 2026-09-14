import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executeMeetimeVoipCall,
  inspectMeetimeCall,
  normalizeMeetimePhoneNumber,
} from '../server/src/skills/meetime-voip.js';
import { parseTaskFallback } from '../server/src/task-parser.js';
import { applyWorkflowParameters } from '../server/src/harness.js';
import { evaluateSafety } from '../server/src/safety.js';
import { getWorkflowCatalog } from '../server/src/workflow-registry.js';

const screen = { width: 1280, height: 2832 };
const app = {
  id: 'meetime',
  name: '畅连',
  aliases: ['畅连', '畅联', '畅联通话'],
  packageName: 'com.huawei.meetime',
  harmonyBundleName: 'com.huawei.hmos.meetime',
};
const number = '13145650791';

function node(id, text = '', bounds = '[0,0][1,1]', clickable = false) {
  return { attributes: { id, text, originalText: text, bounds, clickable }, children: [] };
}

function snapshot(children) {
  return { layout: { children } };
}

function dialerSnapshot(entered = '') {
  const coords = {
    1: '[153,1446][349,1642]', 2: '[542,1446][738,1642]', 3: '[932,1446][1128,1642]',
    4: '[153,1656][349,1852]', 5: '[542,1656][738,1852]', 6: '[932,1656][1128,1852]',
    7: '[153,1866][349,2062]', 8: '[542,1866][738,2062]', 9: '[932,1866][1128,2062]',
    0: '[542,2076][738,2272]',
  };
  const buttons = Object.entries(coords).map(([digit, bounds]) =>
    node(`Dialer_DialButton${digit}`, '', bounds, true));
  return snapshot([
    node('DialOperatePanel_telNumberInput', entered, '[84,248][1196,423]', true),
    node('floating_button_dial', '', '[542,2286][738,2482]', true),
    ...buttons,
  ]);
}

function callSnapshot(state) {
  if (state === 'ended') return snapshot([]);
  if (state === 'ringing') {
    return snapshot([
      node('callui_normalCallUI_Stack'),
      node('contactCard_column', `${number}, 安徽合肥 联通, 对方已振铃`, '[56,517][1224,794]'),
    ]);
  }
  if (state === 'video') {
    return snapshot([
      node('callui_normalCallUI_Stack'),
      node('contactCard_column', `${number}, 安徽合肥 联通, 00:03`, '[56,428][1224,705]'),
      node('hangUp', '', '[352,2426][634,2692]', true),
      node('videoMute', '', '[647,2426][929,2692]', true),
      node('speaker', '', '[943,2426][1225,2692]', true),
    ]);
  }
  return snapshot([
    node('callui_normalCallUI_Stack'),
    node('contactCard_column', `${number}, 安徽合肥 联通, 00:03`, '[56,517][1224,794]'),
    node('video', '视频通话', '[152,2066][377,2371]', true),
    node('', '', '[528,2440][752,2664]', true),
  ]);
}

test('畅连 only exposes one audio workflow with optional video', () => {
  const workflows = getWorkflowCatalog([{ ...app, installed: true }])
    .filter((workflow) => workflow.appId === 'meetime');
  assert.deepEqual(workflows.map((workflow) => workflow.id), ['voip:meetime:audio-call']);
  assert.deepEqual(workflows[0].params.map((parameter) => parameter.id), ['phoneNumber', 'duration', 'video', 'repeatCount', 'repeatInterval']);
  assert.equal(workflows[0].params.find((parameter) => parameter.id === 'video').defaultValue, false);
});

test('畅连 parser and workflow parameters preserve the phone number and optional video', () => {
  assert.equal(normalizeMeetimePhoneNumber('131 4565 0791'), number);
  const parsed = parseTaskFallback('畅联通话拨打13145650791视频通话5秒', [app]);
  assert.equal(parsed.intent, 'meetime_voip_call');
  assert.equal(parsed.phoneNumber, number);
  assert.equal(parsed.video, true);
  const shortcut = applyWorkflowParameters({}, {
    workflowId: 'voip:meetime:audio-call',
    parameters: { phoneNumber: number, video: true, duration: { amount: 5, unit: '秒' } },
  });
  assert.equal(shortcut.callType, 'video');
  assert.equal(shortcut.durationMs, 5000);
  assert.equal(evaluateSafety(shortcut).allowed, true);
});

test('畅连 call inspection distinguishes ringing, connected audio, and connected video', () => {
  assert.equal(inspectMeetimeCall(callSnapshot('ringing')).connected, false);
  assert.equal(inspectMeetimeCall(callSnapshot('connected')).connected, true);
  assert.equal(inspectMeetimeCall(callSnapshot('video')).video, true);
});

test('畅连 dials the supplied number, upgrades to video when requested, and hangs up', async () => {
  let state = 'dialer';
  let entered = '';
  let connectedPolls = 0;
  let clock = 0;
  const digitCenters = {
    1: [251, 1544], 3: [1030, 1544], 4: [251, 1754], 5: [640, 1754],
    6: [1030, 1754], 0: [640, 2174], 7: [251, 1964], 9: [1030, 1964],
  };
  const device = {
    async getDeviceStatus() { return { connected: true, platform: 'harmony', provider: 'hdc', serial: 'harmony-test', screen }; },
    async getScreenSize() { return screen; },
    async forceStopPackage() {},
    async launchPackage() {},
    async getUiTextSnapshot() {
      if (state === 'dialer') return dialerSnapshot(entered);
      if (state === 'ringing') {
        connectedPolls += 1;
        if (connectedPolls > 2) state = 'connected';
        return callSnapshot('ringing');
      }
      return callSnapshot(state);
    },
    async tap({ x, y }) {
      if (state === 'dialer') {
        const digit = Object.entries(digitCenters).find(([, [dx, dy]]) => Math.abs(x - dx) < 3 && Math.abs(y - dy) < 3)?.[0];
        if (digit) entered += digit;
        else if (Math.abs(x - 640) < 3 && y > 2250) state = 'ringing';
      } else if (state === 'connected' && x < 400 && y > 2000) {
        state = 'video';
      } else if (state === 'video' && x < 650 && y > 2350) {
        state = 'ended';
      }
    },
  };
  const result = await executeMeetimeVoipCall({
    device,
    app,
    phoneNumber: number,
    video: true,
    durationMs: 1000,
    timings: { afterLaunchMs: 0, afterDigitMs: 0, pollIntervalMs: 0, hangupSettleMs: 0, callStartTimeoutMs: 1000 },
    sleep: async () => {},
    now: () => { clock += 1000; return clock; },
  });
  assert.equal(entered, number);
  assert.equal(result.callType, 'video');
  assert.deepEqual(result.validationChecks.map((check) => check.id), [
    'device_connected', 'dialer_opened', 'number_entered', 'call_started',
    'call_connected', 'video_enabled', 'duration_observed', 'normal_hangup',
  ]);
  assert.equal(state, 'ended');
});
