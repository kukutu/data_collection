import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAiChatPlan } from '../server/src/skills/ai-chat.js';
import { buildAmapNavigationPlan } from '../server/src/skills/amap-navigation.js';
import { buildDoubaoChatPlan } from '../server/src/skills/doubao-chat.js';
import { buildGenericMediaPlaybackPlan } from '../server/src/skills/generic-media.js';
import { buildLiveEntryPlan } from '../server/src/skills/live-entry.js';
import { buildLiveStreamPlan } from '../server/src/skills/live-stream.js';
import { buildShortVideoPlan } from '../server/src/skills/short-video.js';
import { buildTencentVideoPlaybackPlan } from '../server/src/skills/tencent-video.js';
import { buildWechatChannelsPlan } from '../server/src/skills/wechat-channels.js';
import {
  buildWechatMessagesPlan,
  DEFAULT_WECHAT_MESSAGES,
} from '../server/src/skills/wechat-messages.js';

const screen = { width: 1260, height: 2800 };

test('generic media playback taps into content and player area', () => {
  const plan = buildGenericMediaPlaybackPlan({
    app: { name: 'B站', packageName: 'tv.danmaku.bili' },
    durationMs: 10_000,
    screen,
  });

  assert.ok(plan.some((step) => step.type === 'launch_app'));
  assert.ok(plan.some((step) => step.type === 'assert_no_sensitive_prompt'));
  assert.ok(plan.some((step) => step.type === 'tap' && step.label.includes('视频卡片')));
  assert.ok(plan.some((step) => step.type === 'tap' && step.label.includes('播放按钮')));
  assert.ok(plan.some((step) => step.type === 'tap_until_orientation' && step.label.includes('全屏')));
  assert.ok(plan.some((step) => step.type === 'assert_foreground_package'));
  assert.ok(plan.some((step) => step.type === 'assert_screen_changes'));
});

test('generic media playback keeps long playback waits silent', () => {
  const plan = buildGenericMediaPlaybackPlan({
    app: { name: 'B站', packageName: 'tv.danmaku.bili' },
    durationMs: 90_000,
    screen,
  });

  assert.ok(plan.some((step) => step.type === 'wait' && step.silent));
  assert.equal(plan.some((step) => step.label?.includes('保持播放')), false);
});

test('Youku playback uses media session verification for protected video layers', () => {
  const plan = buildGenericMediaPlaybackPlan({
    app: { id: 'youku', name: '优酷视频', packageName: 'com.youku.phone' },
    durationMs: 10_000,
    screen,
  });

  assert.ok(plan.some((step) => step.type === 'assert_media_playing' && step.packageName === 'com.youku.phone'));
  assert.equal(plan.some((step) => step.type === 'assert_screen_changes'), false);
});

