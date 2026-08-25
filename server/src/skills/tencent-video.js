const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const WAIT_CHUNK_MS = 60 * 1000;

export function buildTencentVideoPlaybackPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
}) {
  if (!app?.packageName) {
    throw new Error('Tencent Video skill requires an app packageName');
  }

  const safeDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));
  const steps = [
    { type: 'keyevent', code: 'KEYCODE_BACK', label: '关闭可能残留的跳转弹窗' },
    { type: 'tap_resource', resourceId: 'android:id/button2', optional: true, label: '取消系统跳转确认' },
    { type: 'force_stop', packageName: app.packageName, label: '重置腾讯视频状态' },
    { type: 'launch_app', packageName: app.packageName, label: `打开${app.name}` },
    { type: 'wait', ms: Math.min(6000, safeDuration), label: '等待腾讯视频首页加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'manual_confirm',
      label: '等待人工接管腾讯视频',
      message: '请在手机上手动打开要观看的腾讯视频，并切到横屏全屏播放，然后在前端点击“我已点入视频，继续”。',
    },
    { type: 'wait', ms: 1500, label: '等待全屏播放稳定' },
    {
      type: 'assert_orientation',
      landscape: true,
      label: '确认已进入横屏全屏',
      message: '腾讯视频未进入横屏全屏播放',
    },
    { type: 'assert_no_sensitive_prompt', label: '检查播放页权限弹窗' },
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      label: '确认仍在腾讯视频播放页',
    },
    { type: 'keyevent', code: 'KEYCODE_MEDIA_PLAY', label: '恢复腾讯视频播放' },
    { type: 'wait', ms: 800, label: '等待腾讯视频播放状态更新' },
    {
      type: 'assert_media_playing',
      packageName: app.packageName,
      label: '确认腾讯视频媒体会话在播放',
      message: '腾讯视频未检测到播放状态，疑似未进入真实播放页',
    },
  ];

  let elapsed = steps
    .filter((step) => step.type === 'wait')
    .reduce((sum, step) => sum + step.ms, 0);

  while (elapsed < safeDuration) {
    const waitMs = Math.min(WAIT_CHUNK_MS, safeDuration - elapsed);
    steps.push({ type: 'wait', ms: waitMs, silent: true });
    elapsed += waitMs;
  }

  steps.push({ type: 'complete', label: '腾讯视频播放会话完成' });
  return steps;
}
