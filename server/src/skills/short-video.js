import { config } from '../config.js';

const DEFAULT_SCREEN = { width: config.screen.defaultWidth, height: config.screen.defaultHeight };
const DEFAULT_DURATION_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;

export function buildShortVideoPlan({ app, durationMs = DEFAULT_DURATION_MS, screen = DEFAULT_SCREEN }) {
  if (!app?.packageName) {
    throw new Error('short-video skill requires an app packageName');
  }

  const safeDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));
  const size = {
    width: Number(screen.width) || DEFAULT_SCREEN.width,
    height: Number(screen.height) || DEFAULT_SCREEN.height,
  };

  const x = Math.round(size.width * 0.5);
  const startY = Math.round(size.height * 0.79);
  const endY = Math.round(size.height * 0.2);
  const feedSwipe = buildFeedSwipe({ app, x, startY, endY, screen: size });
  const steps = buildEntrySteps({ app, x, startY, endY });

  let elapsed = sumWaits(steps);
  let index = 0;

  while (elapsed < safeDuration) {
    const waitMs = Math.min(5000 + (index % 5) * 2000, safeDuration - elapsed);
    if (waitMs > 0) {
      steps.push({ type: 'wait', ms: waitMs, label: `观看 ${Math.round(waitMs / 1000)} 秒` });
      elapsed += waitMs;
    }

    if (elapsed < safeDuration) {
      steps.push({
        type: 'swipe',
        x1: feedSwipe.x1,
        y1: feedSwipe.y1,
        x2: feedSwipe.x2,
        y2: feedSwipe.y2,
        durationMs: feedSwipe.durationMs + (index % 4) * feedSwipe.jitterMs,
        label: '上滑下一条',
      });
      elapsed += 800;
    }

    index += 1;
  }

  steps.push({ type: 'complete', label: `${app.name}浏览完成` });
  return steps;
}

function buildFeedSwipe({ app, x, startY, endY, screen }) {
  if (app.id === 'xiaohongshu') {
    return {
      x1: x,
      y1: Math.round(screen.height * 0.6),
      x2: x,
      y2: Math.round(screen.height * 0.54),
      durationMs: 180,
      jitterMs: 20,
    };
  }

  return {
    x1: x,
    y1: startY,
    x2: x,
    y2: endY,
    durationMs: 320,
    jitterMs: 90,
  };
}

function buildEntrySteps({ app, x, startY, endY }) {
  const steps = [];

  if (app.id === 'xiaohongshu') {
    steps.push(
      { type: 'launch_app', packageName: app.packageName, label: `打开${app.name}` },
      { type: 'wait', ms: 2000, label: '等待小红书启动' },
      {
        type: 'manual_confirm',
        label: '等待人工接管小红书',
        message: '请在手机上手动点入要浏览的小红书视频或笔记详情页，然后在前端点击“我已点入视频，继续”。',
      },
      {
        type: 'assert_foreground_package',
        packageName: app.packageName,
        label: `确认仍在${app.name}`,
      },
      {
        type: 'assert_screen_changes',
        intervalMs: 1200,
        minDiffRatio: 0.0005,
        optional: true,
        label: '确认小红书画面在播放',
        message: `${app.name}画面变化不足，将继续按人工确认后的页面浏览`,
      },
    );
    return steps;
  }

  if (app.id === 'douyin') {
    steps.push(
      { type: 'launch_app', packageName: app.packageName, label: `打开${app.name}` },
      { type: 'wait', ms: 2500, label: '等待抖音启动' },
      {
        type: 'assert_foreground_package',
        packageName: app.packageName,
        label: `确认仍在${app.name}`,
      },
      {
        type: 'assert_screen_changes',
        intervalMs: 1200,
        minDiffRatio: 0.0005,
        optional: true,
        label: '确认抖音画面在播放',
        message: `${app.name}画面变化不足，将继续尝试浏览`,
      },
    );
    return steps;
  }

  steps.push(
    { type: 'launch_app', packageName: app.packageName, label: `打开${app.name}` },
    { type: 'wait', ms: 3000, label: '等待应用加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'tap_text',
      texts: ['稍后', '取消', '暂不', '跳过', '我知道了', '以后再说', '关闭'],
      optional: true,
      partial: true,
      label: '关闭非必要提示',
    },
  );

  steps.push(
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      label: `确认仍在${app.name}`,
    },
    {
      type: 'assert_screen_changes',
      intervalMs: 1200,
      minDiffRatio: 0.0005,
      optional: app.id === 'xiaohongshu',
      label: '确认短视频画面在播放',
      message: `${app.name}画面变化不足，疑似没有进入视频播放内容`,
    },
  );

  return steps;
}

function sumWaits(steps) {
  return steps.filter((step) => step.type === 'wait').reduce((sum, step) => sum + step.ms, 0);
}
