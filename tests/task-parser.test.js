import test from 'node:test';
import assert from 'node:assert/strict';

import { loadApps } from '../server/src/app-registry.js';
import { parseTaskFallback } from '../server/src/task-parser.js';

const apps = loadApps();

test('parses Tencent Video watch tasks as playback sessions', () => {
  const parsed = parseTaskFallback('看10分钟腾讯视频', apps);

  assert.equal(parsed.intent, 'play_tencent_video');
  assert.equal(parsed.appName, '腾讯视频');
  assert.equal(parsed.durationMs, 10 * 60 * 1000);
  assert.equal(parsed.openFirstAvailable, true);
});

test('parses non-implemented long-video watch tasks as unsupported flows', () => {
  const parsed = parseTaskFallback('看10分钟爱奇艺', apps);

  assert.equal(parsed.intent, 'unsupported_flow');
  assert.equal(parsed.appName, '爱奇艺');
});

test('parses meeting tasks as unsupported flows', () => {
  const meeting = parseTaskFallback('保持5分钟腾讯会议', apps);
  const meetingWithUrl = parseTaskFallback('用腾讯会议加入会议 https://meeting.tencent.com/dm/abc 5分钟', apps);
  const voip = parseTaskFallback('测试1分钟微信音视频通话', apps);

  assert.equal(meeting.intent, 'unsupported_flow');
  assert.equal(meeting.appName, '腾讯会议');
  assert.match(meeting.reason, /会议业务/);
  assert.equal(meetingWithUrl.intent, 'unsupported_flow');
  assert.equal(meetingWithUrl.appName, '腾讯会议');
  assert.match(meetingWithUrl.reason, /会议业务/);
  assert.equal(voip.intent, 'unsupported_flow');
  assert.equal(voip.appName, '微信');
});

test('parses explicit WeChat audio and video calls to the first conversation', () => {
  const audio = parseTaskFallback('在微信向第一个联系人发起音频通话 2分钟', apps);
  const video = parseTaskFallback('在微信向第一个联系人发起视频通话', apps);

  assert.deepEqual(audio, {
    intent: 'wechat_voip_call',
    appName: '微信',
    targetMode: 'first',
    callType: 'audio',
    durationMs: 2 * 60 * 1000,
  });
  assert.deepEqual(video, {
    intent: 'wechat_voip_call',
    appName: '微信',
    targetMode: 'first',
    callType: 'video',
    durationMs: 30 * 1000,
  });
});

test('parses unimplemented upload/download tasks as unsupported flows', () => {
  const download = parseTaskFallback('测试2分钟百度网盘下载', apps);

  assert.equal(download.intent, 'baidu_netdisk_download');
  assert.equal(download.appName, '百度网盘');
});

test('requires destination for AMap navigation and parses destination when present', () => {
  const missingDestination = parseTaskFallback('运行3分钟高德地图导航', apps);
  const navigation = parseTaskFallback('运行4秒高德地图导航到北京站', apps);

  assert.equal(missingDestination.intent, 'missing_parameter');
  assert.equal(missingDestination.field, 'destination');
  assert.equal(navigation.intent, 'amap_navigation');
  assert.equal(navigation.appName, '高德地图');
  assert.equal(navigation.destination, '北京站');
  assert.equal(navigation.durationMs, 4000);
});

test('parses installed actual app-specific sessions', () => {
  const qq = parseTaskFallback('测试1分钟QQ音视频通话', apps);
  const ai = parseTaskFallback('和千问聊天5分钟', apps);

  assert.equal(qq.intent, 'unsupported_flow');
  assert.equal(ai.intent, 'ai_chat');
});

test('parses Kuaishou live browsing as a supported live entry task', () => {
  const parsed = parseTaskFallback('看30秒快手直播', apps);

  assert.equal(parsed.intent, 'live_entry');
  assert.equal(parsed.appName, '快手');
  assert.equal(parsed.durationMs, 30 * 1000);
});

test('parses iQiyi live browsing as a supported live entry task', () => {
  const parsed = parseTaskFallback('看30秒爱奇艺直播，每5秒下滑一次', apps);

  assert.equal(parsed.intent, 'live_entry');
  assert.equal(parsed.appName, '爱奇艺');
  assert.equal(parsed.durationMs, 30 * 1000);
  assert.equal(parsed.switchIntervalMs, 5 * 1000);
});

