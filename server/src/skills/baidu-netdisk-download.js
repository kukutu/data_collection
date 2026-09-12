export const BAIDU_NETDISK_DOWNLOAD_WORKFLOW_ID =
  'upload-download:baidu-netdisk:download-file';
export const BAIDU_NETDISK_DOWNLOAD_VALIDATION_MODE = 'baidu_netdisk_download_v1';
export const DEFAULT_BAIDU_NETDISK_DURATION_MS = 30 * 1000;

const DEFAULT_SCREEN = { width: 1280, height: 2832 };

export async function executeBaiduNetdiskDownload({
  device,
  app,
  durationMs = DEFAULT_BAIDU_NETDISK_DURATION_MS,
  startCapture = null,
  sleep = wait,
  onStep = () => {},
}) {
  if (app?.id !== 'baidu-netdisk' || !app.packageName) {
    throw new Error('baidu_netdisk_download 只适用于百度网盘');
  }

  const screen = normalizeScreen(await device.getScreenSize?.().catch(() => null));
  const checks = [];
  const safeDuration = Math.max(1000, Number(durationMs) || DEFAULT_BAIDU_NETDISK_DURATION_MS);
  let stepIndex = 0;
  let downloadStarted = false;
  let captureStarted = false;

  const stage = async (id, label, action) => {
    stepIndex += 1;
    onStep(stepIndex, label, 5);
    try {
      const result = await action();
      checks.push({ id, label, status: 'passed' });
      return result;
    } catch (error) {
      checks.push({ id, label, status: 'failed', detail: error.message });
      throw error;
    }
  };

  await stage('file_page_opened', '打开百度网盘文件页', async () => {
    await device.forceStopPackage(app.packageName);
    await device.launchPackage(app.packageName);
    let snapshot = await waitForSnapshot({
      device,
      predicate: (value) => Boolean(findTextNode(value, '文件')),
      timeoutMs: 12000,
      sleep,
      message: '百度网盘未打开',
    });
    const fileTab = findBottomTextNode(snapshot, '文件', screen);
    if (!fileTab) throw new Error('百度网盘未找到左下角文件入口');
    await device.tap(fileTab);
    snapshot = await waitForSnapshot({
      device,
      predicate: (value) => findFirstSelectableRow(value) !== null,
      timeoutMs: 10000,
      sleep,
      message: '百度网盘文件列表未打开',
    });
    return snapshot;
  });

  await stage('first_item_selected', '选择文件列表第一个文件夹', async () => {
    const snapshot = await getSnapshot(device);
    const row = findFirstSelectableRow(snapshot);
    if (!row?.checkbox) throw new Error('未找到第一个文件夹右侧的选择圆点');
    await device.tap(row.checkbox);
    return waitForSnapshot({
      device,
      predicate: (value) => Boolean(findBottomTextNode(value, '下载', screen)),
      timeoutMs: 5000,
      sleep,
      message: '选择文件后未出现下载操作',
    });
  });

  await stage('download_started', '下载选中的百度网盘文件夹', async () => {
    const snapshot = await getSnapshot(device);
    const download = findBottomTextNode(snapshot, '下载', screen);
    if (!download) throw new Error('未找到底部下载操作');
    await device.tap(download);
    await openDownloadTasks({ device, screen, sleep });
    downloadStarted = true;
    if (startCapture && !captureStarted) {
      await startCapture();
      captureStarted = true;
    }
  });

  await stage('download_waited', `等待下载${safeDuration}毫秒`, async () => {
    const deadline = Date.now() + safeDuration;
    while (Date.now() < deadline) {
      const snapshot = await getSnapshot(device);
      if (hasNoActiveTask(snapshot)) return;
      await sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
    }
  });

  await stage('tasks_cleared', '全部清除并删除本地文件', async () => {
    let snapshot = await getSnapshot(device);
    const clear = findTextNode(snapshot, '全部清除');
    if (!clear) throw new Error('百度网盘未找到全部清除');
    await device.tap(clear);
    snapshot = await waitForSnapshot({
      device,
      predicate: (value) => Boolean(findTextNode(value, '同时删除本地文件')),
      timeoutMs: 5000,
      sleep,
      message: '百度网盘清除确认框未出现',
    });
    const checkbox = findCheckboxNearText(snapshot, '同时删除本地文件');
    if (!checkbox) throw new Error('未找到同时删除本地文件选项');
    if (!checkbox.checked) await device.tap(checkbox);
    const confirm = findTextNode(await getSnapshot(device), '确定');
    if (!confirm) throw new Error('未找到百度网盘清除确认按钮');
    await device.tap(confirm);
    await sleep(800);
    if (findTextNode(await getSnapshot(device), '同时删除本地文件')) {
      throw new Error('百度网盘未完成本地文件删除确认');
    }
  });

  return {
    validationMode: BAIDU_NETDISK_DOWNLOAD_VALIDATION_MODE,
    validationChecks: checks,
    replayStepIndex: stepIndex,
    replaySource: BAIDU_NETDISK_DOWNLOAD_VALIDATION_MODE,
    effectiveDurationMs: safeDuration,
  };
}

