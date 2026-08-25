import test from 'node:test';
import assert from 'node:assert/strict';

import { loadApps } from '../server/src/app-registry.js';
import { parseTaskFallback } from '../server/src/task-parser.js';

const apps = loadApps();

test('parses installed generic media apps into playback sessions', () => {
  const bili = parseTaskFallback('看5分钟B站', apps);
  const youku = parseTaskFallback('播放4分钟优酷视频', apps);

  assert.equal(bili.intent, 'play_generic_media');
  assert.equal(bili.appName, 'B站');
  assert.equal(youku.intent, 'play_generic_media');
  assert.equal(youku.appName, '优酷视频');
});

test('parses WeChat Channels into a dedicated feed skill', () => {
  const parsed = parseTaskFallback('刷3分钟微信视频号', apps);

  assert.equal(parsed.intent, 'wechat_channels_feed');
  assert.equal(parsed.appName, '微信');
  assert.equal(parsed.durationMs, 3 * 60 * 1000);
});

test('parses XHS video alias as Xiaohongshu short video feed', () => {
  const parsed = parseTaskFallback('刷3分钟xhs视频', apps);

  assert.equal(parsed.intent, 'watch_feed');
  assert.equal(parsed.appName, '小红书');
  assert.equal(parsed.durationMs, 3 * 60 * 1000);
});

test('parses live tasks into live entry sessions instead of requiring manual room entry', () => {
  const taobao = parseTaskFallback('看4分钟淘宝直播', apps);
  const douyin = parseTaskFallback('看4分钟抖音直播', apps);
  const jd = parseTaskFallback('看4分钟京东直播', apps);
  const channelsLive = parseTaskFallback('看4分钟微信视频号直播', apps);
  const xhsLive = parseTaskFallback('看4分钟小红书直播', apps);
  const weibo = parseTaskFallback('看4分钟微博直播', apps);

  assert.equal(taobao.intent, 'live_entry');
  assert.equal(taobao.appName, '淘宝');
  assert.equal(taobao.durationMs, 4 * 60 * 1000);
  assert.equal(taobao.switchIntervalMs, null);
  assert.equal(douyin.intent, 'live_entry');
  assert.equal(douyin.appName, '抖音');
  assert.equal(jd.intent, 'live_entry');
  assert.equal(jd.appName, '京东');
  assert.equal(channelsLive.intent, 'live_entry');
  assert.equal(channelsLive.appName, '微信');
  assert.equal(xhsLive.intent, 'live_entry');
  assert.equal(xhsLive.appName, '小红书');
  assert.equal(weibo.intent, 'unsupported_flow');
  assert.match(weibo.reason, /微博当前没有稳定/);
});

test('parses explicit live switch interval when provided', () => {
  const parsed = parseTaskFallback('看30分钟微信直播，每3分钟下滑', apps);

  assert.equal(parsed.intent, 'live_entry');
  assert.equal(parsed.appName, '微信');
  assert.equal(parsed.durationMs, 30 * 60 * 1000);
  assert.equal(parsed.switchIntervalMs, 3 * 60 * 1000);
});

test('unsupported entry-only flows are not parsed as executable skills', () => {
  const meeting = parseTaskFallback('进入腾讯会议', apps);
  assert.equal(meeting.intent, 'unsupported_flow');
  assert.match(meeting.reason, /会议业务/);

  for (const text of ['测试2分钟百度网盘下载', '测试1分钟QQ音视频通话', '看4分钟大麦演出']) {
    const parsed = parseTaskFallback(text, apps);
    assert.equal(parsed.intent, 'unsupported_flow', text);
    assert.ok(parsed.reason, text);
  }
});
