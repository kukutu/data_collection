import { config } from '../config.js';

export const IQIYI_LIVE_WORKFLOW_ID = 'live:iqiyi:live-browse';
export const IQIYI_LIVE_VALIDATION_MODE = 'iqiyi_live_browse_v1';

const DEFAULT_SCREEN = {
  width: config.screen.defaultWidth,
  height: config.screen.defaultHeight,
};
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MIN_SWITCH_INTERVAL_MS = 1000;
const DEFAULT_SWITCH_MIN_MS = 2 * 60 * 1000;
const DEFAULT_SWITCH_MAX_MS = 5 * 60 * 1000;
const DEFAULT_TIMINGS = Object.freeze({
  startupMs: 6000,
  channelMs: 3000,
  roomMs: 4500,
  recoveryMs: 1500,
  listSwipeMs: 1200,
  switchSwipeMs: 1800,
  moreLiveMs: 1800,
  motionMs: 1500,
  switchBufferMs: 5000,
});

const LIVE_DIRECTORY_TABS = ['推荐', '电商', '体育', '明星陪看'];
const BOTTOM_NAVIGATION = ['首页', '免费', '会员', '我的'];
const ROOM_TEXT_EVIDENCE = ['更多直播', '说点什么...'];
const UNAVAILABLE_EVIDENCE = [
  /未开播/,
  /已下播/,
  /直播已结束/,
  /主播暂时离开/,
  /直播已关闭/,
];

export async function executeIqiyiLiveBrowse({
  device,
  app,
  durationMs = 5 * 60 * 1000,
  switchIntervalMs = null,
  startCapture = null,
  onStep = () => {},
  sleep = wait,
  now = () => Date.now(),
  random = Math.random,
  timings = {},
} = {}) {
  if (!device) throw new Error('爱奇艺直播缺少设备适配器');
  if (app?.id !== 'iqiyi' || !app.packageName) {
    throw new Error('爱奇艺直播 skill 只能用于爱奇艺 App');
  }

  const delays = { ...DEFAULT_TIMINGS, ...timings };
  const effectiveDurationMs = normalizeDurationMs(durationMs);
  const effectiveSwitchIntervalMs = normalizeSwitchIntervalMs(switchIntervalMs);
  const validationChecks = [];
  const totalSteps = 6 + (startCapture ? 1 : 0);
  let replayStepIndex = 0;
  let screen = DEFAULT_SCREEN;

  const runStage = async (id, label, action, detail = '') => {
    replayStepIndex += 1;
    onStep(replayStepIndex, label, totalSteps);
    try {
      const value = await action();
      validationChecks.push({
        id,
        label,
        status: 'passed',
        detail: typeof detail === 'function' ? detail(value) : detail,
      });
      return value;
    } catch (error) {
      validationChecks.push({
        id,
        label,
        status: 'failed',
        detail: error.message,
      });
      throw error;
    }
  };

  await runStage('device_connected', '确认爱奇艺直播测试设备', async () => {
    const status = await device.getDeviceStatus?.();
    if (status && !status.connected) throw new Error('未检测到已连接设备');
    screen = normalizeScreen(
      status?.screen || (await device.getScreenSize?.().catch(() => null)),
    );
    return status;
  });

  const directorySnapshot = await runStage(
    'live_directory_opened',
    '冷启动爱奇艺并进入顶部直播频道',
    () =>
      openIqiyiLiveDirectory({
        device,
        app,
        screen,
        delays,
        sleep,
        now,
      }),
    (snapshot) => `识别到 ${findIqiyiLiveCardPoints(snapshot, screen).length} 张直播卡片`,
  );

  const roomSnapshot = await runStage(
    'live_room_opened',
    '进入爱奇艺正在直播的房间',
    () =>
      openIqiyiLiveRoom({
        device,
        app,
        screen,
        directorySnapshot,
        delays,
        sleep,
        now,
      }),
    describeIqiyiLiveRoom,
  );

  await runStage(
    'live_room_verified',
    '确认爱奇艺真实直播间控件',
    async () => {
      if (!isIqiyiLiveRoom(roomSnapshot)) {
        throw new Error('爱奇艺直播间缺少主播、更多直播或评论输入控件');
      }
      await assertIqiyiForeground(device, app);
      return roomSnapshot;
    },
    describeIqiyiLiveRoom,
  );

  await runStage(
    'live_motion_verified',
    '确认爱奇艺直播画面持续变化',
    () =>
      assertScreenChanges({
        device,
        intervalMs: delays.motionMs,
        minimum: 0.0005,
        sleep,
      }),
    (ratio) => `画面变化率 ${ratio.toFixed(5)}`,
  );

  if (startCapture) {
    await runStage(
      'capture_started',
      '开始采集爱奇艺直播内容',
      () => startCapture(),
      '真实直播间和动态画面验证通过后启动采集',
    );
  }

  const browseResult = await runStage(
    'duration_observed',
    '按设置时长浏览并切换爱奇艺直播',
    () =>
      browseIqiyiLive({
        device,
        app,
        screen,
        initialSnapshot: roomSnapshot,
        durationMs: effectiveDurationMs,
        switchIntervalMs: effectiveSwitchIntervalMs,
        delays,
        sleep,
        now,
        random,
      }),
    (result) =>
      `浏览 ${result.observedMs}ms，切换 ${result.switchCount} 次，` +
      `下滑成功 ${result.swipeSwitchCount} 次，列表回退 ${result.fallbackSwitchCount} 次`,
  );

  return {
    validationMode: IQIYI_LIVE_VALIDATION_MODE,
    validationChecks,
    effectiveDurationMs,
    effectiveSwitchIntervalMs,
    replayStepIndex,
    replaySource: IQIYI_LIVE_VALIDATION_MODE,
    switchCount: browseResult.switchCount,
    browseResult,
  };
}

