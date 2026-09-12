import { config } from '../config.js';

const DEFAULT_SCREEN = { width: config.screen.defaultWidth, height: config.screen.defaultHeight };
const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RANDOM_SWITCH_MIN_MS = 2 * 60 * 1000;
const DEFAULT_RANDOM_SWITCH_MAX_MS = 5 * 60 * 1000;
const MIN_SWITCH_INTERVAL_MS = 1000;

export function buildLiveStreamPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  switchIntervalMs = null,
  screen = DEFAULT_SCREEN,
}) {
  const safeDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));
  const size = {
    width: Number(screen.width) || DEFAULT_SCREEN.width,
    height: Number(screen.height) || DEFAULT_SCREEN.height,
  };

  const x = Math.round(size.width * 0.5);
  const startY = Math.round(size.height * 0.79);
  const endY = Math.round(size.height * 0.2);
  const steps = [{ type: 'start_capture', label: '开始采集直播内容' }];
  let elapsed = 0;
  let index = 0;

  while (elapsed < safeDuration) {
    const waitMs = Math.min(nextSwitchWaitMs(switchIntervalMs), safeDuration - elapsed);
    steps.push({ type: 'wait', ms: waitMs, label: `观看直播 ${formatWaitLabel(waitMs)} 后切换` });
    elapsed += waitMs;

    if (elapsed < safeDuration) {
      steps.push({
        type: 'swipe',
        x1: x,
        y1: startY,
        x2: x,
        y2: endY,
        durationMs: 420,
        label: `${
          hasConfiguredSwitchInterval(switchIntervalMs) ? '按设置间隔' : '随机间隔'
        }后下滑切换下一场直播 ${index + 1}`,
      });
    }

    index += 1;
  }

  steps.push({ type: 'complete', label: `${app?.name || '直播'}观看完成` });
  return steps;
}

function nextSwitchWaitMs(switchIntervalMs) {
  const base = Number(switchIntervalMs);
  if (Number.isFinite(base) && base > 0) {
    return Math.max(MIN_SWITCH_INTERVAL_MS, Math.round(base));
  }

  return randomInt(DEFAULT_RANDOM_SWITCH_MIN_MS, DEFAULT_RANDOM_SWITCH_MAX_MS);
}

function hasConfiguredSwitchInterval(switchIntervalMs) {
  return Number.isFinite(Number(switchIntervalMs)) && Number(switchIntervalMs) > 0;
}

function randomInt(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return low + Math.floor(Math.random() * (high - low + 1));
}

function formatWaitLabel(ms) {
  if (ms >= 60 * 1000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
}
