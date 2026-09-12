export const APP_STORE_DOWNLOAD_WORKFLOW_ID =
  'upload-download:app-store:download-app';
export const APP_STORE_DOWNLOAD_VALIDATION_MODE = 'app_store_download_v1';
export const DEFAULT_APP_STORE_TARGET = '王者荣耀';
export const DEFAULT_APP_STORE_DURATION_MS = 30 * 1000;

const DEFAULT_SCREEN = { width: 1280, height: 2832 };
const ACTIVE_DOWNLOAD_PATTERN = /%|下载中|安装中|排队|等待|继续/;

export async function executeAppStoreDownload({
  device,
  app,
  targetApp,
  durationMs = DEFAULT_APP_STORE_DURATION_MS,
  startCapture = null,
  sleep = wait,
  onStep = () => {},
}) {
  if (app?.id !== 'app-store' || !app.packageName) {
    throw new Error('app_store_download 只适用于应用市场');
  }
  if (!targetApp?.name || !targetApp.packageName) {
    throw new Error('应用市场下载缺少目标应用');
  }

  const screen = normalizeScreen(await device.getScreenSize?.().catch(() => null));
  const checks = [];
  const safeDuration = Math.max(
    1000,
    Number.isFinite(Number(durationMs)) ? Number(durationMs) : DEFAULT_APP_STORE_DURATION_MS,
  );
  let stepIndex = 0;
  let downloadStarted = false;
  let captureStarted = false;
  let completed = false;

  const stage = async (id, label, action) => {
    stepIndex += 1;
    onStep(stepIndex, label, 5);
    try {
      const value = await action();
      checks.push({ id, label, status: 'passed' });
      return value;
    } catch (error) {
      checks.push({ id, label, status: 'failed', detail: error.message });
      throw error;
    }
  };

  await stage('store_opened', '打开应用市场', async () => {
    await device.forceStopPackage(app.packageName);
    await device.launchPackage(app.packageName);
    return waitForSnapshot({
      device,
      predicate: (snapshot) => Boolean(findSearchControl(snapshot)),
      timeoutMs: 12000,
      sleep,
      message: '应用市场首页未打开',
    });
  });

  await stage('target_searched', `搜索${targetApp.name}`, async () => {
    let snapshot = await getSnapshot(device);
    const search = findSearchControl(snapshot);
    if (!search) throw new Error('应用市场未找到搜索入口');
    await device.tap(search);
    await sleep(500);
    snapshot = await getSnapshot(device);
    const field = findSearchField(snapshot);
    if (!field) throw new Error('应用市场搜索框未打开');
    await device.inputText(targetApp.name, {
      clearExisting: true,
      x: field.centerX,
      y: field.centerY,
    });
    const searchButton = findSearchButton(snapshot);
    if (searchButton) await device.tap(searchButton);
    await sleep(1200);
    return waitForSnapshot({
      device,
      predicate: (value) => Boolean(findTargetResult(value, targetApp.name)),
      timeoutMs: 12000,
      sleep,
      message: `应用市场未找到${targetApp.name}搜索结果`,
    });
  });

  await stage('download_started', `开始下载${targetApp.name}`, async () => {
    let snapshot = await getSnapshot(device);
    let result = findTargetResult(snapshot, targetApp.name);
    if (!result) throw new Error(`未找到${targetApp.name}的应用卡片`);

    if (!isDownloadActive(result.status) && result.status !== '打开') {
      if (!result.action) throw new Error(`${targetApp.name}未找到安装按钮`);
      await device.tap(result.action);
      await sleep(1000);
    }

    snapshot = await waitForSnapshot({
      device,
      predicate: (value) => {
        const current = findTargetResult(value, targetApp.name);
        return Boolean(current && (isDownloadActive(current.status) || current.status === '打开'));
      },
      timeoutMs: 12000,
      sleep,
      message: `${targetApp.name}未进入下载或安装状态`,
    });
    result = findTargetResult(snapshot, targetApp.name);
    downloadStarted = true;
    completed = result.status === '打开';
    if (startCapture && !captureStarted) {
      await startCapture();
      captureStarted = true;
    }
    return snapshot;
  });

  await stage('download_waited', completed ? `${targetApp.name}已下载完成` : `等待下载${safeDuration}毫秒`, async () => {
    const deadline = Date.now() + safeDuration;
    while (!completed && Date.now() < deadline) {
      await sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
      const current = findTargetResult(await getSnapshot(device), targetApp.name);
      if (!current) continue;
      if (current.status === '打开') {
        completed = true;
        break;
      }
      if (!isDownloadActive(current.status)) {
        throw new Error(`${targetApp.name}下载状态异常：${current.status || '未知'}`);
      }
    }
    return { completed, effectiveDurationMs: completed ? null : safeDuration };
  });

  try {
    await stage('target_deleted', `删除${targetApp.name}`, async () => {
      await device.forceStopPackage(app.packageName).catch(() => {});
      await uninstallIfPresent(device, targetApp);
      const installed = await isInstalled(device, targetApp);
      if (installed) throw new Error(`${targetApp.name}卸载后仍存在`);
    });
  } finally {
    // The target app is intentionally removed even when the timed wait fails.
    await uninstallIfPresent(device, targetApp).catch(() => {});
  }

  return {
    validationMode: APP_STORE_DOWNLOAD_VALIDATION_MODE,
    validationChecks: checks,
    replayStepIndex: stepIndex,
    replaySource: APP_STORE_DOWNLOAD_VALIDATION_MODE,
    effectiveDurationMs: completed ? null : safeDuration,
  };
}