async function openIqiyiLiveDirectory({
  device,
  app,
  screen,
  delays,
  sleep,
  now,
}) {
  await device.forceStopPackage(app.packageName);
  await device.launchPackage(app.packageName);
  await sleep(delays.startupMs);
  await assertIqiyiForeground(device, app);

  let snapshot = await getSnapshot(device);
  if (isIqiyiLiveRoom(snapshot)) {
    await device.keyevent('KEYCODE_BACK');
    await sleep(delays.recoveryMs);
    snapshot = await getSnapshot(device);
  }
  if (isIqiyiLiveDirectory(snapshot)) return snapshot;

  const liveEntry = findTextTapPoint(snapshot, '直播', {
    screen,
    maxYRatio: 0.2,
  });
  await device.tap(liveEntry || point(screen, 0.1, 0.127));
  await sleep(delays.channelMs);
  return waitForSnapshot({
    device,
    predicate: isIqiyiLiveDirectory,
    timeoutMs: 9000,
    pollMs: 600,
    sleep,
    now,
    message: '爱奇艺顶部直播频道未加载出可用直播卡片',
  });
}

async function openIqiyiLiveRoom({
  device,
  app,
  screen,
  directorySnapshot,
  delays,
  sleep,
  now,
}) {
  let snapshot = directorySnapshot;
  for (let page = 0; page < 4; page += 1) {
    const candidates = findIqiyiLiveCardPoints(snapshot, screen);
    for (const candidate of candidates.slice(0, 4)) {
      await device.tap(candidate);
      await sleep(delays.roomMs);

      let current = await getSnapshot(device);
      if (isIqiyiLiveRoom(current) && !isIqiyiMoreLivePanel(current)) {
        await assertIqiyiForeground(device, app);
        return current;
      }

      if (!isIqiyiLiveDirectory(current)) {
        current = await waitForSnapshot({
          device,
          predicate: (value) =>
            isIqiyiLiveRoom(value) ||
            isIqiyiLiveUnavailable(value) ||
            isIqiyiLiveDirectory(value),
          timeoutMs: 5000,
          pollMs: 600,
          sleep,
          now,
          message: '爱奇艺直播卡片点击后页面状态无法识别',
        }).catch(() => current);
      }

      if (isIqiyiLiveRoom(current) && !isIqiyiMoreLivePanel(current)) {
        await assertIqiyiForeground(device, app);
        return current;
      }

      if (!isIqiyiLiveDirectory(current)) {
        await device.keyevent('KEYCODE_BACK');
        await sleep(delays.recoveryMs);
        snapshot = await waitForSnapshot({
          device,
          predicate: isIqiyiLiveDirectory,
          timeoutMs: 6000,
          pollMs: 600,
          sleep,
          now,
          message: '跳过无效房间后未返回爱奇艺直播频道',
        });
      } else {
        snapshot = current;
      }
    }

    await device.swipe({
      x1: Math.round(screen.width * 0.52),
      y1: Math.round(screen.height * 0.78),
      x2: Math.round(screen.width * 0.52),
      y2: Math.round(screen.height * 0.25),
      durationMs: 420,
    });
    await sleep(delays.listSwipeMs);
    snapshot = await getSnapshot(device);
  }

  throw new Error('连续尝试爱奇艺直播卡片后仍未进入正在直播的房间');
}