test('Bilibili playback taps a middle video card and enters landscape fullscreen', () => {
  const plan = buildGenericMediaPlaybackPlan({
    app: { id: 'bilibili', name: 'B站', packageName: 'tv.danmaku.bili' },
    durationMs: 10_000,
    screen,
  });

  const entryTap = plan.find((step) => step.type === 'tap' && step.label.includes('首页中部视频卡片'));
  const playTap = plan.find((step) => step.type === 'tap' && step.label.includes('播放按钮'));
  const fullscreenTap = plan.find((step) => step.type === 'tap_until_orientation' && step.label.includes('横屏全屏按钮'));
  const orientationAssert = plan.find((step) => step.type === 'assert_orientation' && step.landscape);
  const playTapIndex = plan.findIndex((step) => step === playTap);
  const fullscreenTapIndex = plan.findIndex((step) => step === fullscreenTap);
  const fullscreenPoint = fullscreenTap?.taps?.[0];

  assert.ok(entryTap, 'Bilibili should tap a middle feed video card');
  assert.ok(entryTap.x <= Math.round(screen.width * 0.3), `Bilibili entry tap should target the left middle card: ${entryTap.x}`);
  assert.ok(entryTap.y >= Math.round(screen.height * 0.5), `Bilibili entry tap is too high: ${entryTap.y}`);
  assert.ok(entryTap.y <= Math.round(screen.height * 0.6), `Bilibili entry tap is too low: ${entryTap.y}`);
  assert.ok(playTap, 'Bilibili should tap the play button after opening the video page');
  assert.ok(fullscreenTap, 'Bilibili should enter landscape fullscreen from the detail page player');
  assert.ok(orientationAssert, 'Bilibili should verify landscape fullscreen');
  assert.ok(fullscreenTapIndex > playTapIndex, 'Bilibili should enter landscape fullscreen after tapping play');
  assert.equal(fullscreenTap.attempts, 3);
  assert.ok(fullscreenPoint.x >= Math.round(screen.width * 0.88), `fullscreen tap is too far left: ${fullscreenPoint.x}`);
  assert.ok(fullscreenPoint.y >= Math.round(screen.height * 0.26), `fullscreen tap is too high: ${fullscreenPoint.y}`);
  assert.ok(fullscreenPoint.y <= Math.round(screen.height * 0.31), `fullscreen tap is too low: ${fullscreenPoint.y}`);
});

test('WeChat Channels plan uses text navigation before feed swipes', () => {
  const plan = buildWechatChannelsPlan({
    app: { name: '微信', packageName: 'com.tencent.mm' },
    durationMs: 20_000,
    screen,
  });

  assert.ok(plan.some((step) => step.type === 'start_activity' && step.activityName === '.ui.LauncherUI'));
  assert.ok(plan.some((step) => step.type === 'tap_text' && step.texts.includes('发现')));
  assert.ok(
    plan.some(
      (step) =>
        step.type === 'tap' &&
        step.label.includes('底部发现') &&
        step.y >= Math.round(screen.height * 0.9) &&
        step.y <= Math.round(screen.height * 0.95),
    ),
  );
  assert.ok(plan.some((step) => step.type === 'assert_no_sensitive_prompt'));
  assert.ok(plan.some((step) => step.type === 'tap_text' && step.texts.includes('视频号')));
  assert.ok(
    plan.some(
      (step) =>
        step.type === 'tap_if_activity_not_matches' &&
        step.label.includes('视频号入口') &&
        step.y >= Math.round(screen.height * 0.19) &&
        step.y <= Math.round(screen.height * 0.23),
    ),
  );
  assert.ok(
    plan.some(
      (step) =>
        step.type === 'assert_ui_text_or_activity' &&
        step.activityAny?.some((matcher) => matcher instanceof RegExp && matcher.test('FinderHomeAffinityUI')),
    ),
  );
  assert.ok(plan.some((step) => step.type === 'assert_foreground_package'));
  assert.ok(plan.some((step) => step.type === 'assert_screen_changes'));
  assert.ok(plan.some((step) => step.type === 'swipe'));
});

test('WeChat message plan selects the first conversation and loops a large message pool', () => {
  const plan = buildWechatMessagesPlan({
    app: { id: 'wechat', name: '微信', packageName: 'com.tencent.mm' },
    durationMs: 20_000,
    intervalMs: 5_000,
    platform: 'harmony',
    screen,
  });
  const firstConversation = plan.find(
    (step) => step.type === 'tap' && step.label.includes('第一个会话'),
  );
  const chatAssert = plan.find((step) => step.type === 'assert_ui_node');
  const loop = plan.find((step) => step.type === 'loop_text_messages');
  const captureIndex = plan.findIndex((step) => step.type === 'start_capture');
  const chatAssertIndex = plan.findIndex((step) => step === chatAssert);

  assert.equal(DEFAULT_WECHAT_MESSAGES.length >= 40, true);
  assert.equal(new Set(DEFAULT_WECHAT_MESSAGES).size, DEFAULT_WECHAT_MESSAGES.length);
  assert.equal(firstConversation.x, Math.round(screen.width * 0.5));
  assert.equal(firstConversation.y, Math.round(screen.height * 0.217));
  assert.deepEqual(chatAssert.types, ['RichEditor']);
  assert.ok(captureIndex > chatAssertIndex);
  assert.equal(loop.durationMs, 20_000);
  assert.equal(loop.intervalMs, 5_000);
  assert.equal(loop.messages.length, DEFAULT_WECHAT_MESSAGES.length);
  assert.equal(loop.input.y, Math.round(screen.height * 0.929));
  assert.equal(loop.send.y, Math.round(screen.height * 0.556));
  assert.deepEqual(loop.input.target, { types: ['RichEditor'] });
  assert.deepEqual(loop.send.target, {
    texts: ['发送'],
    partial: false,
  });
});

