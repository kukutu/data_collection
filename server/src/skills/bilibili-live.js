import { config } from '../config.js';

export const BILIBILI_LIVE_WORKFLOW_ID = 'live:bilibili:live-browse';
export const BILIBILI_LIVE_VALIDATION_MODE = 'bilibili_live_browse_v1';

const DEFAULT_SCREEN = {
  width: config.screen.defaultWidth,
  height: config.screen.defaultHeight,
};
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MIN_SWITCH_INTERVAL_MS = 1000;
const DEFAULT_SWITCH_MIN_MS = 2 * 60 * 1000;
const DEFAULT_SWITCH_MAX_MS = 5 * 60 * 1000;
const DEFAULT_TIMINGS = Object.freeze({
  startupMs: 5000,
  channelMs: 3000,
  roomMs: 3000,
  recoveryMs: 1200,
  listSwipeMs: 1200,
  motionMs: 1500,
  switchBufferMs: 8000,
});

const BILIBILI_HOME_EVIDENCE = [/^首页$/, /^动态$/, /^会员购$/, /^我的$/];
const BILIBILI_ROOM_PRIMARY_EVIDENCE = [/发个弹幕呗/];
const BILIBILI_ROOM_SECONDARY_EVIDENCE = [
  /^关注$/,
  /点赞$/,
  /热门榜/,
  /人气榜/,
  /系统提示.*直播/,
];
const BILIBILI_UNAVAILABLE_EVIDENCE = [/未开播/, /直播已结束/, /主播暂时离开/];