test('parses AI chat with a short default interval and keeps explicit intervals', () => {
  const defaultInterval = parseTaskFallback('和千问聊天', apps);
  const explicitInterval = parseTaskFallback('和千问聊天 每5秒', apps);

  assert.equal(defaultInterval.intent, 'ai_chat');
  assert.equal(defaultInterval.intervalMs, 8000);
  assert.equal(explicitInterval.intent, 'ai_chat');
  assert.equal(explicitInterval.intervalMs, 5000);
});

test('parses DeepSeek chat through the shared AI chat intent', () => {
  const parsed = parseTaskFallback('和DeepSeek聊天5分钟 每8秒', apps);

  assert.equal(parsed.intent, 'ai_chat');
  assert.equal(parsed.appName, 'DeepSeek');
  assert.equal(parsed.durationMs, 5 * 60 * 1000);
  assert.equal(parsed.intervalMs, 8000);
  assert.equal(parsed.language, 'en');
});

test('parses Qianwen chat through its dedicated skill', () => {
  const parsed = parseTaskFallback('和千问聊天7秒 每4秒发送一次', apps);

  assert.equal(parsed.intent, 'ai_chat');
  assert.equal(parsed.appName, '千问');
  assert.equal(parsed.durationMs, 7000);
  assert.equal(parsed.intervalMs, 4000);
  assert.equal(parsed.language, 'en');
});

test('parses Xiaoyi chat through its dedicated skill', () => {
  const parsed = parseTaskFallback('和小艺聊天7秒 每4秒发送一次', apps);

  assert.equal(parsed.intent, 'ai_chat');
  assert.equal(parsed.appName, '小艺');
  assert.equal(parsed.durationMs, 7000);
  assert.equal(parsed.intervalMs, 4000);
  assert.equal(parsed.language, 'en');
});

test('parses common WeChat Channels wording even when user says 微信号视频', () => {
  const parsed = parseTaskFallback('刷30秒微信号视频', apps);

  assert.equal(parsed.intent, 'wechat_channels_feed');
  assert.equal(parsed.appName, '微信');
  assert.equal(parsed.durationMs, 30 * 1000);
});

test('parses WeChat message loops for the first conversation', () => {
  const parsed = parseTaskFallback('在微信向第一个会话循环发消息 2分钟 每5秒发送一次', apps);

  assert.equal(parsed.intent, 'wechat_send_messages');
  assert.equal(parsed.appName, '微信');
  assert.equal(parsed.durationMs, 2 * 60 * 1000);
  assert.equal(parsed.intervalMs, 5000);
  assert.equal(parsed.targetMode, 'first');
});

test('parses WeChat media sending for the first conversation and first media item', () => {
  const parsed = parseTaskFallback(
    '打开微信向聊天列表第一个会话发送第一项图片或视频',
    apps,
  );

  assert.equal(parsed.intent, 'wechat_send_media');
  assert.equal(parsed.appName, '微信');
  assert.equal(parsed.targetMode, 'first');
  assert.equal(parsed.mediaIndex, 0);
  assert.equal(parsed.sendMode, 'count');
  assert.equal(parsed.sendCount, 1);
  assert.equal(parsed.durationMs, null);
  assert.equal(parsed.intervalMs, 8000);
});

test('parses WeChat media loops by count or duration', () => {
  const byCount = parseTaskFallback(
    '在微信向第一个会话发送第一项图片或视频 3次 每8秒发送一次',
    apps,
  );
  const byDuration = parseTaskFallback(
    '在微信向第一个会话循环发送第一项图片或视频 2分钟 每5秒发送一次',
    apps,
  );

  assert.equal(byCount.sendMode, 'count');
  assert.equal(byCount.sendCount, 3);
  assert.equal(byCount.durationMs, null);
  assert.equal(byCount.intervalMs, 8000);
  assert.equal(byDuration.sendMode, 'duration');
  assert.equal(byDuration.sendCount, null);
  assert.equal(byDuration.durationMs, 2 * 60 * 1000);
  assert.equal(byDuration.intervalMs, 5000);
});
