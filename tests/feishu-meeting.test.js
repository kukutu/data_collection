import test from 'node:test';
import assert from 'node:assert/strict';
import { executeFeishuQuickMeeting, executeFeishuJoinMeeting, inspectFeishuMeeting, inspectFeishuCameraPixels } from '../server/src/skills/feishu-meeting.js';
import { getWorkflowDefinition } from '../server/src/workflow-registry.js';
import { applyWorkflowParameters } from '../server/src/harness.js';
import { parseTaskFallback } from '../server/src/task-parser.js';
import { evaluateSafety } from '../server/src/safety.js';

const app = { id: 'feishu', name: '飞书', aliases: ['飞书'], packageName: 'feishu.test' };
const node = (id, text = '', x = 100, extra = {}, children = []) => ({
  attributes: { id, text, bounds: `[${x},100][${x + 20},120]`, ...extra }, children,
});
const snap = children => ({ layout: { children }, values: children.map(n => n.attributes.text).filter(Boolean) });
const active = (camera, share) => snap([
  node('inMeetingPage_root_container'), node('', '00:12'), node('camera_p_id', '', 200),
  ...(camera ? [node('in_meeting_grid_swich_camera_id')] : []),
  node('', '更多', 300),
  ...(share ? [node('', '你正在共享屏幕'), node('', '停止共享')] : []),
  node('right_tool_bar_container', '', 400, {}, [node('', '', 400, { backgroundColor: '#FFF54A45' })]),
]);

test('Feishu detects meeting, camera and sharing without relying on chat text', () => {
  assert.equal(inspectFeishuMeeting(snap([node('', '00:12')])).active, false);
  assert.equal(inspectFeishuMeeting(active(false, false)).camera, false);
  assert.equal(inspectFeishuMeeting(active(true, true)).camera, true);
  assert.equal(inspectFeishuMeeting(active(true, true)).sharing, true);
});

for (const { desired, joining } of [{ desired: true }, { desired: false }, { desired: true, joining: true }, { desired: false, joining: true }]) {
  for (const cancel of [false, true]) {
    test(`Feishu join=${Boolean(joining)} camera/share=${desired} cancel=${cancel} checks state before capture and hangs up`, async () => {
      let state = 'home', camera = !desired, shared = false, clock = 0, captured;
      let left = false;
      const device = {
        async launchPackage() {},
        async getScreenSize() { return { width: 1280, height: 2832 }; },
        async getCurrentFocus() { return { packageName: app.packageName }; },
        async tapResource(id) { assert.equal(id, 'number_input'); },
        async inputText(value) { assert.equal(value, '254492170'); },
        async getUiTextSnapshot() {
          if (state === 'active') return active(camera, shared);
          return { home: snap([node('', '更多')]), more: snap([node('', '视频会议')]),
            meetings: snap([node('', joining ? '加入会议' : '发起会议'), node('', '发起会议')]),
            ready: snap([node('', joining ? '加入会议' : '开始会议'), node('number_input', '254 492 170')]),
            leave: snap([node('', '离开会议'), node('', '结束会议', 600)]),
            tools: snap([node('', '共享')]), share: snap([node('', '共享手机屏幕')]),
            permission: snap([node('', '允许“飞书”使用你的屏幕？'), node('', '允许')]),
          }[state];
        },
        async tap({ x }) {
          if (state === 'active') {
            if (x === 210) camera = !camera;
            else if (x === 310) state = 'tools';
            else if (x === 410) state = joining ? 'leave' : 'meetings';
            else throw new Error(`unexpected tap ${x}`);
          } else {
            if (state === 'leave') { assert.equal(x, 110); left = true; state = 'meetings'; return; }
            if (state === 'permission') shared = true;
            state = { home: 'more', more: 'meetings', meetings: 'ready', ready: 'active',
              tools: 'share', share: 'permission', permission: 'active' }[state];
          }
        },
      };
      const executor = joining ? executeFeishuJoinMeeting : executeFeishuQuickMeeting;
      const run = executor({ device, app, camera: desired, shareScreen: desired, durationMs: 5000, meetingId: '254 492 170',
        inspectCamera: async () => camera,
        now: () => clock, sleep: async ms => {
          if (cancel && captured !== undefined) throw new Error('cancelled');
          clock += ms;
        },
        startCapture: async () => { assert.equal(camera, desired); assert.equal(shared, desired); captured = clock; },
      });
      if (cancel) await assert.rejects(run, /cancelled/);
      else { await run; assert.equal(clock - captured, 5000); }
      assert.equal(state, 'meetings');
      if (joining) assert.equal(left, true);
    });
  }
}

test('Feishu quick meeting uses the shared recording/shortcut parameters and dedicated routing', () => {
  const w = getWorkflowDefinition('meeting:feishu:quick-meeting');
  assert.equal(w.status, 'verified');
  assert.deepEqual(w.params.map(p => p.id), ['duration', 'camera', 'shareScreen']);
  const task = applyWorkflowParameters({}, { workflowId: w.id, parameters: {
    duration: { amount: 5, unit: '秒' }, camera: true, shareScreen: true,
  } });
  assert.equal(task.intent, 'feishu_quick_meeting');
  assert.equal(task.durationMs, 5000);
  assert.equal(task.camera, true);
  assert.equal(task.shareScreen, true);
  assert.equal(evaluateSafety(task).allowed, true);
  assert.equal(parseTaskFallback('飞书快速会议5秒', [app]).intent, task.intent);
});

test('Feishu join has independent parameters, preserves spaced ID and rejects missing ID', async () => {
  const w = getWorkflowDefinition('meeting:feishu:join-meeting');
  assert.equal(w.status, 'verified');
  assert.deepEqual(w.params.map(p => p.id), ['meetingId', 'duration', 'camera', 'shareScreen']);
  const parsed = parseTaskFallback('飞书加入会议 会议号254 492 170 5秒', [app]);
  assert.equal(parsed.meetingId, '254492170');
  assert.equal(parsed.durationMs, 5000);
  assert.equal(parsed.intent, 'feishu_join_meeting');
  assert.equal(evaluateSafety(parsed).allowed, true);
  assert.equal(parseTaskFallback('飞书加入会议', [app]).intent, 'missing_parameter');
  assert.equal(applyWorkflowParameters({}, { workflowId: w.id, parameters: { meetingId: '254 492 170' } }).meetingId, '254492170');
  await assert.rejects(executeFeishuJoinMeeting({ app, device: {}, meetingId: '' }), /9位/);
});

test('Feishu camera uses the scaled icon crop, red means off and gray means on', () => {
  for (const [rgb, expected] of [[[245, 74, 69], false], [[80, 85, 90], true]]) {
    const data = Buffer.alloc(10 * 10 * 3);
    for (let i = 0; i < data.length; i++) data[i] = rgb[i % 3];
    assert.equal(inspectFeishuCameraPixels({ data, width: 10, height: 10, channels: 3 },
      '[0,0][20,20]', { width: 20, height: 20 }), expected);
  }
});
