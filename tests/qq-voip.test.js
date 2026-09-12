import test from 'node:test';
import assert from 'node:assert/strict';
import { executeQqVoipCall, inspectQqCall, firstQqConversation } from '../server/src/skills/qq-voip.js';
import { parseTaskFallback } from '../server/src/task-parser.js';
import { applyWorkflowParameters } from '../server/src/harness.js';
import { evaluateSafety } from '../server/src/safety.js';
import { getWorkflowDefinition } from '../server/src/workflow-registry.js';

const n = (id, text = '', bounds = '[100,100][200,200]', children = []) => ({ attributes: { id, text, bounds }, children });
const s = (...children) => ({ layout: { children } });
const app = { id: 'qq', name: 'QQ', aliases: ['QQ'], packageName: 'qq.test' };
const screen = { width: 1280, height: 2832 };

test('both real-device-tested QQ call workflows are enabled', () => {
  for (const type of ['audio', 'video']) {
    assert.equal(getWorkflowDefinition(`voip:qq:${type}-call`).status, 'verified');
  }
});
const home = s(n('', '', '[0,481][1280,711]', [n('msg_time', '12:00')]),
  n('', '', '[0,711][1280,941]', [n('msg_time', '11:00')]));
const chat = s(n('aio_root'), n('plus', '', '[1033,2625][1271,2715]'));
const menu = s(n('aio_root'), n('', '语音通话'), n('', '视频通话'));
const call = video => s(n('dav_id_5003:16064'), n('dav_id_5003:16406', '', '[583,2103][697,2487]', [n('', '00:01')]),
  ...(video ? [n('dav_id_5003:16250_camera_reverse')] : []));

test('QQ selects the first message row and separates active timers from chat history', () => {
  assert.equal(firstQqConversation(home, screen).bounds.y, 481);
  assert.equal(inspectQqCall(s(n('', '通话时长 00:18'))).connected, false);
  assert.equal(inspectQqCall(call(true)).video, true);
});

for (const type of ['audio', 'video']) {
  test(`QQ ${type} connects, observes duration, and hangs up even on cancellation`, async () => {
    for (const cancel of [false, true]) {
      let state = 'home', clock = 0, captureAt, hungup = false;
      const device = {
        async getScreenSize() { return screen; },
        async getCurrentFocus() { return { packageName: app.packageName }; },
        async launchPackage() {},
        async getUiTextSnapshot() { return { home, chat, menu, call: call(type === 'video') }[state]; },
        async tap() {
          if (state === 'call') { hungup = true; state = 'chat'; }
          else state = { home: 'chat', chat: 'menu', menu: 'call' }[state];
        },
      };
      const run = executeQqVoipCall({ device, app, callType: type, durationMs: 2000,
        now: () => clock,
        sleep: async ms => { if (cancel && captureAt !== undefined) throw new Error('cancelled'); clock += ms; },
        startCapture: async () => { assert.equal(state, 'call'); captureAt = clock; },
      });
      if (cancel) await assert.rejects(run, /cancelled/);
      else { await run; assert.equal(clock - captureAt, 2000); }
      assert.equal(hungup, true);
    }
  });
}

test('QQ parser and shortcuts preserve type, first-conversation targeting and duration', () => {
  assert.equal(parseTaskFallback('QQ视频通话10秒', [app]).intent, 'qq_voip_call');
  const parsed = applyWorkflowParameters({}, { workflowId: 'voip:qq:audio-call', parameters: { duration: { amount: 5, unit: '秒' } } });
  assert.equal(parsed.callType, 'audio');
  assert.equal(parsed.durationMs, 5000);
  assert.equal(evaluateSafety(parsed).allowed, true);
  assert.equal(evaluateSafety({ ...parsed, targetMode: 'named' }).allowed, false);
});
