import { config } from '../config.js';
import { startCaptureBeforeAction } from './capture-timing.js';

export const XUNLEI_UPLOAD_MEDIA_WORKFLOW_ID = 'upload-download:xunlei:upload-media';
export const XUNLEI_UPLOAD_MEDIA_VALIDATION_MODE = 'xunlei_upload_media_v1';

const DEFAULT_SCREEN = {
  width: config.screen.defaultWidth,
  height: config.screen.defaultHeight,
};

export async function executeXunleiUploadMedia({
  device,
  app,
  startCapture = null,
  sleep = wait,
  onStep = () => {},
  timings = {},
} = {}) {
  if (!device) throw new Error('迅雷上传缺少设备适配器');
  if (app?.id !== 'xunlei' || !app.packageName) {
    throw new Error('迅雷上传 skill 只适用于迅雷 App');
  }

  const delays = {
    startupMs: 2500,
    pageMs: 700,
    pickerMs: 900,
    resultMs: 1200,
    ...timings,
  };
  const checks = [];
  let stepIndex = 0;
  const totalSteps = 7 + (startCapture ? 1 : 0);

  const stage = async (id, label, action, detail = '') => {
    stepIndex += 1;
    onStep(stepIndex, label, totalSteps);
    try {
      const value = await action();
      checks.push({
        id,
        label,
        status: 'passed',
        detail: typeof detail === 'function' ? detail(value) : detail,
      });
      return value;
    } catch (error) {
      checks.push({ id, label, status: 'failed', detail: error.message });
      throw error;
    }
  };

  const screen = normalizeScreen(
    (await device.getDeviceStatus?.().catch(() => null))?.screen ||
      (await device.getScreenSize?.().catch(() => null)),
  );

  await stage('app_opened', '打开迅雷并进入传输', async () => {
    await device.forceStopPackage(app.packageName);
    await device.launchPackage(app.packageName);
    await sleep(delays.startupMs);
    await assertForeground(device, app);
    let snapshot = await getSnapshot(device);
    if (!hasText(snapshot, '传输')) throw new Error('迅雷首页未找到传输入口');
    await tapTextNode(device, snapshot, '传输', { minY: screen.height * 0.8 });
    await sleep(delays.pageMs);
    snapshot = await waitForSnapshot({
      device,
      predicate: (value) => hasText(value, '上传') && hasText(value, '传输'),
      timeoutMs: 7000,
      sleep,
      message: '迅雷传输页面未加载',
    });
    return snapshot;
  });

  await stage('upload_tab_opened', '切换到上传页', async () => {
    const snapshot = await getSnapshot(device);
    const node = findTextNode(snapshot, '上传', {
      maxY: screen.height * 0.18,
    });
    if (!node) throw new Error('迅雷传输页未找到上传标签');
    await device.tap(node);
    await sleep(delays.pageMs);
    return waitForSnapshot({
      device,
      predicate: (value) => hasText(value, '上传') && !hasText(value, '下载中·'),
      timeoutMs: 5000,
      sleep,
      message: '迅雷上传页未加载',
    });
  });

  await stage('upload_menu_opened', '打开上传菜单', async () => {
    const snapshot = await getSnapshot(device);
    const plus = findTopRightAction(snapshot, screen);
    if (!plus) throw new Error('迅雷上传页未找到右上角加号');
    await device.tap(plus);
    await sleep(delays.pageMs);
    return waitForSnapshot({
      device,
      predicate: (value) => hasText(value, '上传至云盘'),
      timeoutMs: 5000,
      sleep,
      message: '迅雷上传菜单未打开',
    });
  });

  await stage('cloud_upload_opened', '选择上传至云盘', async () => {
    const snapshot = await getSnapshot(device);
    await tapTextNode(device, snapshot, '上传至云盘');
    await sleep(delays.pageMs);
    return waitForSnapshot({
      device,
      predicate: (value) => hasText(value, '相册'),
      timeoutMs: 5000,
      sleep,
      message: '迅雷云盘上传选项未打开',
    });
  });

  await stage('picker_opened', '打开系统相册', async () => {
    const snapshot = await getSnapshot(device);
    await tapTextNode(device, snapshot, '相册');
    await sleep(delays.pickerMs);
    return waitForSnapshot({
      device,
      predicate: isPicker,
      timeoutMs: 7000,
      sleep,
      message: '系统相册选择器未打开',
    });
  });

  await stage('first_media_selected', '选择相册第一项图片或视频', async () => {
    let snapshot = await getSnapshot(device);
    const selector = findFirstMediaSelector(snapshot, screen);
    if (!selector) throw new Error('系统相册未找到可选择的第一项图片或视频');
    await device.tap(selector);
    await sleep(delays.pageMs);
    snapshot = await waitForSnapshot({
      device,
      predicate: (value) => /已选\s*1\//.test(allText(value)),
      timeoutMs: 5000,
      sleep,
      message: '首个图片或视频未选中',
    });
    return snapshot;
  });

  if (startCapture) {
    await stage(
      'capture_started',
      '开始采集迅雷上传流量和屏幕',
      () => startCaptureBeforeAction(startCapture, sleep),
      '已在确认上传前预留1秒采集窗口',
    );
  }

  await stage('upload_confirmed', '完成媒体选择并确认云盘路径', async () => {
    let snapshot = await getSnapshot(device);
    await tapTextNode(device, snapshot, '完成', { minY: screen.height * 0.78 });
    await sleep(delays.resultMs);
    snapshot = await waitForSnapshot({
      device,
      predicate: (value) => hasText(value, '请选择云盘路径') || hasText(value, '上传任务创建成功'),
      timeoutMs: 7000,
      sleep,
      message: '上传路径确认页未出现',
    });
    if (hasText(snapshot, '请选择云盘路径')) {
      await tapTextNode(device, snapshot, '确认', { minY: screen.height * 0.78 });
      await sleep(delays.resultMs);
    }
    return waitForSnapshot({
      device,
      predicate: (value) =>
        hasText(value, '上传任务创建成功') ||
        (hasText(value, '已完成·') && !isPicker(value)),
      timeoutMs: 8000,
      sleep,
      message: '迅雷未确认上传任务已创建',
    });
  });

  return {
    validationMode: XUNLEI_UPLOAD_MEDIA_VALIDATION_MODE,
    validationChecks: checks,
    replayStepIndex: stepIndex,
    replaySource: XUNLEI_UPLOAD_MEDIA_VALIDATION_MODE,
  };
}

