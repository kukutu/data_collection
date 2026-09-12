import { config } from '../config.js';

export const DOUYU_LIVE_WORKFLOW_ID = 'live:douyu:live-browse';
export const DOUYU_LIVE_VALIDATION_MODE = 'douyu_live_browse_v1';

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

const DOUYU_HOME_EVIDENCE = [
  /搜索主播和游戏/,
  /^热门$/,
  /^首页$/,
  /^赛事$/,
  /^动态$/,
  /^关注$/,
  /^我的$/,
];
const DOUYU_ROOM_INTERACTION_EVIDENCE = [/来撩主播吧/, /更多\s*直播/];
const DOUYU_UNAVAILABLE_EVIDENCE = [
  /未开播/,
  /已下播/,
  /直播已结束/,
  /主播不在家/,
];

export async function executeDouyuLiveBrowse({
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
  if (!device) throw new Error('斗鱼直播缺少设备适配器');
  if (app?.id !== 'douyu' || !app.packageName) {
    throw new Error('斗鱼直播 skill 只能用于斗鱼 App');
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

  await runStage('device_connected', '确认斗鱼直播测试设备', async () => {
    const status = await device.getDeviceStatus?.();
    if (status && !status.connected) throw new Error('未检测到已连接设备');
    screen = normalizeScreen(
      status?.screen || (await device.getScreenSize?.().catch(() => null)),
    );
    return status;
  });

  const homeSnapshot = await runStage(
    'app_launched',
    '冷启动斗鱼并加载首页直播列表',
    async () => {
      await device.forceStopPackage(app.packageName);
      await device.launchPackage(app.packageName);
      await sleep(delays.startupMs);
      await assertDouyuForeground(device, app);

      let snapshot = await getSnapshot(device);
      if (isDouyuLiveRoom(snapshot)) {
        await device.keyevent('KEYCODE_BACK');
        await sleep(delays.recoveryMs);
        snapshot = await getSnapshot(device);
      }
      if (!isDouyuLiveHome(snapshot)) {
        snapshot = await waitForSnapshot({
          device,
          predicate: isDouyuLiveHome,
          timeoutMs: 9000,
          pollMs: 600,
          sleep,
          now,
          message: '斗鱼首页未加载出标准直播卡片',
        });
      }
      return snapshot;
    },
    (snapshot) => `识别到 ${findDouyuLiveCardPoints(snapshot, screen).length} 张直播卡片`,
  );

  const roomSnapshot = await runStage(
    'live_room_opened',
    '打开斗鱼首页第一张标准直播卡片',
    () =>
      openDouyuLiveRoom({
        device,
        app,
        screen,
        homeSnapshot,
        delays,
        sleep,
        now,
      }),
    describeDouyuLiveRoom,
  );

  await runStage(
    'live_room_verified',
    '确认斗鱼真实直播间控件',
    async () => {
      if (!isDouyuLiveRoom(roomSnapshot)) {
        throw new Error('斗鱼直播间缺少播放器、聊天标签或互动控件');
      }
      await assertDouyuForeground(device, app);
      return roomSnapshot;
    },
    describeDouyuLiveRoom,
  );

  await runStage(
    'live_motion_verified',
    '确认斗鱼直播画面持续变化',
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
      '开始采集斗鱼直播内容',
      () => startCapture(),
      '真实直播间和动态画面验证通过后启动采集',
    );
  }

  const browseResult = await runStage(
    'duration_observed',
    '按设置时长浏览斗鱼直播',
    () =>
      browseDouyuLive({
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
    validationMode: DOUYU_LIVE_VALIDATION_MODE,
    validationChecks,
    effectiveDurationMs,
    effectiveSwitchIntervalMs,
    replayStepIndex,
    replaySource: DOUYU_LIVE_VALIDATION_MODE,
    switchCount: browseResult.switchCount,
    browseResult,
  };
}

async function browseDouyuLive({
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

    await assertDouyuForeground(device, app);
    snapshot = await switchDouyuLiveRoom({
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

  await assertDouyuForeground(device, app);
  const finalSnapshot = await getSnapshot(device).catch(() => snapshot);
  if (!isDouyuLiveRoom(finalSnapshot)) {
    throw new Error('斗鱼直播浏览结束时已离开真实直播间');
  }

  return {
    observedMs: Math.max(0, now() - startedAt),
    switchCount,
  };
}

async function switchDouyuLiveRoom({
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
    predicate: isDouyuLiveHome,
    timeoutMs: 7000,
    pollMs: 600,
    sleep,
    now,
    message: '从斗鱼直播间返回后未回到首页直播列表',
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

  const roomSnapshot = await openDouyuLiveRoom({
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
      throw new Error(
        `斗鱼直播切换后画面变化不足，变化率 ${ratio.toFixed(5)}`,
      );
    }
  }
  return roomSnapshot;
}

async function openDouyuLiveRoom({
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
    const candidates = findDouyuLiveCardPoints(snapshot, screen);
    for (const candidate of candidates.slice(0, 4)) {
      await device.tap(candidate);
      await sleep(delays.roomMs);

      let current = await getSnapshot(device);
      if (isDouyuLiveRoom(current)) {
        await assertDouyuForeground(device, app);
        return current;
      }

      if (!isDouyuLiveHome(current)) {
        current = await waitForSnapshot({
          device,
          predicate: (value) =>
            isDouyuLiveRoom(value) ||
            isDouyuLiveUnavailable(value) ||
            isDouyuLiveHome(value),
          timeoutMs: 5000,
          pollMs: 600,
          sleep,
          now,
          message: '斗鱼直播卡片点击后页面状态无法识别',
        }).catch(() => current);
      }

      if (isDouyuLiveRoom(current)) {
        await assertDouyuForeground(device, app);
        return current;
      }

      if (!isDouyuLiveHome(current)) {
        await device.keyevent('KEYCODE_BACK');
        await sleep(delays.recoveryMs);
        snapshot = await waitForSnapshot({
          device,
          predicate: isDouyuLiveHome,
          timeoutMs: 6000,
          pollMs: 600,
          sleep,
          now,
          message: '跳过无效房间后未返回斗鱼首页',
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

  throw new Error('连续尝试斗鱼标准直播卡片后仍未进入正在直播的房间');
}

export function isDouyuLiveHome(snapshot) {
  const values = snapshotValues(snapshot);
  return (
    DOUYU_HOME_EVIDENCE.every((matcher) =>
      values.some((value) => matcher.test(value)),
    ) &&
    findDouyuLiveCardPoints(snapshot).length > 0
  );
}

export function isDouyuLiveRoom(snapshot) {
  if (isDouyuLiveUnavailable(snapshot)) return false;
  const values = snapshotValues(snapshot);
  const nodes = flattenLayout(snapshot?.layout);
  const hasPlayer = nodes.some((node) => nodeId(node.attributes) === 'gesture_play');
  const hasChatTab = nodes.some(
    (node) =>
      nodeId(node.attributes) === 'tabBarName' &&
      String(node.attributes.text || node.attributes.originalText || '').trim() ===
        '聊天',
  );
  const hasInteraction = DOUYU_ROOM_INTERACTION_EVIDENCE.some((matcher) =>
    values.some((value) => matcher.test(value)),
  );
  return hasPlayer && hasChatTab && hasInteraction;
}

export function isDouyuLiveUnavailable(snapshot) {
  const values = snapshotValues(snapshot);
  return DOUYU_UNAVAILABLE_EVIDENCE.some((matcher) =>
    values.some((value) => matcher.test(value)),
  );
}

export function findDouyuLiveCardPoints(snapshot, screen = null) {
  const size = normalizeScreen(screen || inferLayoutScreen(snapshot?.layout));
  return flattenLayout(snapshot?.layout)
    .map((node) => ({
      attributes: node.attributes,
      bounds: parseBounds(node.attributes.bounds),
    }))
    .filter(({ attributes, bounds }) => {
      if (!bounds || String(attributes.clickable) !== 'true') return false;
      if (String(attributes.type) !== '__Common__') return false;
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

async function assertDouyuForeground(device, app) {
  if (typeof device.getCurrentFocus !== 'function') return;
  const focus = await device.getCurrentFocus();
  const actual = focus?.bundleName || focus?.packageName || '';
  const expected = [app.packageName, app.harmonyBundleName].filter(Boolean);
  if (actual && !expected.includes(actual)) {
    throw new Error(`斗鱼不在前台，当前前台应用为 ${actual}`);
  }
}

async function assertScreenChanges({
  device,
  intervalMs,
  minimum,
  sleep,
}) {
  if (typeof device.screenshotPng !== 'function') {
    throw new Error('当前设备适配器不支持斗鱼直播画面验证');
  }
  const first = await device.screenshotPng();
  await sleep(intervalMs);
  const second = await device.screenshotPng();
  const ratio = estimateBufferDifference(first, second);
  if (ratio < minimum) {
    throw new Error(`斗鱼直播画面变化不足，变化率 ${ratio.toFixed(5)}`);
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

function describeDouyuLiveRoom(snapshot) {
  const values = snapshotValues(snapshot);
  const streamer = values.find(
    (value) =>
      value !== '聊天' &&
      value !== '视频' &&
      value !== '关注' &&
      value.length >= 2 &&
      value.length <= 24,
  );
  return streamer ? `已进入斗鱼直播间：${streamer}` : '已显示斗鱼直播互动控件';
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

function nodeId(attributes) {
  return String(
    attributes.id ||
      attributes.resourceId ||
      attributes.resourceIdName ||
      attributes.key ||
      '',
  ).trim();
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
    layout?.attributes?.bounds ?? layout?.attrs?.bounds ?? layout?.bounds,
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
    throw new Error(`无效的斗鱼直播观看时长: ${JSON.stringify(value)}`);
  }
  return Math.min(MAX_DURATION_MS, Math.max(1000, Math.round(parsed)));
}

function normalizeSwitchIntervalMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的斗鱼直播切换间隔: ${JSON.stringify(value)}`);
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
