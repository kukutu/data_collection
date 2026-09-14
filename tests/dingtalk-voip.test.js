import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDingtalkVoipCall, inspectDingtalkAudioCall } from '../server/src/skills/dingtalk-voip.js';
import { firstDingtalkConversation } from '../server/src/skills/dingtalk-call-entry.js';
import { getWorkflowDefinition } from '../server/src/workflow-registry.js';
import { applyWorkflowParameters } from '../server/src/harness.js';
import { parseTaskFallback } from '../server/src/task-parser.js';
import { evaluateSafety } from '../server/src/safety.js';

const app = { id: 'dingtalk', name: '钉钉', aliases: ['钉钉'], packageName: 'ding.test' };
const n = (id, text, y, children = [], extra = {}) => ({ attributes: { id, text, bounds: `[100,${y}][200,${y + 50}]`, ...extra }, children });
const snap = (children, values = []) => ({ layout: { children }, values });
const home = snap([n('home_tab_im_im', '消息', 2500), n('session_title', 'first', 800), n('session_title', 'second', 1000)]);
const chat = snap([n('chat_bar_menu_tele', '', 200)]);
const menu = snap([n('', '语音通话', 1200)]);
const call = connected => snap([n('control_button_audio_talk_row_2', '', 2300, [n('', '', 2400, [
  n('', '', 2450, [], { clickable: 'true' }), n('', '挂断', 2640),
])])], ['挂断', connected ? '00:01' : '正在呼叫中']);

test('Dingtalk targets first message row and uses hangup icon instead of nonclickable caption', () => {
  assert.equal(firstDingtalkConversation(home).text, 'first');
  assert.equal(inspectDingtalkAudioCall(call(false)).connected, false);
  assert.equal(inspectDingtalkAudioCall(call(true)).hangup.bounds, '[100,2450][200,2500]');
  assert.equal(inspectDingtalkAudioCall(snap([], ['通话时长 00:55'])).connected, false);
});

for (const cancel of [false, true]) {
  test(`Dingtalk audio waits for answer, counts time and cleans up cancel=${cancel}`, async () => {
    let state = 'home', clock = 0, captured, reads = 0;
    const device = {
      async launchPackage() {},
      async getCurrentFocus() { return { packageName: app.packageName }; },
      async getUiTextSnapshot() { return state === 'call' ? call(reads++ > 0) : { home, chat, menu }[state]; },
      async tap({ y }) {
        if (state === 'call') { assert.equal(y, 2475); state = 'chat'; }
        else state = { home: 'chat', chat: 'menu', menu: 'call' }[state];
      },
    };
    const run = executeDingtalkVoipCall({ device, app, callType: 'audio', durationMs: 5000,
      now: () => clock, sleep: async ms => { if (cancel && captured !== undefined) throw new Error('cancelled'); clock += ms; },
      startCapture: async () => { captured = clock; },
    });
    if (cancel) await assert.rejects(run, /cancelled/);
    else { await run; assert.ok(clock - captured >= 5000); }
    assert.equal(state, cancel ? 'menu' : 'chat');
  });
}

test('Dingtalk VoIP exposes video options, not contact parameters, and preserves first targeting', () => {
  for (const type of ['audio', 'video']) {
    const w = getWorkflowDefinition(`voip:dingtalk:${type}-call`);
    assert.equal(w.status, 'verified');
    assert.deepEqual(w.params.map(p => p.id), type === 'audio'
      ? ['duration', 'repeatCount', 'repeatInterval']
      : ['duration', 'camera', 'shareScreen', 'repeatCount', 'repeatInterval']);
    const parsed = applyWorkflowParameters({}, { workflowId: w.id, parameters: { camera: true, shareScreen: true } });
    assert.equal(parsed.callType, type);
    assert.equal(parsed.camera, type === 'video');
    assert.equal(evaluateSafety(parsed).allowed, true);
    assert.equal(evaluateSafety({ ...parsed, targetMode: 'named' }).allowed, false);
  }
  assert.equal(parseTaskFallback('钉钉视频通话5秒', [app]).intent, 'dingtalk_voip_call');
});

test('Dingtalk video waits for the peer to join rather than just its own meeting timer', async () => {
  let state = 'home', reads = 0, clock = 0, captured;
  const device = {
    async launchPackage() {},
    async getScreenSize() { return { width: 1280, height: 2832 }; },
    async getCurrentFocus() { return { packageName: app.packageName }; },
    async getUiTextSnapshot() {
      if (state === 'active') return snap([], ['结束', '00:01', '开摄像头', '成员', reads++ < 1 ? '1' : '2']);
      if (state === 'end') return snap([], ['结束', '全员结束会议']);
      return { home, chat, menu }[state];
    },
    async tap() { state = { home: 'chat', chat: 'menu' }[state]; },
    async tapText(text) { state = { 视频会议: 'active', 结束: 'end', 全员结束会议: 'chat' }[text]; },
  };
  const result = await executeDingtalkVoipCall({ device, app, callType: 'video', durationMs: 5000,
    now: () => clock, sleep: async ms => { clock += ms; },
    startCapture: async () => { captured = clock; },
  });
  assert.equal(result.validationMode, 'dingtalk_video_call_v1');
  assert.ok(clock - captured >= 5000);
  assert.equal(state, 'chat');
});