async function browseIqiyiLive({
  device,
  app,
  screen,
  initialSnapshot,
  durationMs,
  switchIntervalMs,
  delays,
  sleep,
  now,
  random,
}) {
  const startedAt = now();
  const deadline = startedAt + durationMs;
  let snapshot = initialSnapshot;
  let switchCount = 0;
  let swipeSwitchCount = 0;
  let fallbackSwitchCount = 0;
  const switchMethods = [];
  let nextSwitchAt = startedAt + nextSwitchWaitMs(switchIntervalMs, random);

  while (now() < deadline) {
    const wakeAt = Math.min(deadline, nextSwitchAt);
    const waitMs = Math.max(0, wakeAt - now());
    if (waitMs > 0) await sleep(waitMs);
    if (now() >= deadline) break;

    const remainingMs = deadline - now();
    if (remainingMs < minimumSwitchBudgetMs(delays)) {
      await sleep(remainingMs);
      break;
    }

    await assertIqiyiForeground(device, app);
    const switched = await switchIqiyiLiveRoom({
      device,
      app,
      screen,
      currentSnapshot: snapshot,
      delays,
      sleep,
      now,
    });
    snapshot = switched.snapshot;
    switchMethods.push(switched.method);
    switchCount += 1;
    if (switched.method === 'swipe') swipeSwitchCount += 1;
    else fallbackSwitchCount += 1;
    nextSwitchAt = now() + nextSwitchWaitMs(switchIntervalMs, random);
  }

  await assertIqiyiForeground(device, app);
  const finalSnapshot = await getSnapshot(device).catch(() => snapshot);
  if (!isIqiyiLiveRoom(finalSnapshot) || isIqiyiMoreLivePanel(finalSnapshot)) {
    throw new Error('爱奇艺直播浏览结束时已离开真实直播间');
  }

  return {
    observedMs: Math.max(0, now() - startedAt),
    switchCount,
    swipeSwitchCount,
    fallbackSwitchCount,
    switchMethods,
  };
}

async function switchIqiyiLiveRoom({
  device,
  app,
  screen,
  currentSnapshot,
  delays,
  sleep,
  now,
}) {
  const beforeIdentity = extractIqiyiLiveRoomIdentity(currentSnapshot);

  await device.swipe({
    x1: Math.round(screen.width * 0.45),
    y1: Math.round(screen.height * 0.62),
    x2: Math.round(screen.width * 0.45),
    y2: Math.round(screen.height * 0.18),
    durationMs: 320,
  });
  await sleep(delays.switchSwipeMs);

  let snapshot = await getSnapshot(device);
  const swipedIdentity = extractIqiyiLiveRoomIdentity(snapshot);
  if (
    isIqiyiLiveRoom(snapshot) &&
    !isIqiyiMoreLivePanel(snapshot) &&
    identitiesDiffer(beforeIdentity, swipedIdentity)
  ) {
    await assertIqiyiForeground(device, app);
    return {
      snapshot,
      method: 'swipe',
      fromIdentity: beforeIdentity,
      toIdentity: swipedIdentity,
    };
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!isIqiyiMoreLivePanel(snapshot)) {
      if (!isIqiyiLiveRoom(snapshot)) {
        throw new Error('爱奇艺下滑未切换房间，并且当前直播间状态已丢失');
      }
      const moreLivePoint = findTextTapPoint(snapshot, '更多直播', { screen });
      if (!moreLivePoint) throw new Error('爱奇艺直播间未找到“更多直播”入口');
      await device.tap(moreLivePoint);
      await sleep(delays.moreLiveMs);
      snapshot = await waitForSnapshot({
        device,
        predicate: isIqiyiMoreLivePanel,
        timeoutMs: 6000,
        pollMs: 500,
        sleep,
        now,
        message: '爱奇艺“更多直播”列表未加载',
      });
    }

    const candidates = findIqiyiMoreLiveCardPoints(snapshot, screen).filter(
      (candidate) => !candidate.values.includes(beforeIdentity),
    );
    if (!candidates.length) {
      throw new Error('爱奇艺“更多直播”列表没有可切换的其他房间');
    }

    const candidate = candidates[Math.min(attempt, candidates.length - 1)];
    await device.tap(candidate);
    await sleep(delays.roomMs);
    snapshot = await getSnapshot(device);

    const nextIdentity = extractIqiyiLiveRoomIdentity(snapshot);
    if (
      isIqiyiLiveRoom(snapshot) &&
      !isIqiyiMoreLivePanel(snapshot) &&
      identitiesDiffer(beforeIdentity, nextIdentity)
    ) {
      await assertIqiyiForeground(device, app);
      return {
        snapshot,
        method: 'more_live',
        fromIdentity: beforeIdentity,
        toIdentity: nextIdentity,
      };
    }
  }

  throw new Error('爱奇艺下滑和“更多直播”列表均未切换到其他主播');
}