async function uninstallIfPresent(device, targetApp) {
  if (!(await isInstalled(device, targetApp))) return false;
  try {
    await device.uninstallPackage(targetApp.packageName);
  } catch (error) {
    if (!/not installed|not found|does not exist|不存在|未安装/i.test(error.message)) {
      throw error;
    }
  }
  return true;
}

async function isInstalled(device, targetApp) {
  const source = String(await device.getInstalledPackages?.() || '');
  return [targetApp.packageName, targetApp.harmonyBundleName]
    .filter(Boolean)
    .some((name) => source.includes(name));
}

function findSearchControl(snapshot) {
  return flatten(snapshot).find((node) =>
    node.id === 'search_icon_button' ||
    (node.type === 'Button' && node.bounds.x1 > node.screen.width * 0.75 && node.bounds.y2 < node.screen.height * 0.15),
  );
}

function findSearchField(snapshot) {
  return flatten(snapshot).find((node) =>
    node.type === 'SearchField' || node.id.includes('searchFrameInput'),
  );
}

function findSearchButton(snapshot) {
  return flatten(snapshot).find((node) =>
    node.textValues.includes('搜索') && node.clickable,
  );
}

function findTargetResult(snapshot, targetName) {
  const exact = String(targetName).trim();
  let found = null;
  const visit = (node, ancestors = []) => {
    if (!node || found) return;
    const attrs = node.attributes || node;
    const bounds = parseBounds(attrs.bounds);
    const path = [...ancestors, node];
    const subtreeText = collectText(node);
    if (
      bounds &&
      (node.clickable === true || String(node.clickable) === 'true' ||
        attrs.clickable === true || String(attrs.clickable) === 'true') &&
      bounds.y1 >= 280 &&
      bounds.y2 <= 900 &&
      subtreeText.some((value) => value === exact)
    ) {
      const action = findAction(node);
      if (action) {
        found = {
          card: node,
          action,
          status: findStatus(node),
          centerY: Math.round((bounds.y1 + bounds.y2) / 2),
        };
        return;
      }
    }
    for (const child of node.children || []) visit(child, path);
  };
  visit(snapshot?.layout || snapshot);
  return found;
}

function findAction(node) {
  const candidates = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    const attrs = value.attributes || value;
    const id = String(attrs.id || attrs.key || '');
    const type = String(attrs.type || '');
    const text = [attrs.text, attrs.originalText].filter(Boolean).join('|');
    const bounds = parseBounds(attrs.bounds);
    if (
      bounds &&
      (id.toLowerCase().includes('downloadbutton') ||
        id.toLowerCase().includes('download_button') ||
        (type === 'Button' && /安装|继续|打开|%|下载/.test(text)))
    ) {
      candidates.push(toNode(value));
    }
    for (const child of value.children || []) visit(child);
  };
  visit(node);
  return candidates.sort((left, right) => right.bounds.x1 - left.bounds.x1)[0] || null;
}

function findStatus(node) {
  return collectText(node).find((value) =>
    /^(安装|继续|打开|下载中|安装中|排队中|等待中|\d+(?:\.\d+)?%)$/.test(value),
  ) || '';
}

function isDownloadActive(status) {
  return ACTIVE_DOWNLOAD_PATTERN.test(String(status || ''));
}

function collectText(node) {
  const values = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    const attrs = value.attributes || value;
    values.push(...[
      attrs.text,
      attrs.originalText,
      attrs.description,
      attrs.contentDescription,
      attrs.hint,
      attrs.label,
    ].map((item) => String(item || '').trim()).filter(Boolean));
    for (const child of value.children || []) visit(child);
  };
  visit(node);
  return values;
}

function flatten(snapshot) {
  const result = [];
  const screen = normalizeScreen(snapshot?.screen);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const attrs = node.attributes || node;
    const bounds = parseBounds(attrs.bounds);
    if (bounds) {
      result.push({
        attributes: attrs,
        bounds,
        centerX: Math.round((bounds.x1 + bounds.x2) / 2),
        centerY: Math.round((bounds.y1 + bounds.y2) / 2),
        clickable: attrs.clickable === true || String(attrs.clickable) === 'true',
        id: String(attrs.id || attrs.key || ''),
        type: String(attrs.type || attrs.componentType || ''),
        textValues: [attrs.text, attrs.originalText, attrs.description, attrs.contentDescription, attrs.hint, attrs.label]
          .map((value) => String(value || '').trim()).filter(Boolean),
        screen,
      });
    }
    for (const child of node.children || []) visit(child);
  };
  visit(snapshot?.layout || snapshot);
  return result;
}

function toNode(node) {
  const attrs = node.attributes || node;
  const bounds = parseBounds(attrs.bounds);
  return {
    ...node,
    bounds,
    centerX: Math.round((bounds.x1 + bounds.x2) / 2),
    centerY: Math.round((bounds.y1 + bounds.y2) / 2),
  };
}

function parseBounds(value) {
  const match = String(value || '').match(/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/);
  if (!match) return null;
  return { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) };
}

async function getSnapshot(device) {
  return device.getUiTextSnapshot();
}

async function waitForSnapshot({ device, predicate, timeoutMs, sleep, message }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await getSnapshot(device);
    if (predicate(snapshot)) return snapshot;
    await sleep(350);
  }
  const snapshot = await getSnapshot(device);
  if (predicate(snapshot)) return snapshot;
  throw new Error(message);
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
