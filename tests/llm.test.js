import test from 'node:test';
import assert from 'node:assert/strict';

import { loadApps } from '../server/src/app-registry.js';
import { buildTaskParserPrompt, parseModelJson, parseTaskWithCodexCli } from '../server/src/llm.js';

const apps = loadApps();

test('shared task parser prompt describes supported and unsupported flows', () => {
  const prompt = buildTaskParserPrompt({ taskText: '测试QQ音视频通话', apps });

  assert.match(prompt, /允许的 intent/);
  assert.match(prompt, /unsupported_flow/);
  assert.doesNotMatch(prompt, /meeting_link/);
  assert.match(prompt, /会议/);
  assert.match(prompt, /音视频通话/);
  assert.match(prompt, /wechat_send_messages/);
  assert.match(prompt, /wechat_send_media/);
  assert.match(prompt, /sendMode/);
  assert.match(prompt, /sendCount/);
  assert.match(prompt, /live_entry.*switchIntervalMs/);
  assert.match(prompt, /用户任务: 测试QQ音视频通话/);
});

test('parseModelJson accepts plain JSON and fenced JSON', () => {
  assert.deepEqual(parseModelJson('{"intent":"home"}'), { intent: 'home' });
  assert.deepEqual(parseModelJson('```json\n{"intent":"back"}\n```'), { intent: 'back' });
  assert.deepEqual(parseModelJson('{"intent":"home","appName":null}'), { intent: 'home' });
});

test('Codex CLI parser uses injected runner and parses JSON response', async () => {
  const parsed = await parseTaskWithCodexCli({
    taskText: '高德地图导航到北京站',
    apps,
    runCodex: async ({ prompt }) => {
      assert.match(prompt, /高德地图导航到北京站/);
      return JSON.stringify({
        intent: 'amap_navigation',
        appName: '高德地图',
        destination: '北京站',
        durationMs: 300000,
      });
    },
  });

  assert.equal(parsed.intent, 'amap_navigation');
  assert.equal(parsed.destination, '北京站');
});
