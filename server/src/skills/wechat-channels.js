import { config } from '../config.js';

const DEFAULT_SCREEN = { width: config.screen.defaultWidth, height: config.screen.defaultHeight };
const DEFAULT_DURATION_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;

export function buildWechatChannelsPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  screen = DEFAULT_SCREEN,
}) {
  if (!app?.packageName) {
    throw new Error('WeChat Channels skill requires an app packageName');
  }

  const safeDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));
  const size = {
    width: Number(screen.width) || DEFAULT_SCREEN.width,
    height: Number(screen.height) || DEFAULT_SCREEN.height,
  };
  const x = Math.round(size.width * 0.5);
  const channelsPageEvidence = [/^关注$/m, /^推荐$/m, /朋友推荐/, /^直播$/m, /视频号/];
  const channelsActivityAny = [/FinderHomeAffinityUI/i, /FinderTimeline/i, /FinderFeed/i];
  const steps = [
    { type: 'start_activity', packageName: app.packageName, activityName: '.ui.LauncherUI', label: '打开微信主界面' },
    { type: 'wait', ms: 3000, label: '等待微信加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'tap_text',
      texts: ['稍后', '取消', '暂不', '跳过', '我知道了', '以后再说', '关闭'],
      optional: true,
      partial: true,
      label: '关闭非必要提示',
    },
    { type: 'tap_text', texts: ['发现'], optional: true, label: '进入发现页' },
    { type: 'wait', ms: 900, label: '等待发现页响应' },
    {
      type: 'tap',
      x: Math.round(size.width * 0.625),
      y: Math.round(size.height * 0.925),
      label: '点击底部发现兜底',
    },
    { type: 'wait', ms: 1400, label: '等待发现页' },
    { type: 'tap_text', texts: ['视频号'], optional: true, label: '进入视频号' },
    { type: 'wait', ms: 1200, label: '等待视频号入口响应' },
    {
      type: 'tap_if_activity_not_matches',
      activityAny: channelsActivityAny,
      x: Math.round(size.width * 0.24),
      y: Math.round(size.height * 0.21),
      label: '点击发现页视频号入口兜底',
    },
    { type: 'wait', ms: 4000, label: '等待视频号加载' },
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      label: '确认仍在微信',
    },
    {
      type: 'assert_ui_text_or_activity',
      packageName: app.packageName,
      activityAny: channelsActivityAny,
      any: channelsPageEvidence,
      label: '确认进入微信视频号页面',
      message: '微信未进入视频号页面，停止以避免在发现页或聊天页盲滑',
    },
    {
      type: 'assert_screen_changes',
      intervalMs: 1200,
      minDiffRatio: 0.0005,
      label: '确认视频号画面在播放',
      message: '微信视频号画面变化不足，疑似未进入视频号播放内容',
    },
  ];

  let elapsed = steps.filter((step) => step.type === 'wait').reduce((sum, step) => sum + step.ms, 0);
  let index = 0;
  while (elapsed < safeDuration) {
    const waitMs = Math.min(5000 + (index % 4) * 2000, safeDuration - elapsed);
    if (waitMs > 0) {
      steps.push({ type: 'wait', ms: waitMs, label: `观看视频号 ${Math.round(waitMs / 1000)} 秒` });
      elapsed += waitMs;
    }
    if (elapsed < safeDuration) {
      steps.push({
        type: 'swipe',
        x1: x,
        y1: Math.round(size.height * 0.78),
        x2: x,
        y2: Math.round(size.height * 0.22),
        durationMs: 420,
        label: '上滑下一条视频号内容',
      });
      elapsed += 800;
    }
    index += 1;
  }

  steps.push({ type: 'complete', label: '微信视频号浏览完成' });
  return steps;
}
