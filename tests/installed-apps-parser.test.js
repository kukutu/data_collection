import test from 'node:test';
import assert from 'node:assert/strict';

import { loadApps } from '../server/src/app-registry.js';
import { installedKnownApps } from '../server/src/app-registry.js';
import { parseTaskFallback } from '../server/src/task-parser.js';

const apps = loadApps();

test('marks an app installed when its Harmony bundle is present', () => {
  const result = installedKnownApps(
    [
      {
        name: 'Douyin',
        packageName: 'com.ss.android.ugc.aweme',
        harmonyBundleName: 'com.ss.hm.ugc.aweme',
      },
    ],
    'ID: 100:\n\tcom.ss.hm.ugc.aweme\n',
  );

  assert.equal(result[0].installed, true);
  assert.equal(result[0].installedVia, 'hdc');
});

test('recognizes the DeepSeek bundle in device package output', () => {
  const result = installedKnownApps(
    [
      {
        name: 'DeepSeek',
        packageName: 'com.deepseek.chat',
        harmonyBundleName: 'com.deepseek.chat',
      },
    ],
    [
      'Mission ID #133  mission name #[#com.deepseek.chat:entry:com.deepseek.chat.MainActivity]',
      '  bundle name [com.huawei.shell_assistant]',
      '  state #FOREGROUND',
    ].join('\n'),
  );

  assert.equal(result[0].installed, true);
  assert.equal(result[0].installedVia, 'hdc');
});

test('recognizes the Harmony Xigua bundle in device package output', () => {
  const xigua = apps.find((app) => app.id === 'xigua');
  const result = installedKnownApps([xigua], 'com.ss.hm.article.video');

  assert.equal(xigua.harmonyBundleName, 'com.ss.hm.article.video');
  assert.equal(result[0].installed, true);
  assert.equal(result[0].installedVia, 'hdc');
});

test('recognizes and parses the Harmony Toutiao short-video app', () => {
  const toutiao = apps.find((app) => app.id === 'toutiao');
  const installed = installedKnownApps([toutiao], 'com.ss.hm.article.news');
  const parsed = parseTaskFallback('刷30秒头条视频', apps);

  assert.equal(toutiao.harmonyBundleName, 'com.ss.hm.article.news');
  assert.equal(toutiao.skill, 'short_video_feed');
  assert.equal(installed[0].installed, true);
  assert.equal(installed[0].installedVia, 'hdc');
  assert.equal(parsed.intent, 'watch_feed');
  assert.equal(parsed.appName, '头条');
  assert.equal(parsed.durationMs, 30_000);
});

test('recognizes and parses the Harmony Bilibili live app', () => {
  const bilibili = apps.find((app) => app.id === 'bilibili');
  const installed = installedKnownApps([bilibili], 'yylx.danmaku.bili');
  const parsed = parseTaskFallback('看30秒B站直播，每8秒下滑一次', apps);

  assert.equal(bilibili.harmonyBundleName, 'yylx.danmaku.bili');
  assert.equal(installed[0].installed, true);
  assert.equal(installed[0].installedVia, 'hdc');
  assert.equal(parsed.intent, 'live_entry');
  assert.equal(parsed.appName, 'B站');
  assert.equal(parsed.durationMs, 30_000);
  assert.equal(parsed.switchIntervalMs, 8_000);
});

test('recognizes and parses the Harmony Huya live app', () => {
  const huya = apps.find((app) => app.id === 'huya');
  const installed = installedKnownApps([huya], 'com.duowan.hyhos');
  const parsed = parseTaskFallback('看30秒虎牙直播，每8秒下滑一次', apps);

  assert.equal(huya.harmonyBundleName, 'com.duowan.hyhos');
  assert.equal(huya.skill, 'live_entry');
  assert.equal(installed[0].installed, true);
  assert.equal(installed[0].installedVia, 'hdc');
  assert.equal(parsed.intent, 'live_entry');
  assert.equal(parsed.appName, '虎牙');
  assert.equal(parsed.durationMs, 30_000);
  assert.equal(parsed.switchIntervalMs, 8_000);
});

test('recognizes and parses the Harmony Douyu live app', () => {
  const douyu = apps.find((app) => app.id === 'douyu');
  const installed = installedKnownApps([douyu], 'com.douyu.ho.app');
  const parsed = parseTaskFallback('看30秒斗鱼直播，每8秒下滑一次', apps);

  assert.equal(douyu.harmonyBundleName, 'com.douyu.ho.app');
  assert.equal(douyu.skill, 'live_entry');
  assert.equal(installed[0].installed, true);
  assert.equal(installed[0].installedVia, 'hdc');
  assert.equal(parsed.intent, 'live_entry');
  assert.equal(parsed.appName, '斗鱼');
  assert.equal(parsed.durationMs, 30_000);
  assert.equal(parsed.switchIntervalMs, 8_000);
});

test('recognizes and parses the Harmony Weibo manual live flow', () => {
  const weibo = apps.find((app) => app.id === 'weibo');
  const installed = installedKnownApps([weibo], 'com.sina.weibo.stage');
  const parsed = parseTaskFallback('看30秒微博直播，每8秒下滑一次', apps);

  assert.equal(weibo.harmonyBundleName, 'com.sina.weibo.stage');
  assert.equal(weibo.skill, 'live_entry');
  assert.equal(installed[0].installed, true);
  assert.equal(installed[0].installedVia, 'hdc');
  assert.equal(parsed.intent, 'live_entry');
  assert.equal(parsed.appName, '微博');
  assert.equal(parsed.durationMs, 30_000);
  assert.equal(parsed.switchIntervalMs, 8_000);
});

test('recognizes a configured Harmony compatibility app through its host bundle', () => {
  const result = installedKnownApps(
    [
      {
        name: 'DeepSeek',
        packageName: 'com.deepseek.chat',
        harmonyBundleName: 'com.deepseek.chat',
        harmonyLaunch: { compatibility: true },
        harmonyCompatibilityHostBundleName: 'com.huawei.shell_assistant',
      },
    ],
    'com.huawei.shell_assistant',
  );

  assert.equal(result[0].installed, true);
  assert.equal(result[0].installedVia, 'hdc');
});

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
  const kuaishouLive = parseTaskFallback('看4分钟快手直播', apps);
  const bilibiliLive = parseTaskFallback('看4分钟B站直播', apps);
  const huyaLive = parseTaskFallback('看4分钟虎牙直播', apps);
  const douyuLive = parseTaskFallback('看4分钟斗鱼直播', apps);
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
  assert.equal(kuaishouLive.intent, 'live_entry');
  assert.equal(kuaishouLive.appName, '快手');
  assert.equal(bilibiliLive.intent, 'live_entry');
  assert.equal(bilibiliLive.appName, 'B站');
  assert.equal(huyaLive.intent, 'live_entry');
  assert.equal(huyaLive.appName, '虎牙');
  assert.equal(douyuLive.intent, 'live_entry');
  assert.equal(douyuLive.appName, '斗鱼');
  assert.equal(weibo.intent, 'live_entry');
  assert.equal(weibo.appName, '微博');
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

  for (const text of ['测试1分钟QQ音视频通话', '看4分钟大麦演出']) {
    const parsed = parseTaskFallback(text, apps);
    assert.equal(parsed.intent, 'unsupported_flow', text);
    assert.ok(parsed.reason, text);
  }

  assert.equal(parseTaskFallback('测试2分钟百度网盘下载', apps).intent, 'baidu_netdisk_download');
});