test('XHS short video plan hands off to the user before feed browsing', () => {
  const plan = buildShortVideoPlan({
    app: { id: 'xiaohongshu', name: '小红书', packageName: 'com.xingin.xhs' },
    durationMs: 20_000,
    screen,
  });

  const confirmIndex = plan.findIndex((step) => step.type === 'manual_confirm');
  const firstSwipeIndex = plan.findIndex((step) => step.type === 'swipe');

  assert.equal(plan.some((step) => step.type === 'force_stop'), false);
  assert.equal(plan.some((step) => step.type === 'tap_text_region'), false);
  assert.equal(plan.some((step) => step.type === 'tap_if_ui_text_not_matches'), false);
  assert.equal(plan.some((step) => step.type === 'assert_ui_text'), false);
  assert.ok(confirmIndex > -1);
  assert.ok(firstSwipeIndex > confirmIndex);
  assert.ok(plan.some((step) => step.type === 'assert_screen_changes'));
});

test('XHS feed swipes after confirmation are short enough to avoid triggering refresh', () => {
  const plan = buildShortVideoPlan({
    app: { id: 'xiaohongshu', name: 'XHS', packageName: 'com.xingin.xhs' },
    durationMs: 20_000,
    screen,
  });

  const confirmIndex = plan.findIndex((step) => step.type === 'manual_confirm');
  const swipes = plan.filter((step) => step.type === 'swipe');
  const feedSwipe = swipes[0];
  const distance = Math.abs(feedSwipe.y1 - feedSwipe.y2);
  const screenChangeAssert = plan.find((step) => step.type === 'assert_screen_changes');

  assert.ok(feedSwipe, 'expected a feed swipe after manual confirmation');
  assert.ok(plan.findIndex((step) => step === feedSwipe) > confirmIndex);
  assert.ok(
    swipes.every((step) => Math.abs(step.y1 - step.y2) <= Math.round(screen.height * 0.08)),
    `XHS contains an oversized swipe: ${JSON.stringify(swipes)}`,
  );
  assert.ok(distance <= Math.round(screen.height * 0.08), `XHS feed swipe too long: ${distance}`);
  assert.ok(feedSwipe.y2 >= Math.round(screen.height * 0.52), `XHS feed swipe ends too high: ${feedSwipe.y2}`);
  assert.equal(screenChangeAssert.optional, true);
});

test('XHS requires manual confirmation before continuing feed browsing', () => {
  const plan = buildShortVideoPlan({
    app: { id: 'xiaohongshu', name: 'XHS', packageName: 'com.xingin.xhs' },
    durationMs: 20_000,
    screen,
  });

  const confirmIndex = plan.findIndex((step) => step.type === 'manual_confirm');
  const screenChangeIndex = plan.findIndex((step) => step.type === 'assert_screen_changes');
  const swipes = plan.filter((step) => step.type === 'swipe');
  const feedSwipeIndex = plan.findIndex((step) => step === swipes[0]);

  assert.ok(confirmIndex > -1, 'expected manual confirmation before feed browsing');
  assert.ok(screenChangeIndex > confirmIndex, 'screen/playback checks should wait for manual confirmation');
  assert.ok(feedSwipeIndex > confirmIndex, 'feed swipes should wait for manual confirmation');
});

