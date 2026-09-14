import { config } from '../config.js';
import { startCaptureBeforeAction } from './capture-timing.js';

export const XUNLEI_DOWNLOAD_WORKFLOW_ID = 'upload-download:xunlei:download-file';
export const XUNLEI_DOWNLOAD_VALIDATION_MODE = 'xunlei_download_v1';
export const DEFAULT_XUNLEI_MAGNET =
  'magnet:?xt=urn:btih:8C9F4DB08497563EF6EB01CF81199F645DA0954B';

const DEFAULT_SCREEN = {
  width: config.screen.defaultWidth,
  height: config.screen.defaultHeight,
};

export async function executeXunleiDownload({
  device,
  app,
  magnetUrl = DEFAULT_XUNLEI_MAGNET,
  durationMs = 30_000,
  startCapture = null,
  sleep = wait,
  onStep = () => {},
  timings = {},
} = {}) {
  if (!device) throw new Error('迅雷下载缺少设备适配器');
  if (app?.id !== 'xunlei' || !app.packageName) {
    throw new Error('迅雷下载 skill 只适用于迅雷 App');
  }
  if (!isMagnetUrl(magnetUrl)) throw new Error('请输入有效的 magnet 磁力链接');

  const delays = {
    startupMs: 2500,
    pageMs: 700,
    taskMs: 1800,
    cleanupMs: 800,
    ...timings,
  };
  const screen = normalizeScreen(
    (await device.getDeviceStatus?.().catch(() => null))?.screen ||
      (await device.getScreenSize?.().catch(() => null)),
  );
  const safeDuration = Math.max(1000, Number(durationMs) || 30_000);
  const checks = [];
  let stepIndex = 0;
  let taskTitle = '';
  let downloadStarted = false;
  const totalSteps = 5 + (startCapture ? 1 : 0);

  const stage = async (id, label, action) => {
    stepIndex += 1;
    onStep(stepIndex, label, totalSteps);
    try {
      const value = await action();
      checks.push({ id, label, status: 'passed' });
      return value;
    } catch (error) {
      checks.push({ id, label, status: 'failed', detail: error.message });
      throw error;
    }
  };

  await stage('app_opened', '打开迅雷下载页', async () => {
    await device.forceStopPackage(app.packageName);
    await device.launchPackage(app.packageName);
    await sleep(delays.startupMs);
    await assertForeground(device, app);
    const snapshot = await waitForSnapshot({
      device,
      predicate: (value) => hasText(value, '新建下载') || hasText(value, '搜资源'),
      timeoutMs: 8000,
      sleep,
      message: '迅雷首页未加载',
    });
    if (!hasText(snapshot, '新建下载')) throw new Error('迅雷首页未找到新建下载入口');
    return snapshot;
  });

  await stage('magnet_opened', '用迅雷打开磁力链接参数', async () => {
    if (typeof device.openUri !== 'function') throw new Error('当前设备适配器不支持打开磁力链接');
    await device.openUri({ uri: magnetUrl, packageName: app.packageName });
    const next = await waitForSnapshot({
      device,
      predicate: (value) => hasText(value, '下载到手机'),
      timeoutMs: 8000,
      sleep,
      message: '迅雷未打开下载文件选择页',
    });
    taskTitle = extractTaskTitle(next, magnetUrl);
    return next;
  });

  try {
    if (startCapture) {
      await stage('capture_started', '开始采集迅雷下载流量', () => startCaptureBeforeAction(startCapture, sleep));
    }
    await stage('download_started', '开始下载磁力任务', async () => {
      const snapshot = await getSnapshot(device);
      await tapTextNode(device, snapshot, '下载到手机', { minY: screen.height * 0.75 });
      downloadStarted = true;
      await sleep(delays.taskMs);
      const transfer = await openTransferPage({ device, screen, sleep });
      const row = findDownloadRow(transfer, screen, taskTitle);
      if (!row) throw new Error('迅雷传输页未找到刚创建的下载任务');
      return transfer;
    });

    await stage('download_timed', `下载运行 ${formatDuration(safeDuration)}`, () => sleep(safeDuration));
  } finally {
    if (downloadStarted) {
      await cleanupDownload({
        device,
        screen,
        taskTitle,
        sleep,
        timings: delays,
        onStep: (label) => {
          stepIndex += 1;
          onStep(stepIndex, label, totalSteps);
        },
      }).then(
        () => checks.push({ id: 'download_deleted', label: '删除迅雷下载内容', status: 'passed' }),
        (error) => checks.push({ id: 'download_deleted', label: '删除迅雷下载内容', status: 'failed', detail: error.message }),
      );
    }
  }

  const failed = checks.find((check) => check.status === 'failed');
  if (failed) throw new Error(failed.detail || failed.label);
  return {
    validationMode: XUNLEI_DOWNLOAD_VALIDATION_MODE,
    validationChecks: checks,
    replayStepIndex: stepIndex,
    replaySource: XUNLEI_DOWNLOAD_VALIDATION_MODE,
    effectiveDurationMs: safeDuration,
  };
}

