import { config } from '../config.js';

const DEFAULT_SCREEN = { width: config.screen.defaultWidth, height: config.screen.defaultHeight };
const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const WAIT_CHUNK_MS = 60 * 1000;

export function buildGenericMediaPlaybackPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  screen = DEFAULT_SCREEN,
}) {
  if (!app?.packageName) {
    throw new Error('generic media skill requires an app packageName');
  }

  const safeDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));
  const size = {
    width: Number(screen.width) || DEFAULT_SCREEN.width,
    height: Number(screen.height) || DEFAULT_SCREEN.height,
  };
  const centerX = Math.round(size.width * 0.5);
  const bilibili = isBilibili(app);
  const youku = isYouku(app);
  const entryX = bilibili ? Math.round(size.width * 0.25) : centerX;

  const steps = [
    { type: 'keyevent', code: 'KEYCODE_BACK', label: '关闭可能残留的弹窗' },
    { type: 'launch_app', packageName: app.packageName, label: `打开${app.name}` },
    { type: 'wait', ms: Math.min(6000, safeDuration), label: '等待首页加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'tap',
      x: entryX,
      y: Math.round(size.height * (bilibili ? 0.54 : 0.34)),
      label: bilibili ? '点击首页中部视频卡片进入播放页' : '点击首页内容进入播放页',
    },
    { type: 'wait', ms: 5000, label: '等待播放页加载' },
    {
      type: 'tap',
      x: centerX,
      y: Math.round(size.height * (bilibili ? 0.22 : 0.2)),
      label: bilibili ? '点击播放按钮观看' : '点击播放区域开始或恢复播放',
    },
    { type: 'wait', ms: 800, label: '等待播放控件显示' },
    ...buildFullscreenSteps({ bilibili, size, centerX }),
    { type: 'wait', ms: 1500, label: '等待全屏播放稳定' },
    {
      type: 'assert_orientation',
      landscape: true,
      label: '确认已进入横屏全屏',
      message: `${app.name}未进入横屏全屏播放`,
    },
    { type: 'assert_no_sensitive_prompt', label: '检查播放页权限弹窗' },
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      label: `确认仍在${app.name}播放页`,
    },
    ...buildPlaybackAssertionSteps({ app, useMediaSession: youku }),
  ];

  let elapsed = sumWaits(steps);
  while (elapsed < safeDuration) {
    const waitMs = Math.min(WAIT_CHUNK_MS, safeDuration - elapsed);
    steps.push({ type: 'wait', ms: waitMs, silent: true });
    elapsed += waitMs;
  }

  steps.push({ type: 'complete', label: `${app.name}播放会话完成` });
  return steps;
}

function sumWaits(steps) {
  return steps.filter((step) => step.type === 'wait').reduce((sum, step) => sum + step.ms, 0);
}

function isBilibili(app) {
  return app.id === 'bilibili' || app.packageName === 'tv.danmaku.bili' || /B站|哔哩哔哩|bilibili/i.test(app.name || '');
}

function isYouku(app) {
  return app.id === 'youku' || app.packageName === 'com.youku.phone' || /优酷|youku/i.test(app.name || '');
}

function buildPlaybackAssertionSteps({ app, useMediaSession }) {
  if (useMediaSession) {
    return [
      { type: 'keyevent', code: 'KEYCODE_MEDIA_PLAY', label: `恢复${app.name}播放` },
      { type: 'wait', ms: 800, label: `等待${app.name}播放状态更新` },
      {
        type: 'assert_media_playing',
        packageName: app.packageName,
        label: `确认${app.name}媒体会话在播放`,
        message: `${app.name}未检测到播放状态，疑似未进入真实播放页`,
      },
    ];
  }

  return [
    {
      type: 'assert_screen_changes',
      intervalMs: 1500,
      minDiffRatio: 0.0005,
      label: `确认${app.name}画面在播放`,
      message: `${app.name}画面变化不足，疑似未进入真实播放页`,
    },
  ];
}

function buildFullscreenSteps({ bilibili, size, centerX }) {
  if (!bilibili) {
    return [
      {
        type: 'tap_until_orientation',
        landscape: true,
        taps: [{ x: Math.round(size.width * 0.92), y: Math.round(size.height * 0.28) }],
        attempts: 2,
        afterTapWaitMs: 1500,
        label: '点击全屏按钮观看',
        message: '未进入横屏全屏播放',
      },
    ];
  }

  return [
    {
      type: 'tap',
      x: centerX,
      y: Math.round(size.height * 0.14),
      label: '显示B站播放控件',
    },
    { type: 'wait', ms: 500, label: '等待B站播放控件显示' },
    {
      type: 'tap_until_orientation',
      landscape: true,
      taps: [{ x: Math.round(size.width * 0.92), y: Math.round(size.height * 0.282) }],
      attempts: 3,
      afterTapWaitMs: 1500,
      label: '点击B站横屏全屏按钮',
      message: 'B站未进入横屏全屏播放',
    },
  ];
}