test('Douyin short video plan uses a fast entry without UI text scans', () => {
  const plan = buildShortVideoPlan({
    app: { id: 'douyin', name: '抖音', packageName: 'com.ss.android.ugc.aweme' },
    durationMs: 12_000,
    screen,
  });

  assert.equal(plan.some((step) => step.type === 'assert_no_sensitive_prompt'), false);
  assert.equal(plan.some((step) => step.type === 'tap_text'), false);
  assert.equal(plan.some((step) => step.type === 'swipe_while_ui_text_matches'), false);
  assert.ok(plan.some((step) => step.type === 'assert_screen_changes'));
});

test('live entry plan rejects unsupported live apps', () => {
  assert.throws(
    () =>
      buildLiveEntryPlan({
        app: { id: 'weibo', name: '微博', packageName: 'com.sina.weibo' },
        durationMs: 30_000,
        screen,
      }),
    /微博当前没有稳定可验证的直播入口/,
  );
});

test('Taobao live plan must enter a live room rather than only the live home page', () => {
  const plan = buildLiveEntryPlan({
    app: { id: 'taobao', name: '淘宝', packageName: 'com.taobao.taobao' },
    durationMs: 30_000,
    screen,
  });

  assert.ok(plan.some((step) => step.type === 'tap_text' && step.texts.includes('去看直播')));
  assert.ok(plan.some((step) => step.type === 'tap_if_activity_not_matches' && step.label.includes('淘宝直播卡片')));
  assert.ok(
    plan.some(
      (step) =>
        step.type === 'assert_foreground_package' &&
        step.activityAny?.some((matcher) => matcher instanceof RegExp && matcher.test('TaoLiveVideoActivity')),
    ),
  );
  assert.ok(plan.some((step) => step.type === 'assert_ui_text' && step.label.includes('淘宝直播间')));
  assert.ok(plan.some((step) => step.type === 'assert_screen_changes'));
});

test('Douyin live plan validates Live activity and screen motion', () => {
  const plan = buildLiveEntryPlan({
    app: { id: 'douyin', name: '抖音', packageName: 'com.ss.android.ugc.aweme' },
    durationMs: 30_000,
    screen,
  });

  assert.ok(plan.some((step) => step.type === 'swipe_if_ui_text_not_matches' && step.label.includes('顶部频道栏')));
  assert.ok(plan.some((step) => step.type === 'tap_text_region' && step.texts.includes('直播')));
  assert.ok(plan.some((step) => step.type === 'assert_ui_text_or_activity' && step.label.includes('直播频道')));
  assert.ok(plan.some((step) => step.type === 'tap_if_activity_not_matches' && step.label.includes('直播预览')));
  assert.ok(
    plan.some(
      (step) =>
        step.type === 'assert_foreground_package' &&
        step.activityAny?.some((matcher) => matcher instanceof RegExp && matcher.test('LivePlayActivity')),
    ),
  );
  assert.ok(
    plan.some((step) => step.type === 'assert_ui_text' && step.label.includes('直播间文本证据') && step.optional),
  );
  assert.ok(plan.some((step) => step.type === 'assert_screen_changes'));
});

