import { config } from '../config.js';

export const WEIBO_LIVE_WORKFLOW_ID = 'live:weibo:live-browse';

const DEFAULT_SCREEN = {
  width: config.screen.defaultWidth,
  height: config.screen.defaultHeight,
};
const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MIN_SWITCH_INTERVAL_MS = 1000;
const DEFAULT_SWITCH_MIN_MS = 2 * 60 * 1000;
const DEFAULT_SWITCH_MAX_MS = 5 * 60 * 1000;

export function buildWeiboLiveManualPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  switchIntervalMs = null,
  screen = DEFAULT_SCREEN,
  random = Math.random,
} = {}) {
  if (app?.id !== 'weibo' || !app.packageName) {
    throw new Error('微博直播 skill 只能用于微博 App');
  }

  const size = normalizeScreen(screen);
  const safeDurationMs = normalizeDurationMs(durationMs);
  const safeSwitchIntervalMs = normalizeSwitchIntervalMs(switchIntervalMs);
  const steps = [
    {
      type: 'manual_confirm',
      label: '等待用户进入微博直播间',
      message:
        '请在手机上手动进入要观看的微博直播间，然后在前端点击“我已进入直播，继续”。',
      confirmLabel: '我已进入直播，继续',
    },
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      label: '确认当前前台为微博',
      message: '当前未停留在微博，请进入微博直播间后重新执行。',
    },
    {
      type: 'assert_screen_changes',
      intervalMs: 1500,
      minDiffRatio: 0.0005,
      label: '确认微博直播画面持续变化',
      message: '微博直播画面没有持续变化，请确认已经进入正在播放的直播间。',
    },
    {
      type: 'start_capture',
      label: '开始采集微博直播内容',
    },
  ];

  let elapsedMs = 0;
  let switchIndex = 0;
  while (elapsedMs < safeDurationMs) {
    const waitMs = Math.min(
      nextSwitchWaitMs(safeSwitchIntervalMs, random),
      safeDurationMs - elapsedMs,
    );
    steps.push({
      type: 'wait',
      ms: waitMs,
      silent: true,
    });
    elapsedMs += waitMs;

    if (elapsedMs < safeDurationMs) {
      switchIndex += 1;
      steps.push({
        type: 'swipe',
        x1: Math.round(size.width * 0.5),
        y1: Math.round(size.height * 0.79),
        x2: Math.round(size.width * 0.5),
        y2: Math.round(size.height * 0.2),
        durationMs: 420,
        referenceScreen: size,
        label: `按设置间隔下滑切换微博直播 ${switchIndex}`,
      });
    }
  }

  steps.push(
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      label: '确认微博直播浏览未离开应用',
      message: '微博直播浏览过程中已经离开微博。',
    },
    {
      type: 'complete',
      label: '微博直播浏览完成',
    },
  );
  return steps;
}

function normalizeDurationMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的微博直播观看时长: ${JSON.stringify(value)}`);
  }
  return Math.min(MAX_DURATION_MS, Math.max(1000, Math.round(parsed)));
}

function normalizeSwitchIntervalMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的微博直播切换间隔: ${JSON.stringify(value)}`);
  }
  return Math.max(MIN_SWITCH_INTERVAL_MS, Math.round(parsed));
}

function nextSwitchWaitMs(switchIntervalMs, random) {
  if (switchIntervalMs) return switchIntervalMs;
  return randomInt(DEFAULT_SWITCH_MIN_MS, DEFAULT_SWITCH_MAX_MS, random);
}

function randomInt(min, max, random) {
  return min + Math.floor(random() * (max - min + 1));
}

function normalizeScreen(screen) {
  return {
    width: Number(screen?.width) || DEFAULT_SCREEN.width,
    height: Number(screen?.height) || DEFAULT_SCREEN.height,
  };
}