function findTopRightAction(snapshot, screen) {
  return flatten(snapshot)
    .filter((node) => node.clickable && node.bounds)
    .filter((node) => node.bounds.x1 >= screen.width * 0.68)
    .filter((node) => node.bounds.y1 >= screen.height * 0.04 && node.bounds.y2 <= screen.height * 0.16)
    .sort((left, right) => left.centerX - right.centerX)[0] || null;
}

function findFirstMediaSelector(snapshot, screen) {
  return flatten(snapshot)
    .filter((node) => node.type === 'Checkbox' && node.bounds)
    .filter((node) => node.bounds.y1 > screen.height * 0.25 && node.bounds.y2 < screen.height * 0.9)
    .sort((left, right) => left.centerY - right.centerY || left.centerX - right.centerX)[0] || null;
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
  if (!node) throw new Error(`未找到文本: ${text}`);
  await device.tap(node);
}

function isPicker(snapshot) {
  return (
    (hasText(snapshot, '图片和视频') && hasText(snapshot, '已选 0/100')) ||
    /已选\s*\d+\//.test(allText(snapshot))
  );
}

function hasText(snapshot, value) {
  return allText(snapshot).includes(value);
}

function allText(snapshot) {
  return (snapshot?.values || []).join('\n');
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
        type: String(attributes.type || attributes.componentType || ''),
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

function parseBounds(value) {
  const match = String(value || '').match(/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/);
  if (!match) return null;
  return { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) };
}

async function getSnapshot(device) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await device.getUiTextSnapshot();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(450);
    }
  }
  throw lastError;
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

function normalizeScreen(value) {
  return {
    width: Number(value?.width) || DEFAULT_SCREEN.width,
    height: Number(value?.height) || DEFAULT_SCREEN.height,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