test('JD live plan uses bottom browse tab before switching from video to live', () => {
  const plan = buildLiveEntryPlan({
    app: { id: 'jd', name: '京东', packageName: 'com.jingdong.app.mall' },
    durationMs: 30_000,
    screen,
  });

  assert.ok(plan.some((step) => step.type === 'force_stop' && step.packageName === 'com.jingdong.app.mall'));
  assert.ok(plan.some((step) => step.type === 'tap_text_region' && step.texts.includes('逛') && step.optional));
  assert.ok(plan.some((step) => step.type === 'tap' && step.label.includes('兜底点击底部逛')));
  assert.ok(plan.some((step) => step.type === 'tap' && step.label.includes('视频频道')));
  assert.ok(plan.some((step) => step.type === 'tap' && step.label.includes('京东直播频道')));
  assert.ok(plan.some((step) => step.type === 'assert_no_sensitive_prompt' && step.label.includes('风控验证')));
  assert.ok(plan.some((step) => step.type === 'tap_if_activity_not_matches' && step.label.includes('京东直播卡片')));
  assert.ok(plan.some((step) => step.type === 'tap_if_ui_text_matches' && step.label.includes('悬浮窗权限')));
  assert.ok(
    plan.some(
      (step) =>
        step.type === 'assert_foreground_package' &&
        step.activityAny?.some((matcher) => matcher instanceof RegExp && matcher.test('VideoLiveRoomActivity')),
    ),
  );
  assert.ok(plan.some((step) => step.type === 'assert_ui_text' && step.label.includes('京东直播间')));
  assert.ok(plan.some((step) => step.type === 'assert_screen_changes' && step.label.includes('京东直播画面')));
});

test('WeChat live plan taps a live card and validates live room activity', () => {
  const plan = buildLiveEntryPlan({
    app: { id: 'wechat', name: '微信', packageName: 'com.tencent.mm' },
    durationMs: 30_000,
    screen,
  });

  const confirmIndex = plan.findIndex((step) => step.type === 'manual_confirm');
  const cardTapIndex = plan.findIndex(
    (step) => step.type === 'tap_if_activity_not_matches' && step.label.includes('微信直播卡片'),
  );
  const cardTap = plan[cardTapIndex];
  const revealControlsIndex = plan.findIndex(
    (step) =>
      step.type === 'tap_if_ui_text_not_matches' &&
      step.label.includes('显示微信直播间控件'),
  );
  const activityAssertIndex = plan.findIndex(
    (step) =>
      step.type === 'assert_ui_text_or_activity' &&
      step.activityAny?.some((matcher) => matcher instanceof RegExp && matcher.test('FinderLiveVisitorWithoutAffinityUI')),
  );
  const activityAssert = plan[activityAssertIndex];
  const screenChangeIndex = plan.findIndex(
    (step) => step.type === 'assert_screen_changes' && step.label.includes('微信直播画面'),
  );

  assert.ok(plan.some((step) => step.type === 'start_activity' && step.activityName === '.ui.LauncherUI'));
  assert.ok(plan.some((step) => step.type === 'tap' && step.label.includes('底部发现')));
  assert.ok(plan.some((step) => step.type === 'tap' && step.label.includes('发现页直播入口')));
  assert.equal(confirmIndex, -1);
  assert.ok(cardTapIndex > -1, 'expected WeChat live card tap');
  assert.ok(revealControlsIndex > cardTapIndex, 'WeChat live controls should be revealed after card tap');
  assert.equal(
    cardTap.activityAny.some((matcher) => matcher instanceof RegExp && matcher.test('FinderLiveSquareNewEntranceUI')),
    false,
    'WeChat live square must not be treated as a live room',
  );
  assert.ok(activityAssertIndex > cardTapIndex, 'WeChat live Activity validation should run after card tap');
  assert.equal(
    activityAssert.activityAny.some((matcher) => matcher instanceof RegExp && matcher.test('FinderLiveSquareNewEntranceUI')),
    false,
    'WeChat validation must not accept the live square page',
  );
  assert.ok(
    activityAssert.all.some(
      (matcher) => matcher instanceof RegExp && matcher.test('欢迎来到直播间'),
    ),
    'Harmony WeChat should accept strong live-room text evidence',
  );
  assert.equal(plan.some((step) => step.type === 'assert_ui_text' && step.label.includes('微信直播间')), false);
  assert.ok(screenChangeIndex > cardTapIndex, 'WeChat live screen validation should run after card tap');
});