export function isIqiyiLiveDirectory(snapshot) {
  if (isIqiyiLiveRoom(snapshot)) return false;
  const values = snapshotValues(snapshot);
  const liveCards = findIqiyiLiveCardPoints(snapshot);
  const hasDirectoryTabs =
    values.includes('直播日历') ||
    LIVE_DIRECTORY_TABS.filter((value) => values.includes(value)).length >= 2;
  const hasBottomNavigation = BOTTOM_NAVIGATION.every((value) =>
    values.includes(value),
  );
  return liveCards.length > 0 && (hasDirectoryTabs || hasBottomNavigation);
}

export function isIqiyiLiveRoom(snapshot) {
  if (isIqiyiLiveUnavailable(snapshot)) return false;
  const values = snapshotValues(snapshot);
  const ids = snapshotNodeIds(snapshot);
  const hasRoomText = ROOM_TEXT_EVIDENCE.every((value) => values.includes(value));
  const hasLiveNode = ids.some((id) => /^live_room_/i.test(id));
  const hasHostMessage = values.some((value) => /^主播\s{0,2}/.test(value));
  return hasRoomText && (hasLiveNode || hasHostMessage);
}

export function isIqiyiMoreLivePanel(snapshot) {
  const values = snapshotValues(snapshot);
  return (
    values.some((value) => /ec\.iqiyi\.com\/h5\/live\/square/i.test(value)) &&
    findIqiyiMoreLiveCardPoints(snapshot).length > 0
  );
}

export function isIqiyiLiveUnavailable(snapshot) {
  const values = snapshotValues(snapshot);
  return UNAVAILABLE_EVIDENCE.some((matcher) =>
    values.some((value) => matcher.test(value)),
  );
}

export function findIqiyiLiveCardPoints(snapshot, screen = null) {
  const size = normalizeScreen(screen || inferLayoutScreen(snapshot?.layout));
  return flattenLayout(snapshot?.layout)
    .map((node) => ({
      attributes: node.attributes,
      bounds: parseBounds(node.attributes.bounds),
      values: descendantValues(node.raw),
    }))
    .filter(({ attributes, bounds, values }) => {
      if (!bounds || String(attributes.clickable) !== 'true') return false;
      if (String(attributes.type) !== 'Column') return false;
      const width = bounds.x2 - bounds.x1;
      const height = bounds.y2 - bounds.y1;
      const centerY = (bounds.y1 + bounds.y2) / 2;
      return (
        values.length > 0 &&
        width >= size.width * 0.4 &&
        width <= size.width * 0.55 &&
        height >= size.height * 0.25 &&
        height <= size.height * 0.45 &&
        centerY >= size.height * 0.15 &&
        centerY <= size.height * 0.92
      );
    })
    .map(({ bounds }) => ({
      x: Math.round((bounds.x1 + bounds.x2) / 2),
      y: Math.round(bounds.y1 + (bounds.y2 - bounds.y1) * 0.32),
    }))
    .filter(uniquePoint)
    .sort((left, right) => left.y - right.y || left.x - right.x);
}

export function findIqiyiMoreLiveCardPoints(snapshot, screen = null) {
  const size = normalizeScreen(screen || inferLayoutScreen(snapshot?.layout));
  return flattenLayout(snapshot?.layout)
    .map((node) => ({
      attributes: node.attributes,
      bounds: parseBounds(node.attributes.bounds),
      values: descendantValues(node.raw),
    }))
    .filter(({ attributes, bounds, values }) => {
      if (!bounds || String(attributes.clickable) !== 'true') return false;
      if (String(attributes.type) !== 'genericContainer') return false;
      if (!values.some((value) => /^zhibo_/i.test(value))) return false;
      const width = bounds.x2 - bounds.x1;
      const height = bounds.y2 - bounds.y1;
      return width >= size.width * 0.35 && height >= size.height * 0.16;
    })
    .map(({ bounds, values }) => ({
      x: Math.round((bounds.x1 + bounds.x2) / 2),
      y: Math.round(
        Math.min(
          bounds.y1 + (bounds.y2 - bounds.y1) * 0.3,
          size.height * 0.84,
        ),
      ),
      values,
    }))
    .filter(uniquePoint)
    .sort((left, right) => left.y - right.y || left.x - right.x);
}

