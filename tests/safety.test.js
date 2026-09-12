import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateSafety } from '../server/src/safety.js';

test('allows explicit video playback and navigation skills', () => {
  assert.equal(
    evaluateSafety({ intent: 'play_tencent_video', appName: '腾讯视频' }, '看腾讯视频').allowed,
    true,
  );
  assert.equal(
    evaluateSafety({ intent: 'amap_navigation', appName: '高德地图', destination: '北京站' }, '高德地图导航到北京站').allowed,
    true,
  );
});

test('allows app launch and real installed-app skills', () => {
  for (const parsed of [
    { intent: 'launch_app', appName: '支付宝' },
    { intent: 'ai_chat', appName: '千问', language: 'en' },
    { intent: 'wechat_send_messages', appName: '微信', targetMode: 'first' },
    { intent: 'wechat_send_media', appName: '微信', targetMode: 'first', mediaIndex: 0 },
    { intent: 'wechat_voip_call', appName: '微信', targetMode: 'first', callType: 'audio' },
    { intent: 'tencent_quick_meeting', appName: '腾讯会议' },
    { intent: 'tencent_join_meeting', appName: '腾讯会议', meetingId: '660-739-282' },
  ]) {
    assert.equal(evaluateSafety(parsed, `测试${parsed.appName}`).allowed, true, parsed.appName);
  }
});

test('rejects WeChat message targeting modes other than the first conversation', () => {
  const result = evaluateSafety(
    { intent: 'wechat_send_messages', appName: '微信', targetMode: 'named' },
    '微信发消息',
  );

  assert.equal(result.allowed, false);
  assert.match(result.reason, /第一个会话/);
});

test('rejects WeChat media targeting modes other than the first conversation', () => {
  const result = evaluateSafety(
    { intent: 'wechat_send_media', appName: '微信', targetMode: 'named' },
    '微信发视频',
  );

  assert.equal(result.allowed, false);
  assert.match(result.reason, /第一个会话/);
});

test('rejects WeChat calls targeting anything other than the first conversation', () => {
  const result = evaluateSafety(
    { intent: 'wechat_voip_call', appName: '微信', targetMode: 'named', callType: 'video' },
    '微信视频通话',
  );

  assert.equal(result.allowed, false);
  assert.match(result.reason, /第一个会话/);
});

test('blocks unsupported entry-only flows with a specific reason', () => {
  const result = evaluateSafety(
    { intent: 'unsupported_flow', appName: 'QQ', reason: '音视频通话需要明确测试联系人。' },
    '测试QQ音视频通话',
  );

  assert.equal(result.allowed, false);
  assert.match(result.reason, /测试联系人/);
});

test('blocks navigation tasks without a destination', () => {
  const result = evaluateSafety(
    { intent: 'missing_parameter', appName: '高德地图', field: 'destination' },
    '高德地图导航',
  );

  assert.equal(result.allowed, false);
  assert.match(result.reason, /目的地/);
});

test('blocks removed meeting automation intents', () => {
  const result = evaluateSafety(
    { intent: 'meeting_link', appName: '腾讯会议', meetingUrl: 'https://meeting.tencent.com/dm/abc' },
    '用腾讯会议加入会议 https://meeting.tencent.com/dm/abc',
  );

  assert.equal(result.allowed, false);
  assert.match(result.reason, /meeting_link/);
});

test('blocks payment and account-impacting automation', () => {
  for (const text of ['帮我自动付款', '给前100个视频点赞并关注', '自动抢票', '自动抢单', '绕过验证码']) {
    const result = evaluateSafety({ intent: 'watch_feed', appName: '抖音' }, text);
    assert.equal(result.allowed, false, text);
  }
});
