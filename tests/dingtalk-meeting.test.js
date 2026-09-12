import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDingtalkQuickMeeting, executeDingtalkJoinMeeting, inspectDingtalkMeeting } from '../server/src/skills/dingtalk-meeting.js';
import { getWorkflowDefinition } from '../server/src/workflow-registry.js';
import { applyWorkflowParameters } from '../server/src/harness.js';
import { parseTaskFallback } from '../server/src/task-parser.js';
import { evaluateSafety } from '../server/src/safety.js';

const app = { id: 'dingtalk', name: '钉钉', aliases: ['钉钉'], packageName: 'ding.test' };
test('Dingtalk exposes type, duration, conditional camera and common sharing parameters', () => {
  const w = getWorkflowDefinition('meeting:dingtalk:quick-meeting');
  assert.equal(w.status, 'verified');
  assert.deepEqual(w.params.map(p => p.id), ['meetingType', 'duration', 'camera', 'shareScreen']);
  assert.deepEqual(w.params.find(p => p.id === 'camera').visibleWhen, { parameterId: 'meetingType', equals: 'video' });
  const parsed = applyWorkflowParameters({}, { workflowId: w.id, parameters: {
    meetingType: 'audio', camera: true, shareScreen: true, duration: { amount: 5, unit: '秒' },
  } });
  assert.equal(parsed.camera, false);
  assert.equal(parsed.shareScreen, true);
  assert.equal(parsed.durationMs, 5000);
  assert.equal(evaluateSafety(parsed).allowed, true);
  assert.equal(parseTaskFallback('钉钉发起语音会议5秒', [app]).meetingType, 'audio');
});

for (const { meetingType, shareScreen, enableCamera, cancel, joining } of [
  { meetingType: 'audio', shareScreen: true, enableCamera: true },
  { meetingType: 'video', shareScreen: true, enableCamera: true },
  { meetingType: 'video', shareScreen: false, enableCamera: false },
  { meetingType: 'video', shareScreen: true, enableCamera: true, cancel: true },
  { meetingType: 'video', shareScreen: true, enableCamera: true, joining: true },
  { meetingType: 'video', shareScreen: false, enableCamera: false, joining: true, cancel: true },
]) {
  test(`Dingtalk ${meetingType} join=${Boolean(joining)} share=${shareScreen} camera=${enableCamera} cancel=${Boolean(cancel)} ends normally`, async () => {
    let state = 'home', camera = meetingType === 'video' && !enableCamera, sharing = false, clock = 0, captureAt;
    const taps = [];
    let activeReads = 0;
    const device = {
      async launchPackage() {},
      async getScreenSize() { return { width: 1280, height: 2832 }; },
      async getCurrentFocus() { return { packageName: app.packageName }; },
      async tap() {},
      async tapResource(id) { assert.equal(id, 'tele_join_conf_room_code_input'); },
      async inputText(text) { assert.equal(text, '9997799059'); },
      async getUiTextSnapshot() {
        if (state === 'active' && joining && activeReads++ === 0) {
          return { values: ['离开', '00:01'] };
        }
        return { values: {
          home: ['更多'], more: ['会议'], meetings: ['发起会议'], type: ['视频会议', '语音会议'],
          ready: ['进入会议', '999 779 905 9'], end: ['结束会议', '全员结束会议', ...(joining ? ['仅自己离开'] : [])],
          active: [joining ? '离开' : '结束', '00:12', camera ? '关摄像头' : '开摄像头', '共享', ...(sharing ? ['停止共享'] : [])],
          share: ['共享屏幕'], warning: ['发起屏幕共享', '我知道了'],
          permission: ['选择共享内容', '开始共享', '“钉钉”将投射/录制您屏幕上正在显示的内容。'],
        }[state] };
      },
      async tapText(text) {
        taps.push(text);
        if (text === '开摄像头') camera = true;
        else if (text === '关摄像头') camera = false;
        else if (text === '开始共享') { sharing = true; state = 'active'; }
        else state = { 更多: 'more', 会议: 'meetings', 发起会议: 'type', 视频会议: 'ready',
          语音会议: 'ready', 进入会议: 'active', 共享: 'share', 共享屏幕: 'warning',
          我知道了: 'permission', 结束: 'end', 离开: 'end', 仅自己离开: 'meetings', 全员结束会议: 'meetings', 加入会议: 'ready' }[text];
      },
    };
    const executor = joining ? executeDingtalkJoinMeeting : executeDingtalkQuickMeeting;
    const run = executor({ device, app, meetingType, camera: enableCamera, meetingId: '9997799059',
      shareScreen, durationMs: 5000, now: () => clock, sleep: async ms => {
        if (cancel && captureAt !== undefined) throw new Error('cancelled');
        clock += ms;
      },
      startCapture: async () => { assert.equal(sharing, shareScreen); assert.equal(camera, meetingType === 'video' && enableCamera); captureAt = clock; },
    });
    if (cancel) await assert.rejects(run, /cancelled/);
    else {
      const result = await run;
      assert.equal(clock - captureAt, 5000);
      assert.equal(result.validationChecks.at(-1).status, 'passed');
    }
    assert.equal(state, 'meetings');
    assert.equal(taps.includes('添加参会成员'), false);
    if (joining) {
      assert.equal(taps.includes('全员结束会议'), false);
      assert.equal(taps.includes('仅自己离开'), true);
    }
  });
}

test('Dingtalk recognizes logout and refuses to treat the preparation page as connected', () => {
  assert.equal(inspectDingtalkMeeting({ values: ['进入会议'] }).active, false);
  assert.equal(inspectDingtalkMeeting({ values: ['下一步', '我已阅读并同意服务协议、隐私权政策'] }).loggedOut, true);
});

test('Dingtalk join parsing keeps meeting ID separate from duration', () => {
  const parsed = parseTaskFallback('钉钉加入会议 会议号9997799059 5秒', [app]);
  assert.equal(parsed.meetingId, '9997799059');
  assert.equal(parsed.durationMs, 5000);
  assert.equal(evaluateSafety(parsed).allowed, true);
  const w = getWorkflowDefinition('meeting:dingtalk:join-meeting');
  assert.equal(w.status, 'verified');
  assert.deepEqual(w.params.map(p => p.id), ['meetingId', 'duration', 'camera', 'shareScreen']);
  assert.equal(applyWorkflowParameters({}, { workflowId: w.id, parameters: { meetingId: '999-779-9059' } }).meetingId, '9997799059');
});