export function extractIqiyiLiveRoomIdentity(snapshot) {
  const size = normalizeScreen(inferLayoutScreen(snapshot?.layout));
  for (const node of flattenLayout(snapshot?.layout)) {
    const attributes = node.attributes;
    const bounds = parseBounds(attributes.bounds);
    if (!bounds || String(attributes.type) !== 'Text') continue;
    if (String(attributes.clickable) !== 'true') continue;
    const centerY = (bounds.y1 + bounds.y2) / 2;
    if (centerY > size.height * 0.12) continue;
    const value = firstNodeText(attributes);
    if (!value || value === '关注') continue;
    if (/^\d+(?:\.\d+)?万?人看过$/.test(value)) continue;
    return value;
  }
  return null;
}

async function assertIqiyiForeground(device, app) {
  if (typeof device.getCurrentFocus !== 'function') return;
  const focus = await device.getCurrentFocus();
  const actual = focus?.bundleName || focus?.packageName || '';
  const expected = [app.packageName, app.harmonyBundleName].filter(Boolean);
  if (actual && !expected.includes(actual)) {
    throw new Error(`爱奇艺不在前台，当前前台应用为 ${actual}`);
  }
}

async function assertScreenChanges({
  device,
  intervalMs,
  minimum,
  sleep,
}) {
  if (typeof device.screenshotPng !== 'function') {
    throw new Error('当前设备适配器不支持爱奇艺直播画面验证');
  }
  const first = await device.screenshotPng();
  await sleep(intervalMs);
  const second = await device.screenshotPng();
  const ratio = estimateBufferDifference(first, second);
  if (ratio < minimum) {
    throw new Error(`爱奇艺直播画面变化不足，变化率 ${ratio.toFixed(5)}`);
  }
  return ratio;
}

async function waitForSnapshot({
  device,
  predicate,
  timeoutMs,
  pollMs,
  sleep,
  now,
  message,
}) {
  const deadline = now() + timeoutMs;
  let lastError = null;
  while (now() <= deadline) {
    try {
      const snapshot = await getSnapshot(device);
      if (predicate(snapshot)) return snapshot;
    } catch (error) {
      lastError = error;
    }
    await sleep(pollMs);
  }
  throw new Error(lastError ? `${message}: ${lastError.message}` : message);
}

async function getSnapshot(device) {
  return device.getUiTextSnapshot({
    attempts: 1,
    timeoutMs: 5000,
  });
}

function describeIqiyiLiveRoom(snapshot) {
  const identity = extractIqiyiLiveRoomIdentity(snapshot);
  return identity ? `已进入爱奇艺直播间：${identity}` : '已显示爱奇艺直播互动控件';
}

