import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWecomVoipCall, firstWecomConversation, wecomCallButton, inspectWecomCall } from '../server/src/skills/wecom-voip.js';
import { getWorkflowDefinition } from '../server/src/workflow-registry.js';
import { applyWorkflowParameters } from '../server/src/harness.js';
import { parseTaskFallback } from '../server/src/task-parser.js';
import { evaluateSafety } from '../server/src/safety.js';

const app = { id: 'wecom', name: '企业微信', aliases: ['企业微信'], packageName: 'wecom.test' };
const n = (id, text, x, y, extra = {}) => ({ attributes: { id, text, bounds: `[${x},${y}][${x + 80},${y + 80}]`, ...extra } });
const snap = children => ({ layout: { children }, values: children.map(n => n.attributes.text).filter(Boolean) });
const home = snap([n('conv_item_1', 'first', 100, 400), n('conv_item_2', 'second', 100, 600)]);
const control = (label, x) => [n('', '', x, 600, { type: 'Button', clickable: 'true' }), n('', label, x, 700)];
const active = (camera, shared, connected = true) => snap([
  n('', connected ? '00:01' : '正在呼叫', 0, 0), ...control('挂断', shared ? 900 : 100),
  ...control(camera ? '摄像头已开' : '摄像头已关', 300), ...control('演示屏幕', 500),
  ...(shared ? [n('', '你正在演示屏幕', 0, 100), n('', '结束演示', 0, 200)] : []),
]);

test('WeCom selects first conversation and follows the hangup icon when sharing changes layout', () => {
  assert.equal(firstWecomConversation(home).text, 'first');
  assert.equal(wecomCallButton(active(false, false), '挂断').box.x, 140);
  assert.equal(wecomCallButton(active(true, true), '挂断').box.x, 940);
  assert.equal(inspectWecomCall(active(false, false, false)).connected, false);
  assert.equal(inspectWecomCall(snap([n('', '00:01', 0, 0)])).connected, false);
});

for (const { callType, desired, cancel } of [
  { callType: 'audio', desired: false }, { callType: 'video', desired: true },
  { callType: 'video', desired: false }, { callType: 'video', desired: true, cancel: true },
]) {
  test(`WeCom ${callType} options=${desired} cancel=${Boolean(cancel)} connects before capture and hangs up`, async () => {
    let state = 'home', camera = !desired, sharing = false, clock = 0, captured, reads = 0;
    let pendingCamera, cameraReads = 0;
    const device = {
      async launchPackage() {},
      async getCurrentFocus() { return { packageName: app.packageName }; },
      async getUiTextSnapshot() {
        if (pendingCamera !== undefined && --cameraReads <= 0) {
          camera = pendingCamera;
          pendingCamera = undefined;
        }
        if (state === 'active') return active(camera, sharing, reads++ > 0);
        return { home, chat: snap([n('MsgBottomAdd', '', 100, 400)]),
          menu: snap([n('', '语音通话', 100, 400)]),
          choose: snap([n('', '语音通话', 100, 400), n('', '视频通话', 300, 400)]),
          permission: snap([n('', '允许“企业微信”使用你的屏幕？', 0, 100), n('', '允许', 100, 400)]),
        }[state];
      },
      async tap({ x }) {
        if (state === 'choose') { assert.equal(x, callType === 'audio' ? 140 : 340); state = 'active'; }
        else if (state === 'active') {
          if (x === 340) { pendingCamera = !camera; cameraReads = 2; }
          else if (x === 540) state = 'permission';
          else { assert.equal(x, sharing ? 940 : 140); state = 'chat'; }
        } else {
          if (state === 'permission') sharing = true;
          state = { home: 'chat', chat: 'menu', menu: 'choose', permission: 'active' }[state];
        }
      },
    };
    const run = executeWecomVoipCall({ device, app, callType, camera: desired, shareScreen: desired, durationMs: 5000,
      now: () => clock, sleep: async ms => { if (cancel && captured !== undefined) throw new Error('cancelled'); clock += ms; },
      startCapture: async () => { assert.ok(reads > 1); assert.equal(camera, desired); assert.equal(sharing, desired); captured = clock; },
    });
    if (cancel) await assert.rejects(run, /cancelled/);
    else { await run; assert.equal(clock - captured, 5000); }
    assert.equal(state, 'chat');
  });
}

test('WeCom shortcut and text parsing keep first contact and video-only options', () => {
  for (const callType of ['audio', 'video']) {
    const w = getWorkflowDefinition(`voip:wecom:${callType}-call`);
    assert.deepEqual(w.params.map(p => p.id), callType === 'audio' ? ['duration'] : ['duration', 'camera', 'shareScreen']);
    const parsed = applyWorkflowParameters({}, { workflowId: w.id, parameters: { camera: true, shareScreen: true } });
    assert.equal(parsed.intent, 'wecom_voip_call');
    assert.equal(parsed.camera, callType === 'video');
    assert.equal(evaluateSafety(parsed).allowed, true);
    assert.equal(evaluateSafety({ ...parsed, targetMode: 'named' }).allowed, false);
  }
  assert.equal(parseTaskFallback('企业微信视频通话5秒', [app]).intent, 'wecom_voip_call');
});