test('XHS live plan hands off to the user and validates live room activity', () => {
  const plan = buildLiveEntryPlan({
    app: { id: 'xiaohongshu', name: '小红书', packageName: 'com.xingin.xhs' },
    durationMs: 30_000,
    screen,
  });

  const confirmIndex = plan.findIndex((step) => step.type === 'manual_confirm');
  const activityAssertIndex = plan.findIndex(
    (step) =>
      step.type === 'assert_foreground_package' &&
      step.activityAny?.some((matcher) => matcher instanceof RegExp && matcher.test('AlphaAudienceActivityV2')),
  );
  const screenChangeIndex = plan.findIndex(
    (step) => step.type === 'assert_screen_changes' && step.label.includes('小红书直播画面'),
  );

  assert.ok(plan.some((step) => step.type === 'launch_app' && step.packageName === 'com.xingin.xhs'));
  assert.equal(plan.some((step) => step.type === 'force_stop'), false);
  assert.equal(plan.some((step) => step.type === 'tap_text_region'), false);
  assert.equal(plan.some((step) => step.type === 'tap_if_activity_not_matches' && step.label.includes('小红书直播卡片')), false);
  assert.ok(confirmIndex > -1, 'expected manual confirmation before XHS live room validation');
  assert.ok(activityAssertIndex > confirmIndex, 'XHS live Activity validation should wait for manual confirmation');
  assert.ok(screenChangeIndex > confirmIndex, 'XHS live screen validation should wait for manual confirmation');
});

test('live plans switch rooms after random multi-minute waits', () => {
  const entryPlan = buildLiveEntryPlan({
    app: { id: 'taobao', name: '淘宝', packageName: 'com.taobao.taobao' },
    durationMs: 20 * 60_000,
    screen,
  });
  const entryWait = entryPlan.find((step) => step.type === 'wait' && step.label.includes('后切换'));

  assert.ok(entryWait, 'live entry should wait before switching');
  assert.ok(entryWait.ms >= 2 * 60_000, `default wait too short: ${entryWait.ms}`);
  assert.ok(entryWait.ms <= 5 * 60_000, `default wait too long: ${entryWait.ms}`);
  assert.ok(entryPlan.some((step) => step.type === 'swipe' && step.label.includes('随机间隔后下滑')));

  const streamPlan = buildLiveStreamPlan({
    app: { id: 'douyin', name: '抖音', packageName: 'com.ss.android.ugc.aweme' },
    durationMs: 10 * 60_000,
    switchIntervalMs: 3 * 60_000,
    screen,
  });
  const streamWait = streamPlan.find((step) => step.type === 'wait' && step.label.includes('后切换'));

  assert.ok(streamWait, 'watch_live should wait before switching');
  assert.ok(streamWait.ms >= Math.round(3 * 60_000 * 0.7), `explicit interval wait too short: ${streamWait.ms}`);
  assert.ok(streamWait.ms <= Math.round(3 * 60_000 * 1.3), `explicit interval wait too long: ${streamWait.ms}`);
  assert.ok(streamPlan.some((step) => step.type === 'swipe' && step.label.includes('随机间隔后下滑')));
});

test('AI chat plan uses English messages and prompt guard', () => {
  const plan = buildAiChatPlan({
    app: { id: 'qianwen', name: '千问', packageName: 'com.aliyun.tongyi' },
    durationMs: 12_000,
    intervalMs: 10_000,
    screen,
  });

  assert.ok(plan.some((step) => step.type === 'assert_no_sensitive_prompt'));
  assert.ok(plan.some((step) => step.type === 'input_text'));
  assert.ok(plan.some((step) => step.type === 'wait_for_screen_idle'));
  assert.equal(plan.some((step) => step.type === 'tap_text' && step.texts?.includes('Send')), false);
  assert.equal(plan.some((step) => step.type === 'keyevent' && step.code === 'KEYCODE_ENTER'), false);
  assert.ok(plan.filter((step) => step.type === 'input_text').every((step) => /^[\x20-\x7E]+$/.test(step.text)));
});