function findTextTapPoint(snapshot, text, { screen = null, maxYRatio = 1 } = {}) {
  const size = normalizeScreen(screen || inferLayoutScreen(snapshot?.layout));
  let result = null;

  const visit = (raw, clickableAncestors = []) => {
    if (!raw || typeof raw !== 'object' || result) return;
    const attributes = raw.attributes || raw.attrs || raw;
    const bounds = parseBounds(attributes.bounds);
    const currentAncestors =
      bounds && String(attributes.clickable) === 'true'
        ? [bounds, ...clickableAncestors]
        : clickableAncestors;
    const values = [
      attributes.text,
      attributes.originalText,
      attributes.description,
      attributes.hint,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    if (values.includes(text) && bounds) {
      const targetBounds = currentAncestors[0] || bounds;
      const centerY = (targetBounds.y1 + targetBounds.y2) / 2;
      if (centerY <= size.height * maxYRatio) {
        result = {
          x: Math.round((targetBounds.x1 + targetBounds.x2) / 2),
          y: Math.round(centerY),
        };
        return;
      }
    }

    for (const child of Array.isArray(raw.children) ? raw.children : []) {
      visit(child, currentAncestors);
    }
  };

  visit(snapshot?.layout);
  return result;
}

function snapshotValues(snapshot) {
  if (Array.isArray(snapshot?.values) && snapshot.values.length) {
    return snapshot.values.map((value) => String(value || '').trim()).filter(Boolean);
  }
  return flattenLayout(snapshot?.layout)
    .flatMap((node) => [
      node.attributes.text,
      node.attributes.originalText,
      node.attributes.description,
      node.attributes.hint,
    ])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function snapshotNodeIds(snapshot) {
  return flattenLayout(snapshot?.layout)
    .flatMap((node) => [
      node.attributes.id,
      node.attributes.resourceId,
      node.attributes.resourceIdName,
      node.attributes.key,
    ])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function descendantValues(raw) {
  const values = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const attributes = node.attributes || node.attrs || node;
    for (const key of ['text', 'originalText', 'description', 'hint']) {
      const value = String(attributes[key] || '').trim();
      if (value && !values.includes(value)) values.push(value);
    }
    for (const child of Array.isArray(node.children) ? node.children : []) {
      visit(child);
    }
  };
  visit(raw);
  return values;
}

function firstNodeText(attributes) {
  return [
    attributes.text,
    attributes.originalText,
    attributes.description,
    attributes.hint,
  ]
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
}

function flattenLayout(layout) {
  const nodes = [];
  const visit = (raw) => {
    if (!raw || typeof raw !== 'object') return;
    const attributes =
      raw.attributes && typeof raw.attributes === 'object'
        ? raw.attributes
        : raw.attrs && typeof raw.attrs === 'object'
          ? raw.attrs
          : raw;
    nodes.push({ raw, attributes });
    for (const child of Array.isArray(raw.children) ? raw.children : []) visit(child);
  };
  visit(layout);
  return nodes;
}

function parseBounds(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(
    /\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/,
  );
  if (!match) return null;
  return {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4]),
  };
}

function inferLayoutScreen(layout) {
  const bounds = parseBounds(
    layout?.attributes?.bounds ??
      layout?.attrs?.bounds ??
      layout?.bounds,
  );
  if (!bounds) return null;
  return {
    width: bounds.x2 - bounds.x1,
    height: bounds.y2 - bounds.y1,
  };
}

function estimateBufferDifference(first, second) {
  const a = Buffer.from(first || []);
  const b = Buffer.from(second || []);
  const length = Math.min(a.length, b.length);
  if (!length) return 0;

  const sampleCount = Math.min(200000, length);
  const stride = Math.max(1, Math.floor(length / sampleCount));
  let checked = 0;
  let different =
    Math.abs(a.length - b.length) > Math.max(128, length * 0.001) ? 1 : 0;
  for (let index = 0; index < length; index += stride) {
    checked += 1;
    if (a[index] !== b[index]) different += 1;
  }
  return checked > 0 ? different / checked : 0;
}

function identitiesDiffer(before, after) {
  return Boolean(before && after && before !== after);
}

function uniquePoint(pointValue, index, all) {
  return (
    all.findIndex(
      (candidate) =>
        Math.abs(candidate.x - pointValue.x) < 20 &&
        Math.abs(candidate.y - pointValue.y) < 20,
    ) === index
  );
}

function normalizeDurationMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的爱奇艺直播观看时长: ${JSON.stringify(value)}`);
  }
  return Math.min(MAX_DURATION_MS, Math.max(1000, Math.round(parsed)));
}

function normalizeSwitchIntervalMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的爱奇艺直播切换间隔: ${JSON.stringify(value)}`);
  }
  return Math.max(MIN_SWITCH_INTERVAL_MS, Math.round(parsed));
}

function nextSwitchWaitMs(switchIntervalMs, random) {
  if (switchIntervalMs) return switchIntervalMs;
  return randomInt(DEFAULT_SWITCH_MIN_MS, DEFAULT_SWITCH_MAX_MS, random);
}

function minimumSwitchBudgetMs(delays) {
  return Math.max(
    2000,
    Number(delays.switchSwipeMs || 0) +
      Number(delays.moreLiveMs || 0) +
      Number(delays.roomMs || 0) +
      Number(delays.switchBufferMs || 0),
  );
}

function randomInt(min, max, random) {
  return min + Math.floor(random() * (max - min + 1));
}

function normalizeScreen(screen) {
  return {
    width: Number(screen?.width) || DEFAULT_SCREEN.width,
    height: Number(screen?.height) || DEFAULT_SCREEN.height,
  };
}

function point(screen, xRatio, yRatio) {
  return {
    x: Math.round(screen.width * xRatio),
    y: Math.round(screen.height * yRatio),
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
