import { config } from '../config.js';

export const DOUYIN_LIVE_WORKFLOW_ID = 'live:douyin:live-browse';

const DEFAULT_SCREEN = {
  width: config.screen.defaultWidth,
  height: config.screen.defaultHeight,
};
const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MIN_SWITCH_INTERVAL_MS = 1000;
const DEFAULT_SWITCH_MIN_MS = 2 * 60 * 1000;
const DEFAULT_SWITCH_MAX_MS = 5 * 60 * 1000;
const DOUYIN_LIVE_ROOM_EVIDENCE = [
  /欢迎来到直播间/,
  /直播间/,
  /在线观众/,
  /说点什么/,
  /本场点赞/,
  /商品列表/,
  /连线/,
  /礼物/,
];

export function buildDouyinLiveManualPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  switchIntervalMs = null,
  screen = DEFAULT_SCREEN,
  random = Math.random,
} = {}) {
  if (app?.id !== 'douyin' || !app.packageName) {
    throw new Error('抖音直播 skill 只能用于抖音 App');
  }

  const size = normalizeScreen(screen);
  const safeDurationMs = normalizeDurationMs(durationMs);
  const safeSwitchIntervalMs = normalizeSwitchIntervalMs(switchIntervalMs);
  const steps = [
    {
      type: 'manual_confirm',
      label: '等待用户进入抖音直播间',
      message:
        '请在手机上手动进入要观看的抖音直播间，然后在前端点击“我已进入直播，继续”。',
      confirmLabel: '我已进入直播，继续',
    },
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      label: '确认当前前台为抖音',
      message: '当前未停留在抖音，请进入抖音直播间后重新执行。',
    },
    {
      type: 'assert_ui_text_or_activity',
      packageName: app.packageName,
      activityAny: [/Live/i],
      any: DOUYIN_LIVE_ROOM_EVIDENCE,
      label: '确认已进入抖音直播间',
      message: '未检测到抖音直播 Activity 或直播间控件，请确认已进入具体直播间。',
    },
    {
      type: 'assert_screen_changes',
      intervalMs: 1500,
      minDiffRatio: 0.0005,
      label: '确认抖音直播画面持续变化',
      message: '抖音直播画面没有持续变化，请确认直播正在播放。',
    },
    {
      type: 'start_capture',
      label: '开始采集抖音直播内容',
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
        label: `按设置间隔下滑切换抖音直播 ${switchIndex}`,
      });
    }
  }

  steps.push(
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      label: '确认抖音直播浏览未离开应用',
      message: '抖音直播浏览过程中已经离开抖音。',
    },
    {
      type: 'complete',
      label: '抖音直播浏览完成',
    },
  );
  return steps;
}

function normalizeDurationMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的抖音直播观看时长: ${JSON.stringify(value)}`);
  }
  return Math.min(MAX_DURATION_MS, Math.max(1000, Math.round(parsed)));
}

function normalizeSwitchIntervalMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的抖音直播切换间隔: ${JSON.stringify(value)}`);
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