async function cleanupDownload({ device, screen, taskTitle, sleep, timings, onStep }) {
  onStep('清理迅雷下载内容');
  let transfer = await openTransferPage({ device, screen, sleep });
  let row = findDownloadRow(transfer, screen, taskTitle);
  if (!row) return;

  if (hasText(transfer, '下载中')) {
    const pause = findTaskPauseControl(transfer, screen, row);
    if (pause) {
      await device.tap(pause);
      transfer = await waitForSnapshot({
        device,
        predicate: (value) => hasText(value, '已暂停') || !taskTitle || !hasText(value, taskTitle),
        timeoutMs: 4000,
        sleep,
        message: '迅雷下载任务未暂停',
      });
      row = findDownloadRow(transfer, screen, taskTitle);
      if (!row) return;
    }
  }

  await device.longPress({
    ...row,
    x: row.longPressX || row.centerX,
    y: row.longPressY || row.centerY,
  });
  await sleep(timings.cleanupMs);
  let snapshot = await waitForSnapshot({
    device,
    predicate: (value) => hasText(value, '删除'),
    timeoutMs: 3000,
    sleep,
    message: '长按迅雷下载任务后未出现删除操作',
  });
  await tapTextNode(device, snapshot, '删除', { minY: screen.height * 0.75 });
  snapshot = await waitForSnapshot({
    device,
    predicate: (value) => hasText(value, '彻底删除'),
    timeoutMs: 3000,
    sleep,
    message: '迅雷删除确认框未出现',
  });
  await tapTextNode(device, snapshot, '彻底删除', { minY: screen.height * 0.75 });
  await waitForSnapshot({
    device,
    predicate: (value) => !taskTitle || !hasText(value, taskTitle),
    timeoutMs: 6000,
    sleep,
    message: '迅雷下载内容未确认删除',
  });
}

function findTaskPauseControl(snapshot, screen, row) {
  return flatten(snapshot)
    .filter((node) => node.clickable && node.bounds)
    .filter((node) => containsBounds(row.bounds, node.bounds))
    .filter((node) => node.bounds.x1 >= screen.width * 0.86)
    .sort((left, right) => right.centerX - left.centerX)[0] || null;
}

async function openTransferPage({ device, screen, sleep }) {
  let snapshot = await getSnapshot(device);
  const transfer = findTextNode(snapshot, '传输', { minY: screen.height * 0.8 });
  if (transfer) {
    await device.tap(transfer);
    await sleep(500);
  }
  snapshot = await waitForSnapshot({
    device,
    predicate: (value) => hasText(value, '下载中') || hasText(value, '暂无进行中的任务'),
    timeoutMs: 8000,
    sleep,
    message: '迅雷传输页未加载',
  });
  const all = findTextNode(snapshot, '全部', { maxY: screen.height * 0.3 });
  if (all) {
    await device.tap(all);
    await sleep(400);
    snapshot = await getSnapshot(device);
  }
  return snapshot;
}

