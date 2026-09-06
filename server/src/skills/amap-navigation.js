import { config } from '../config.js';

const DEFAULT_SCREEN = { width: config.screen.defaultWidth, height: config.screen.defaultHeight };
const DEFAULT_DURATION_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const WAIT_CHUNK_MS = 60 * 1000;

export function buildAmapNavigationPlan({
  app,
  destination,
  durationMs = DEFAULT_DURATION_MS,
  screen = DEFAULT_SCREEN,
}) {
  if (!app?.packageName) {
    throw new Error('AMap navigation skill requires an app packageName');
  }
  const cleanDestination = String(destination || '').trim();
  if (!cleanDestination) {
    throw new Error('AMap navigation skill requires a destination');
  }

  const safeDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));
  const size = {
    width: Number(screen.width) || DEFAULT_SCREEN.width,
    height: Number(screen.height) || DEFAULT_SCREEN.height,
  };
  const uri = buildAmapRouteUri(cleanDestination);
  const steps = [
    {
      type: 'open_uri',
      packageName: app.packageName,
      uri,
      label: `打开高德路线: ${cleanDestination}`,
    },
    { type: 'wait', ms: Math.min(8000, safeDuration), label: '等待高德解析路线' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'tap',
      x: Math.round(size.width * 0.5),
      y: Math.round(size.height * 0.92),
      label: '尝试点击开始导航',
    },
    { type: 'assert_foreground_package', packageName: app.packageName, label: '确认仍在高德地图' },
    { type: 'start_capture', label: '开始采集导航内容' },
  ];

  let elapsed = steps
    .filter((step) => step.type === 'wait')
    .reduce((sum, step) => sum + step.ms, 0);

  while (elapsed < safeDuration) {
    const waitMs = Math.min(WAIT_CHUNK_MS, safeDuration - elapsed);
    steps.push({ type: 'wait', ms: waitMs, label: `保持导航 ${Math.round(waitMs / 1000)} 秒` });
    elapsed += waitMs;
  }

  steps.push({ type: 'complete', label: `高德导航到${cleanDestination}会话完成` });
  return steps;
}

function buildAmapRouteUri(destination) {
  const params = new URLSearchParams({
    sourceApplication: 'android-text-controller',
    dname: destination,
    dev: '0',
    t: '0',
  });
  return `androidamap://route?${params.toString()}`;
}
