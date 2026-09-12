import { config } from '../config.js';

export const HUYA_LIVE_WORKFLOW_ID = 'live:huya:live-browse';
export const HUYA_LIVE_VALIDATION_MODE = 'huya_live_browse_v1';

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
  roomMs: 4000,
  recoveryMs: 1500,
  listSwipeMs: 1200,
  motionMs: 1500,
  switchBufferMs: 7000,
});

const HUYA_HOME_EVIDENCE = [
  /搜索主播\/直播\/游戏/,
  /^首页$/,
  /^视频$/,
  /^发现$/,
  /^商城$/,
  /^我的$/,
];
const HUYA_ROOM_TEXT_EVIDENCE = [/^聊天$/, /聊聊天/, /热度值/, /进入直播间/];
const HUYA_ROOM_NODE_IDS = [
  'com.duowan.kiwi:id/back_btn',
  'com.duowan.kiwi:id/live_room_water_mark_room_id',
];
const HUYA_UNAVAILABLE_EVIDENCE = [/未开播/, /已下播/, /直播已结束/, /主播不在家/];

export async function executeHuyaLiveBrowse({
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
  if (!device) throw new Error('虎牙直播缺少设备适配器');
  if (app?.id !== 'huya' || !app.packageName) {
    throw new Error('虎牙直播 skill 只能用于虎牙 App');
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

  await runStage('device_connected', '确认虎牙直播测试设备', async () => {
    const status = await device.getDeviceStatus?.();
    if (status && !status.connected) throw new Error('未检测到已连接设备');
    screen = normalizeScreen(
      status?.screen || (await device.getScreenSize?.().catch(() => null)),
    );
    return status;
  });

  const homeSnapshot = await runStage(
    'app_launched',
    '冷启动虎牙并加载首页直播列表',
    async () => {
      await device.forceStopPackage(app.packageName);
      await device.launchPackage(app.packageName);
      await sleep(delays.startupMs);
      await assertHuyaForeground(device, app);

      let snapshot = await getSnapshot(device);
      if (isHuyaLiveRoom(snapshot)) {
        await device.keyevent('KEYCODE_BACK');
        await sleep(delays.recoveryMs);
        snapshot = await getSnapshot(device);
      }
      if (!isHuyaLiveHome(snapshot)) {
        snapshot = await waitForSnapshot({
          device,
          predicate: isHuyaLiveHome,
          timeoutMs: 9000,
          pollMs: 600,
          sleep,
          now,
          message: '虎牙首页未加载出直播卡片',
        });
      }
      return snapshot;
    },
    (snapshot) => `识别到 ${findHuyaLiveCardPoints(snapshot, screen).length} 张直播卡片`,
  );

  const roomSnapshot = await runStage(
    'live_room_opened',
    '打开虎牙首页第一个直播间',
    () =>
      openHuyaLiveRoom({
        device,
        app,
        screen,
        homeSnapshot,
        delays,
        sleep,
        now,
      }),
    describeHuyaLiveRoom,
  );

  await runStage(
    'live_room_verified',
    '确认虎牙真实直播间控件',
    async () => {
      if (!isHuyaLiveRoom(roomSnapshot)) {
        throw new Error('虎牙直播间缺少房间号或聊天控件');
      }
      await assertHuyaForeground(device, app);
      return roomSnapshot;
    },
    describeHuyaLiveRoom,
  );

  await runStage(
    'live_motion_verified',
    '确认虎牙直播画面持续变化',
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
      '开始采集虎牙直播内容',
      () => startCapture(),
      '真实直播间验证通过后启动采集',
    );
  }

  const browseResult = await runStage(
    'duration_observed',
    '按设置时长浏览虎牙直播',
    () =>
      browseHuyaLive({
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
    validationMode: HUYA_LIVE_VALIDATION_MODE,
    validationChecks,
    effectiveDurationMs,
    effectiveSwitchIntervalMs,
    replayStepIndex,
    replaySource: HUYA_LIVE_VALIDATION_MODE,
    switchCount: browseResult.switchCount,
    browseResult,
  };
}

async function browseHuyaLive({
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

    await assertHuyaForeground(device, app);
    snapshot = await switchHuyaLiveRoom({
      device,
      app,
      screen,
      delays,
      sleep,
      now,
    });
    switchCount += 1;
    nextSwitchAt = now() + nextSwitchWaitMs(switchIntervalMs, random);
  }

  await assertHuyaForeground(device, app);
  const finalSnapshot = await getSnapshot(device).catch(() => snapshot);
  if (!isHuyaLiveRoom(finalSnapshot)) {
    throw new Error('虎牙直播浏览结束时已离开真实直播间');
  }

  return {
    observedMs: Math.max(0, now() - startedAt),
    switchCount,
  };
}

async function switchHuyaLiveRoom({
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

  let homeSnapshot = await waitForSnapshot({
    device,
    predicate: isHuyaLiveHome,
    timeoutMs: 7000,
    pollMs: 600,
    sleep,
    now,
    message: '从虎牙直播间返回后未回到首页列表',
  });
  await device.swipe({
    x1: Math.round(screen.width * 0.52),
    y1: Math.round(screen.height * 0.78),
    x2: Math.round(screen.width * 0.52),
    y2: Math.round(screen.height * 0.25),
    durationMs: 420,
  });
  await sleep(delays.listSwipeMs);
  homeSnapshot = await getSnapshot(device);

  const roomSnapshot = await openHuyaLiveRoom({
    device,
    app,
    screen,
    homeSnapshot,
    delays,
    sleep,
    now,
  });
  const after = await device.screenshotPng?.().catch(() => null);
  if (before && after) {
    const ratio = estimateBufferDifference(before, after);
    if (ratio < 0.0005) {
      throw new Error(`虎牙直播切换后画面变化不足，变化率 ${ratio.toFixed(5)}`);
    }
  }
  return roomSnapshot;
}

async function openHuyaLiveRoom({
  device,
  app,
  screen,
  homeSnapshot,
  delays,
  sleep,
  now,
}) {
  let snapshot = homeSnapshot;
  for (let page = 0; page < 3; page += 1) {
    const candidates = findHuyaLiveCardPoints(snapshot, screen);
    for (const candidate of candidates.slice(0, 4)) {
      await device.tap(candidate);
      await sleep(delays.roomMs);

      let current = await getSnapshot(device);
      if (isHuyaLiveRoom(current)) {
        await assertHuyaForeground(device, app);
        return current;
      }

      if (!isHuyaLiveHome(current)) {
        current = await waitForSnapshot({
          device,
          predicate: (value) =>
            isHuyaLiveRoom(value) ||
            isHuyaLiveUnavailable(value) ||
            isHuyaLiveHome(value),
          timeoutMs: 5000,
          pollMs: 600,
          sleep,
          now,
          message: '虎牙直播卡片点击后页面状态无法识别',
        }).catch(() => current);
      }

      if (isHuyaLiveRoom(current)) {
        await assertHuyaForeground(device, app);
        return current;
      }

      if (!isHuyaLiveHome(current)) {
        await device.keyevent('KEYCODE_BACK');
        await sleep(delays.recoveryMs);
        snapshot = await waitForSnapshot({
          device,
          predicate: isHuyaLiveHome,
          timeoutMs: 6000,
          pollMs: 600,
          sleep,
          now,
          message: '跳过无效房间后未返回虎牙首页',
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

  throw new Error('连续尝试虎牙直播卡片后仍未进入正在直播的房间');
}

export function isHuyaLiveHome(snapshot) {
  const values = snapshotValues(snapshot);
  return (
    HUYA_HOME_EVIDENCE.every((matcher) =>
      values.some((value) => matcher.test(value)),
    ) &&
    findHuyaLiveCardPoints(snapshot).length > 0
  );
}

export function isHuyaLiveRoom(snapshot) {
  if (isHuyaLiveUnavailable(snapshot)) return false;
  const values = snapshotValues(snapshot);
  const ids = snapshotNodeIds(snapshot);
  return (
    HUYA_ROOM_NODE_IDS.every((resourceId) => ids.includes(resourceId)) &&
    HUYA_ROOM_TEXT_EVIDENCE.some((matcher) =>
      values.some((value) => matcher.test(value)),
    )
  );
}

export function isHuyaLiveUnavailable(snapshot) {
  const values = snapshotValues(snapshot);
  return HUYA_UNAVAILABLE_EVIDENCE.some((matcher) =>
    values.some((value) => matcher.test(value)),
  );
}

export function findHuyaLiveCardPoints(snapshot, screen = null) {
  const size = normalizeScreen(screen || inferLayoutScreen(snapshot?.layout));
  return flattenLayout(snapshot?.layout)
    .map((node) => ({
      attributes: node.attributes,
      bounds: parseBounds(node.attributes.bounds),
    }))
    .filter(({ attributes, bounds }) => {
      if (!bounds || String(attributes.clickable) !== 'true') return false;
      if (String(attributes.type) !== 'Column') return false;
      const width = bounds.x2 - bounds.x1;
      const height = bounds.y2 - bounds.y1;
      const centerY = (bounds.y1 + bounds.y2) / 2;
      return (
        width >= size.width * 0.4 &&
        width <= size.width * 0.55 &&
        height >= size.height * 0.15 &&
        height <= size.height * 0.24 &&
        centerY >= size.height * 0.15 &&
        centerY <= size.height * 0.9
      );
    })
    .map(({ bounds }) => {
      const height = bounds.y2 - bounds.y1;
      return {
        x: Math.round((bounds.x1 + bounds.x2) / 2),
        y: Math.round(bounds.y1 + height * 0.3),
      };
    })
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

async function assertHuyaForeground(device, app) {
  if (typeof device.getCurrentFocus !== 'function') return;
  const focus = await device.getCurrentFocus();
  const actual = focus?.bundleName || focus?.packageName || '';
  const expected = [app.packageName, app.harmonyBundleName].filter(Boolean);
  if (actual && !expected.includes(actual)) {
    throw new Error(`虎牙不在前台，当前前台应用为 ${actual}`);
  }
}

async function assertScreenChanges({
  device,
  intervalMs,
  minimum,
  sleep,
}) {
  if (typeof device.screenshotPng !== 'function') {
    throw new Error('当前设备适配器不支持虎牙直播画面验证');
  }
  const first = await device.screenshotPng();
  await sleep(intervalMs);
  const second = await device.screenshotPng();
  const ratio = estimateBufferDifference(first, second);
  if (ratio < minimum) {
    throw new Error(`虎牙直播画面变化不足，变化率 ${ratio.toFixed(5)}`);
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

function describeHuyaLiveRoom(snapshot) {
  const values = snapshotValues(snapshot);
  const roomId = values.find((value) => /^\d{4,}$/.test(value));
  return roomId ? `已进入虎牙直播间，房间号 ${roomId}` : '已显示虎牙直播聊天控件';
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

function normalizeDurationMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的虎牙直播观看时长: ${JSON.stringify(value)}`);
  }
  return Math.min(MAX_DURATION_MS, Math.max(1000, Math.round(parsed)));
}

function normalizeSwitchIntervalMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的虎牙直播切换间隔: ${JSON.stringify(value)}`);
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