function findDownloadRow(snapshot, screen, title) {
  const nodes = flatten(snapshot);
  const titleNode = title
    ? nodes.find((node) => node.textValues.some((value) => value.includes(title) || title.includes(value)))
    : null;
  const candidates = nodes
    .filter((node) => node.clickable && node.bounds)
    .filter((node) => node.bounds.y1 > screen.height * 0.22 && node.bounds.y1 < screen.height * 0.8)
    .filter((node) => node.bounds.x2 - node.bounds.x1 > screen.width * 0.7)
    .filter((node) => node.bounds.y2 - node.bounds.y1 < screen.height * 0.3);
  if (titleNode) {
    const containing = candidates
      .filter((node) => containsBounds(node.bounds, titleNode.bounds))
      .sort((left, right) => area(left.bounds) - area(right.bounds));
    if (containing.length) {
      return {
        ...containing[0],
        longPressX: titleNode.centerX,
        longPressY: titleNode.centerY,
      };
    }
  }
  return candidates.sort((left, right) => left.centerY - right.centerY)[0] || null;
}

function extractTaskTitle(snapshot, magnetUrl) {
  return (snapshot?.values || [])
    .map((value) => String(value).trim())
    .filter((value) => value.length >= 8 && value !== magnetUrl)
    .filter((value) => !/^(下载到手机|全选|仅视频|已选|9\.6GB|KB|MB|GB)/.test(value))
    .sort((left, right) => right.length - left.length)[0] || '';
}

function findTextNode(snapshot, text, { minY = 0, maxY = Infinity } = {}) {
  return flatten(snapshot).find((node) =>
    node.bounds &&
    node.centerY >= minY &&
    node.centerY <= maxY &&
    node.textValues.includes(text),
  ) || null;
}

async function tapTextNode(device, snapshot, text, options = {}) {
  const node = findTextNode(snapshot, text, options);
  if (!node) throw new Error(`未找到文本 ${text}`);
  await device.tap(node);
}

async function getSnapshot(device) {
  return device.getUiTextSnapshot();
}

async function waitForSnapshot({ device, predicate, timeoutMs, sleep, message }) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await getSnapshot(device);
  while (Date.now() < deadline) {
    if (predicate(snapshot)) return snapshot;
    await sleep(350);
    snapshot = await getSnapshot(device);
  }
  if (predicate(snapshot)) return snapshot;
  throw new Error(message);
}

async function assertForeground(device, app) {
  const focus = await device.getCurrentFocus?.().catch(() => null);
  const names = [app.packageName, app.harmonyBundleName].filter(Boolean);
  if (focus?.packageName && !names.includes(focus.packageName) && !names.includes(focus.bundleName)) {
    throw new Error('当前前台不是迅雷');
  }
}

function flatten(snapshot) {
  const result = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const attributes = node.attributes || node.attrs || node;
    const bounds = parseBounds(attributes.bounds);
    if (bounds) {
      result.push({
        attributes,
        bounds,
        centerX: Math.round((bounds.x1 + bounds.x2) / 2),
        centerY: Math.round((bounds.y1 + bounds.y2) / 2),
        clickable: attributes.clickable === true || String(attributes.clickable) === 'true',
        textValues: [
          attributes.text,
          attributes.originalText,
          attributes.description,
          attributes.contentDescription,
          attributes.hint,
          attributes.label,
        ].map((value) => String(value || '').trim()).filter(Boolean),
      });
    }
    for (const child of node.children || []) visit(child);
  };
  visit(snapshot?.layout || snapshot);
  return result;
}

function hasText(snapshot, value) {
  return (snapshot?.values || []).join('\n').includes(value);
}

function parseBounds(value) {
  const match = String(value || '').match(/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/);
  if (!match) return null;
  return { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) };
}

function containsBounds(outer, inner) {
  return outer.x1 <= inner.x1 && outer.y1 <= inner.y1 && outer.x2 >= inner.x2 && outer.y2 >= inner.y2;
}

function area(bounds) {
  return Math.max(0, bounds.x2 - bounds.x1) * Math.max(0, bounds.y2 - bounds.y1);
}

function isMagnetUrl(value) {
  return /^magnet:\?xt=urn:btih:[a-z0-9]{32,64}(?:&|$)/i.test(String(value || '').trim());
}

function normalizeScreen(value) {
  return {
    width: Number(value?.width) || DEFAULT_SCREEN.width,
    height: Number(value?.height) || DEFAULT_SCREEN.height,
  };
}

function formatDuration(ms) {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