test('Qwen AI chat clicks the app send button after text input', () => {
  const plan = buildAiChatPlan({
    app: { id: 'qianwen', name: '千问', packageName: 'com.aliyun.tongyi' },
    durationMs: 12_000,
    intervalMs: 8_000,
    screen,
  });

  const inputIndex = plan.findIndex((step) => step.type === 'input_text');
  const settleStep = plan[inputIndex + 1];
  const sendStep = plan[inputIndex + 2];

  assert.equal(settleStep.type, 'wait');
  assert.equal(settleStep.ms, 300);
  assert.equal(sendStep.type, 'tap');
  assert.ok(sendStep.label.includes('发送按钮'));
  assert.equal(sendStep.x, Math.round(screen.width * 0.885));
  assert.equal(sendStep.y, Math.round(screen.height * 0.593));
});

test('AI chat plans use short adaptive reply waits by default', () => {
  const qianwenPlan = buildAiChatPlan({
    app: { id: 'qianwen', name: '千问', packageName: 'com.aliyun.tongyi' },
    durationMs: 15_000,
    screen,
  });
  const doubaoPlan = buildDoubaoChatPlan({
    app: {
      id: 'doubao',
      name: '豆包',
      packageName: 'com.larus.nova',
      skillConfig: {
        resources: {
          input: 'com.larus.nova:id/input_text',
          send: 'com.larus.nova:id/action_send',
        },
      },
    },
    durationMs: 15_000,
    platform: 'harmony',
    screen,
  });

  for (const plan of [qianwenPlan, doubaoPlan]) {
    const waits = plan.filter((step) => step.type === 'wait_for_screen_idle');
    assert.ok(waits.length > 0, 'expected adaptive reply waits');
    assert.ok(waits.every((step) => step.maxMs <= 8_000), `adaptive wait too long: ${JSON.stringify(waits)}`);
    assert.ok(waits.every((step) => step.minMs <= 3_000), `adaptive wait minimum too long: ${JSON.stringify(waits)}`);
  }
});

test('AI chat plans include large default message pools', () => {
  const qianwenPlan = buildAiChatPlan({
    app: { id: 'qianwen', name: '千问', packageName: 'com.aliyun.tongyi' },
    durationMs: 340_000,
    screen,
  });
  const doubaoPlan = buildDoubaoChatPlan({
    app: {
      id: 'doubao',
      name: '豆包',
      packageName: 'com.larus.nova',
      skillConfig: {
        resources: {
          input: 'com.larus.nova:id/input_text',
          send: 'com.larus.nova:id/action_send',
        },
      },
    },
    durationMs: 340_000,
    platform: 'harmony',
    screen,
  });

  for (const [plan, inputType] of [
    [qianwenPlan, 'input_text'],
    [doubaoPlan, 'input_key_text'],
  ]) {
    const messages = plan.filter((step) => step.type === inputType).map((step) => step.text);
    const uniqueMessages = new Set(messages);
    assert.ok(uniqueMessages.size >= 35, `expected a large default message pool, got ${uniqueMessages.size}`);
    assert.ok(messages.every((message) => /^[\x20-\x7E]+$/.test(message)));
  }
});