function findFirstSelectableRow(snapshot) {
  const rows = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const attrs = node.attributes || node;
    const bounds = parseBounds(attrs.bounds);
    if (String(attrs.type) === 'ListItem' && bounds && bounds.y1 > 600 && bounds.y2 < 2500) {
      const checkbox = findDescendant(node, (value) => String((value.attributes || value).type) === 'Checkbox');
      const name = collectText(node).find((value) => value && !/文件不存在|日期|GB|位置/.test(value));
      if (checkbox && name) rows.push({ row: node, checkbox: toNode(checkbox), name, bounds });
    }
    for (const child of node.children || []) visit(child);
  };
  visit(snapshot?.layout || snapshot);
  return rows.sort((left, right) => left.bounds.y1 - right.bounds.y1)[0] || null;
}

function findTransferEntry(snapshot, screen) {
  const nodes = flatten(snapshot).filter((node) =>
    node.clickable && node.bounds.y1 < screen.height * 0.16 &&
    node.centerX > screen.width * 0.72 && node.centerX < screen.width * 0.88,
  );
  return nodes.sort((left, right) => left.centerX - right.centerX)[0] || null;
}

async function openDownloadTasks({ device, screen, sleep }) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const snapshot = await getSnapshot(device);
    if (findTextNode(snapshot, '全部任务') && findTextNode(snapshot, '全部清除')) return snapshot;
    const transfer = findTransferEntry(snapshot, screen);
    if (transfer) {
      await device.tap(transfer).catch(() => {});
      await sleep(700);
    } else {
      await sleep(350);
    }
  }
  throw new Error('百度网盘下载任务页未打开');
}

function findCheckboxNearText(snapshot, text) {
  let result = null;
  const visit = (node) => {
    if (!node || result) return;
    const attrs = node.attributes || node;
    const bounds = parseBounds(attrs.bounds);
    if (bounds && collectText(node).includes(text)) {
      result = findDescendant(node, (value) => String((value.attributes || value).type) === 'Checkbox');
    }
    for (const child of node.children || []) visit(child);
  };
  visit(snapshot?.layout || snapshot);
  return result ? toNode(result) : null;
}

function hasNoActiveTask(snapshot) {
  return !flatten(snapshot).some((node) =>
    node.textValues.some((value) => value.startsWith('进行中(') || value === '等待下载'),
  );
}

function findBottomTextNode(snapshot, text, screen) {
  return flatten(snapshot).find((node) =>
    node.textValues.includes(text) && node.bounds.y1 > screen.height * 0.82,
  ) || null;
}

function findTextNode(snapshot, text) {
  return flatten(snapshot).find((node) => node.textValues.includes(text)) || null;
}

function findDescendant(node, predicate) {
  for (const child of node.children || []) {
    if (predicate(child)) return child;
    const nested = findDescendant(child, predicate);
    if (nested) return nested;
  }
  return null;
}

function collectText(node) {
  const values = [];
  const visit = (value) => {
    const attrs = value.attributes || value;
    values.push(...[attrs.text, attrs.originalText, attrs.description, attrs.contentDescription, attrs.hint, attrs.label]
      .map((item) => String(item || '').trim()).filter(Boolean));
    for (const child of value.children || []) visit(child);
  };
  visit(node);
  return values;
}

function flatten(snapshot) {
  const result = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const attrs = node.attributes || node;
    const bounds = parseBounds(attrs.bounds);
    if (bounds) result.push({
      attributes: attrs,
      bounds,
      centerX: Math.round((bounds.x1 + bounds.x2) / 2),
      centerY: Math.round((bounds.y1 + bounds.y2) / 2),
      clickable: attrs.clickable === true || String(attrs.clickable) === 'true',
      checked: attrs.checked === true || String(attrs.checked) === 'true',
      id: String(attrs.id || attrs.key || ''),
      textValues: [attrs.text, attrs.originalText, attrs.description, attrs.contentDescription, attrs.hint, attrs.label]
        .map((item) => String(item || '').trim()).filter(Boolean),
    });
    for (const child of node.children || []) visit(child);
  };
  visit(snapshot?.layout || snapshot);
  return result;
}

function toNode(node) {
  const attrs = node.attributes || node;
  const bounds = parseBounds(attrs.bounds);
  return {
    bounds,
    centerX: Math.round((bounds.x1 + bounds.x2) / 2),
    centerY: Math.round((bounds.y1 + bounds.y2) / 2),
    clickable: attrs.clickable === true || String(attrs.clickable) === 'true',
    checked: attrs.checked === true || String(attrs.checked) === 'true',
  };
}

function parseBounds(value) {
  const match = String(value || '').match(/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/);
  return match ? { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) } : null;
}

async function getSnapshot(device) { return device.getUiTextSnapshot(); }

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
  return { width: Number(value?.width) || DEFAULT_SCREEN.width, height: Number(value?.height) || DEFAULT_SCREEN.height };
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
