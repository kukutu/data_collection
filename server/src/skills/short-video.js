import { config } from '../config.js';

const DEFAULT_SCREEN = { width: config.screen.defaultWidth, height: config.screen.defaultHeight };
const DEFAULT_DURATION_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const XIGUA_FEED_EVIDENCE = [/精选/, /关注/, /分享/];
const TOUTIAO_VIDEO_FEED_EVIDENCE = [/精选/, /关注/, /分享/, /视频/];

export function buildShortVideoPlan({ app, durationMs = DEFAULT_DURATION_MS, screen = DEFAULT_SCREEN }) {
  if (!app?.packageName) {
    throw new Error('short-video skill requires an app packageName');
  }
  if (!Number.isFinite(Number(durationMs)) || Number(durationMs) <= 0) {
    throw new Error('Invalid short-video duration');
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
  const steps = buildEntrySteps({ app, size, x, startY, endY });

  let elapsed = sumWaits(steps);
  let index = 0;

  while (elapsed < safeDuration) {
    const waitMs = Math.min(5000 + (index % 5) * 2000, safeDuration - elapsed);
    if (waitMs > 0) {
      steps.push({ type: 'wait', ms: waitMs, label: `观看 ${Math.round(waitMs / 1000)} 秒` });
      elapsed += waitMs;
    }

    if (elapsed < safeDuration) {
      if (app.id === 'bilibili' || app.id === 'xiaohongshu') {
        steps.push({ type: 'assert_foreground_package', packageName: app.packageName,
          label: app.id === 'bilibili' ? '切换前确认仍在 B站' : '切换前确认仍在小红书' });
      }
      steps.push({
        type: 'swipe',
        x1: feedSwipe.x1,
        y1: feedSwipe.y1,
        x2: feedSwipe.x2,
        y2: feedSwipe.y2,
        durationMs: feedSwipe.durationMs + (index % 4) * feedSwipe.jitterMs,
        referenceScreen: size,
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
      y1: Math.round(screen.height * 0.78),
      x2: x,
      y2: Math.round(screen.height * 0.25),
      durationMs: 420,
      jitterMs: 30,
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

function buildEntrySteps({ app, size, x, startY, endY }) {
  const steps = [];

  if (app.id === 'bilibili') {
    return [
      {
        type: 'manual_confirm',
        label: '等待用户进入 B站视频',
        message: '请手动进入 B站可上下切换的竖屏视频页，然后点击“我已进入视频，继续”。',
        confirmLabel: '我已进入视频，继续',
      },
      {
        type: 'assert_foreground_package', packageName: app.packageName,
        label: '确认当前前台为 B站',
        message: '当前不在 B站，请进入视频页后重新执行。',
      },
      {
        type: 'assert_screen_changes', intervalMs: 1500, minDiffRatio: 0.0005,
        label: '确认 B站视频画面正在变化',
        message: '未检测到播放画面变化，请确认视频已开始播放。',
      },
      { type: 'start_capture', label: '开始采集 B站视频' },
    ];
  }

  if (app.id === 'xiaohongshu') {
    return [
      {
        type: 'manual_confirm',
        label: '等待用户进入小红书视频',
        message: '请手动点入小红书可上下切换的视频页，然后点击“我已进入视频，继续”。',
        confirmLabel: '我已进入视频，继续',
      },
      {
        type: 'assert_foreground_package',
        packageName: app.packageName,
        label: '确认当前前台为小红书',
        message: '当前不在小红书，请点入视频页后重新执行。',
      },
      {
        type: 'assert_screen_changes',
        intervalMs: 1200,
        minDiffRatio: 0.0005,
        label: '确认小红书视频画面正在变化',
        message: '未检测到小红书播放画面变化，请确认视频已开始播放。',
      },
      { type: 'start_capture', label: '开始采集小红书视频内容' },
    ];
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
      { type: 'start_capture', label: '开始采集抖音内容' },
    );
    return steps;
  }

  if (app.id === 'kuaishou') {
    steps.push(
      { type: 'launch_app', packageName: app.packageName, label: `打开${app.name}` },
      { type: 'wait', ms: 3000, label: '等待快手启动' },
      { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
      {
        type: 'tap_text',
        texts: ['忽略', '暂不开启', '稍后', '取消'],
        optional: true,
        partial: false,
        label: '关闭快手推送通知提示',
      },
      { type: 'wait', ms: 500, label: '等待快手提示关闭' },
      {
        type: 'assert_ui_text',
        none: ['打开推送通知', '去开启'],
        message: '快手推送通知提示仍未关闭，停止浏览以避免滑动被拦截',
        label: '确认快手提示已关闭',
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
        label: '确认快手短视频画面在播放',
        message: '快手画面变化不足，疑似没有进入短视频播放内容',
      },
      { type: 'start_capture', label: '开始采集快手内容' },
    );
    return steps;
  }

  if (app.id === 'xigua') {
    steps.push(
      { type: 'force_stop', packageName: app.packageName, label: '重启西瓜视频以回到精选视频流' },
      { type: 'launch_app', packageName: app.packageName, label: '打开西瓜视频' },
      { type: 'wait', ms: 5000, label: '等待西瓜视频精选页加载' },
      { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
      {
        type: 'tap_text',
        texts: ['稍后', '取消', '暂不', '跳过', '我知道了'],
        optional: true,
        partial: true,
        label: '关闭西瓜视频非必要提示',
      },
      {
        type: 'assert_foreground_package',
        packageName: app.packageName,
        label: '确认西瓜视频仍在前台',
      },
      {
        type: 'assert_ui_text',
        all: XIGUA_FEED_EVIDENCE,
        label: '确认西瓜视频精选视频流已打开',
        message: '西瓜视频未出现精选视频流控件，停止以避免在错误页面滑动',
      },
      {
        type: 'assert_screen_changes',
        intervalMs: 1200,
        minDiffRatio: 0.0005,
        label: '确认西瓜视频画面在播放',
        message: '西瓜视频画面变化不足，不能判定为视频播放内容',
      },
      { type: 'start_capture', label: '开始采集西瓜视频内容' },
    );
    return steps;
  }

  if (app.id === 'toutiao') {
    const bottomRegion = {
      minX: 0,
      maxX: size.width,
      minY: Math.round(size.height * 0.84),
      maxY: size.height,
    };

    steps.push(
      { type: 'force_stop', packageName: app.packageName, label: '重启头条以回到首页' },
      { type: 'launch_app', packageName: app.packageName, label: '打开头条' },
      { type: 'wait', ms: 5000, label: '等待头条首页加载' },
      { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
      {
        type: 'tap_text',
        texts: ['稍后', '取消', '暂不', '跳过', '我知道了', '以后再说'],
        optional: true,
        partial: true,
        label: '关闭头条非必要提示',
      },
      {
        type: 'tap_text_region',
        texts: ['视频'],
        region: bottomRegion,
        optional: true,
        label: '点击头条底部视频入口',
      },
      {
        type: 'tap',
        x: Math.round(size.width * 0.3),
        y: Math.round(size.height * 0.935),
        label: '兜底点击头条底部视频入口',
      },
      { type: 'wait', ms: 5000, label: '等待头条全屏视频流加载' },
      {
        type: 'assert_foreground_package',
        packageName: app.packageName,
        label: '确认头条仍在前台',
      },
      {
        type: 'assert_ui_text',
        all: TOUTIAO_VIDEO_FEED_EVIDENCE,
        label: '确认头条全屏视频流已打开',
        message: '头条未出现视频流频道和互动控件，停止以避免在首页误滑',
      },
      {
        type: 'assert_screen_changes',
        intervalMs: 1200,
        minDiffRatio: 0.0005,
        label: '确认头条视频画面在播放',
        message: '头条视频画面变化不足，不能判定为视频播放内容',
      },
      { type: 'start_capture', label: '开始采集头条视频内容' },
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
    { type: 'start_capture', label: `开始采集${app.name}内容` },
  );

  return steps;
}

function sumWaits(steps) {
  return steps.filter((step) => step.type === 'wait').reduce((sum, step) => sum + step.ms, 0);
}