test('Doubao Harmony chat uses HDC key injection and coordinate sending', () => {
  const plan = buildDoubaoChatPlan({
    app: {
      id: 'doubao',
      name: '豆包',
      packageName: 'com.larus.nova',
    },
    durationMs: 12_000,
    intervalMs: 8_000,
    platform: 'harmony',
    screen,
  });

  const inputIndex = plan.findIndex((step) => step.type === 'input_key_text');
  const inputStep = plan[inputIndex];
  const sendStep = plan[inputIndex + 2];

  assert.equal(inputStep.text, 'FACT');
  assert.equal(inputStep.clearExisting, true);
  assert.equal(sendStep.type, 'tap');
  assert.equal(sendStep.x, Math.round(screen.width * 0.877));
  assert.equal(sendStep.y, Math.round(screen.height * 0.549));
  assert.ok(plan.some((step) => step.type === 'assert_screen_changes'));
});

test('capture starts only after each skill reaches its validated content state', () => {
  const doubaoApp = {
    id: 'doubao',
    name: 'Doubao',
    packageName: 'com.larus.nova',
    skillConfig: {
      resources: {
        input: 'com.larus.nova:id/input_text',
        send: 'com.larus.nova:id/action_send',
      },
    },
  };
  const plans = [
    {
      name: 'short video',
      plan: buildShortVideoPlan({
        app: { id: 'douyin', name: 'Douyin', packageName: 'com.ss.android.ugc.aweme' },
        durationMs: 12_000,
        screen,
      }),
      validation: 'assert_screen_changes',
    },
    {
      name: 'live entry',
      plan: buildLiveEntryPlan({
        app: { id: 'taobao', name: 'Taobao', packageName: 'com.taobao.taobao' },
        durationMs: 30_000,
        screen,
      }),
      validation: 'assert_screen_changes',
    },
    {
      name: 'current live room',
      plan: buildLiveStreamPlan({
        app: { id: 'douyin', name: 'Douyin', packageName: 'com.ss.android.ugc.aweme' },
        durationMs: 12_000,
        switchIntervalMs: 30_000,
        screen,
      }),
      validation: null,
    },
    {
      name: 'generic media',
      plan: buildGenericMediaPlaybackPlan({
        app: { id: 'bilibili', name: 'Bilibili', packageName: 'tv.danmaku.bili' },
        durationMs: 12_000,
        screen,
      }),
      validation: 'assert_screen_changes',
    },
    {
      name: 'Tencent Video',
      plan: buildTencentVideoPlaybackPlan({
        app: { name: 'Tencent Video', packageName: 'com.tencent.qqlive' },
        durationMs: 12_000,
      }),
      validation: 'assert_media_playing',
    },
    {
      name: 'navigation',
      plan: buildAmapNavigationPlan({
        app: { name: 'AMap', packageName: 'com.autonavi.minimap' },
        destination: 'Beijing Station',
        durationMs: 12_000,
        screen,
      }),
      validation: 'assert_foreground_package',
    },
    {
      name: 'WeChat Channels',
      plan: buildWechatChannelsPlan({
        app: { name: 'WeChat', packageName: 'com.tencent.mm' },
        durationMs: 12_000,
        screen,
      }),
      validation: 'assert_screen_changes',
    },
    {
      name: 'AI chat',
      plan: buildAiChatPlan({
        app: { name: 'Qwen', packageName: 'com.aliyun.tongyi' },
        durationMs: 12_000,
        screen,
      }),
      validation: 'assert_foreground_package',
    },
    {
      name: 'Doubao chat',
      plan: buildDoubaoChatPlan({
        app: doubaoApp,
        durationMs: 12_000,
      }),
      validation: 'assert_foreground_package',
    },
  ];

  for (const { name, plan, validation } of plans) {
    const captureIndex = plan.findIndex((step) => step.type === 'start_capture');
    assert.ok(captureIndex >= 0, `${name} should declare a capture boundary`);
    if (validation) {
      const validationIndex = plan.findIndex((step) => step.type === validation);
      assert.ok(validationIndex >= 0, `${name} should declare ${validation}`);
      assert.ok(captureIndex > validationIndex, `${name} starts capture before validation`);
    } else {
      assert.equal(captureIndex, 0, `${name} should start after the caller's room check`);
    }
  }
});