export async function executeBilibiliLiveBrowse({
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
  if (!device) throw new Error('B站直播缺少设备适配器');
  if (app?.id !== 'bilibili' || !app.packageName) {
    throw new Error('B站直播 skill 只能用于 B站 App');
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

  await runStage('device_connected', '确认 B站直播测试设备', async () => {
    const status = await device.getDeviceStatus?.();
    if (status && !status.connected) throw new Error('未检测到已连接设备');
    screen = normalizeScreen(
      status?.screen || (await device.getScreenSize?.().catch(() => null)),
    );
    return status;
  });

  await runStage('app_launched', '冷启动 B站并回到首页', async () => {
    await device.forceStopPackage(app.packageName);
    await device.launchPackage(app.packageName);
    await sleep(delays.startupMs);
    await assertBilibiliForeground(device, app);

    const snapshot = await getSnapshot(device);
    if (isBilibiliLiveRoom(snapshot)) {
      await device.keyevent('KEYCODE_BACK');
      await sleep(delays.recoveryMs);
    }
  });

  const directorySnapshot = await runStage(
    'live_directory_opened',
    '进入 B站顶部直播频道',
    async () => {
      let snapshot = await getSnapshot(device);
      if (!isBilibiliLiveDirectory(snapshot)) {
        await device.tap(point(screen, 0.075, 0.117));
        await sleep(delays.channelMs);
        snapshot = await waitForSnapshot({
          device,
          predicate: isBilibiliLiveDirectory,
          timeoutMs: 8000,
          pollMs: 600,
          sleep,
          now,
          message: 'B站顶部直播频道未加载出直播卡片',
        });
      }
      return snapshot;
    },
    (snapshot) => `识别到 ${findBilibiliLiveCardPoints(snapshot, screen).length} 张直播卡片`,
  );

  const roomSnapshot = await runStage(
    'live_room_opened',
    '进入 B站真实直播间',
    () =>
      openBilibiliLiveRoom({
        device,
        app,
        screen,
        directorySnapshot,
        delays,
        sleep,
        now,
      }),
    describeBilibiliLiveRoom,
  );

  await runStage(
    'live_motion_verified',
    '确认 B站直播画面持续变化',
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
      '开始采集 B站直播内容',
      () => startCapture(),
      '真实直播间验证通过后启动采集',
    );
  }

  const browseResult = await runStage(
    'duration_observed',
    '按设置时长浏览并切换 B站直播',
    () =>
      browseBilibiliLive({
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
    (result) => `浏览 ${result.observedMs}ms，切换 ${result.switchCount} 次`,
  );

  return {
    validationMode: BILIBILI_LIVE_VALIDATION_MODE,
    validationChecks,
    effectiveDurationMs,
    effectiveSwitchIntervalMs,
    replayStepIndex,
    replaySource: BILIBILI_LIVE_VALIDATION_MODE,
    switchCount: browseResult.switchCount,
    browseResult,
  };
}

async function browseBilibiliLive({
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

    await assertBilibiliForeground(device, app);
    snapshot = await switchBilibiliLiveRoom({
      device,
      app,
      screen,
      currentSnapshot: snapshot,
      delays,
      sleep,
      now,
    });
    switchCount += 1;
    nextSwitchAt = now() + nextSwitchWaitMs(switchIntervalMs, random);
  }

  await assertBilibiliForeground(device, app);
  if (!isBilibiliLiveRoom(snapshot)) {
    throw new Error('B站直播浏览结束时已离开真实直播间');
  }

  return {
    observedMs: Math.max(0, now() - startedAt),
    switchCount,
  };
}

async function switchBilibiliLiveRoom({
  device,
  app,
  screen,
  delays,
  sleep,
  now,
}) {
  const before = await device.screenshotPng?.().catch(() => null);
  await device.keyevent('KEYCODE_BACK');
  await sleep(delays.recoveryMs);

  let directorySnapshot = await waitForSnapshot({
    device,
    predicate: isBilibiliLiveDirectory,
    timeoutMs: 7000,
    pollMs: 600,
    sleep,
    now,
    message: '从 B站直播间返回后未回到直播列表',
  });

  await device.swipe({
    x1: Math.round(screen.width * 0.52),
    y1: Math.round(screen.height * 0.78),
    x2: Math.round(screen.width * 0.52),
    y2: Math.round(screen.height * 0.25),
    durationMs: 420,
  });
  await sleep(delays.listSwipeMs);
  directorySnapshot = await getSnapshot(device);

  const roomSnapshot = await openBilibiliLiveRoom({
    device,
    app,
    screen,
    directorySnapshot,
    delays,
    sleep,
    now,
  });
  const after = await device.screenshotPng?.().catch(() => null);
  if (before && after) {
    const ratio = estimateBufferDifference(before, after);
    if (ratio < 0.0005) {
      throw new Error(`B站直播切换后画面变化不足，变化率 ${ratio.toFixed(5)}`);
    }
  }
  return roomSnapshot;
}

async function openBilibiliLiveRoom({
  device,
  app,
  screen,
  directorySnapshot,
  delays,
  sleep,
  now,
}) {
  let snapshot = directorySnapshot;
  for (let page = 0; page < 3; page += 1) {
    const candidates = findBilibiliLiveCardPoints(snapshot, screen);
    for (const candidate of candidates.slice(0, 4)) {
      await device.tap(candidate);
      await sleep(delays.roomMs);

      let current = await getSnapshot(device);
      if (isBilibiliLiveRoom(current)) {
        await assertBilibiliForeground(device, app);
        return current;
      }

      if (!isBilibiliLiveDirectory(current)) {
        current = await waitForSnapshot({
          device,
          predicate: (value) =>
            isBilibiliLiveRoom(value) ||
            isBilibiliLiveUnavailable(value) ||
            isBilibiliLiveDirectory(value),
          timeoutMs: 5000,
          pollMs: 600,
          sleep,
          now,
          message: 'B站直播卡片点击后页面状态无法识别',
        }).catch(() => current);
      }

      if (isBilibiliLiveRoom(current)) {
        await assertBilibiliForeground(device, app);
        return current;
      }

      if (!isBilibiliLiveDirectory(current)) {
        await device.keyevent('KEYCODE_BACK');
        await sleep(delays.recoveryMs);
        snapshot = await waitForSnapshot({
          device,
          predicate: isBilibiliLiveDirectory,
          timeoutMs: 6000,
          pollMs: 600,
          sleep,
          now,
          message: '跳过未开播房间后未返回 B站直播列表',
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

  throw new Error('连续尝试 B站直播卡片后仍未进入正在直播的房间');
}

export function isBilibiliLiveDirectory(snapshot) {
  const values = snapshotValues(snapshot);
  const hasHomeNavigation = BILIBILI_HOME_EVIDENCE.every((matcher) =>
    values.some((value) => matcher.test(value)),
  );
  const hasLiveTab = values.some((value) => /^直播$/.test(value));
  const hasRecordedVideoDuration = values.some((value) => /^\d{1,2}:\d{2}$/.test(value));
  return hasHomeNavigation && hasLiveTab && !hasRecordedVideoDuration;
}

export function isBilibiliLiveRoom(snapshot) {
  if (isBilibiliLiveUnavailable(snapshot)) return false;
  const values = snapshotValues(snapshot);
  return (
    BILIBILI_ROOM_PRIMARY_EVIDENCE.some((matcher) =>
      values.some((value) => matcher.test(value)),
    ) &&
    BILIBILI_ROOM_SECONDARY_EVIDENCE.some((matcher) =>
      values.some((value) => matcher.test(value)),
    )
  );
}

export function isBilibiliLiveUnavailable(snapshot) {
  const values = snapshotValues(snapshot);
  return BILIBILI_UNAVAILABLE_EVIDENCE.some((matcher) =>
    values.some((value) => matcher.test(value)),
  );
}

export function findBilibiliLiveCardPoints(snapshot, screen = DEFAULT_SCREEN) {
  const size = normalizeScreen(screen);
  const points = [];
  for (const node of flattenLayout(snapshot?.layout)) {
    const attributes = node.attributes;
    const bounds = parseBounds(attributes.bounds);
    if (!bounds || String(attributes.clickable) !== 'true') continue;
    if (String(attributes.type) !== 'Column') continue;

    const width = bounds.x2 - bounds.x1;
    const height = bounds.y2 - bounds.y1;
    const centerX = Math.round((bounds.x1 + bounds.x2) / 2);
    const centerY = Math.round((bounds.y1 + bounds.y2) / 2);
    if (width < size.width * 0.35 || width > size.width * 0.6) continue;
    if (height < size.height * 0.12 || height > size.height * 0.26) continue;
    if (centerY < size.height * 0.15 || centerY > size.height * 0.88) continue;
    points.push({ x: centerX, y: Math.round(bounds.y1 + height * 0.32) });
  }

  return points
    .filter(
      (pointValue, index, all) =>
        all.findIndex(
          (candidate) =>
            Math.abs(candidate.x - pointValue.x) < 20 &&
            Math.abs(candidate.y - pointValue.y) < 20,
        ) === index,
    )
    .sort((left, right) => left.y - right.y || left.x - right.x);
}

async function assertBilibiliForeground(device, app) {
  if (typeof device.getCurrentFocus !== 'function') return;
  const focus = await device.getCurrentFocus();
  const actual = focus?.bundleName || focus?.packageName || '';
  const expected = [app.packageName, app.harmonyBundleName].filter(Boolean);
  if (actual && !expected.includes(actual)) {
    throw new Error(`B站不在前台，当前前台应用为 ${actual}`);
  }
}

async function assertScreenChanges({
  device,
  intervalMs,
  minimum,
  sleep,
}) {
  if (typeof device.screenshotPng !== 'function') {
    throw new Error('当前设备适配器不支持 B站直播画面验证');
  }
  const first = await device.screenshotPng();
  await sleep(intervalMs);
  const second = await device.screenshotPng();
  const ratio = estimateBufferDifference(first, second);
  if (ratio < minimum) {
    throw new Error(`B站直播画面变化不足，变化率 ${ratio.toFixed(5)}`);
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

function describeBilibiliLiveRoom(snapshot) {
  const values = snapshotValues(snapshot);
  if (values.some((value) => /热门榜/.test(value))) return '已进入含热门榜的 B站直播间';
  if (values.some((value) => /人气榜/.test(value))) return '已进入含人气榜的 B站直播间';
  return '已显示 B站直播互动控件';
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

function normalizeDurationMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的 B站直播观看时长: ${JSON.stringify(value)}`);
  }
  return Math.min(MAX_DURATION_MS, Math.max(1000, Math.round(parsed)));
}

function normalizeSwitchIntervalMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的 B站直播切换间隔: ${JSON.stringify(value)}`);
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
    Number(delays.recoveryMs || 0) +
      Number(delays.listSwipeMs || 0) +
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
