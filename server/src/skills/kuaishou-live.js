import { config } from '../config.js';

export const KUAISHOU_LIVE_WORKFLOW_ID = 'live:kuaishou:live-browse';
export const KUAISHOU_LIVE_VALIDATION_MODE = 'kuaishou_live_browse_v1';

const DEFAULT_SCREEN = {
  width: config.screen.defaultWidth,
  height: config.screen.defaultHeight,
};
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SWITCH_MIN_MS = 2 * 60 * 1000;
const DEFAULT_SWITCH_MAX_MS = 5 * 60 * 1000;
const MIN_SWITCH_INTERVAL_MS = 1000;
const STATUS_CHECK_INTERVAL_MS = 30 * 1000;
const QUICK_LAYOUT_OPTIONS = Object.freeze({
  attempts: 1,
  timeoutMs: 5000,
});

const DEFAULT_TIMINGS = Object.freeze({
  startupTimeoutMs: 16_000,
  homeTimeoutMs: 10_000,
  directoryTimeoutMs: 12_000,
  roomTimeoutMs: 16_000,
  pollIntervalMs: 500,
  afterAdSkipMs: 800,
  afterPromptDismissMs: 500,
  afterHomeTapMs: 1200,
  afterLiveTabTapMs: 1800,
  afterRoomTapMs: 2500,
  afterRoomRevealMs: 600,
  motionIntervalMs: 1500,
  afterSwitchMs: 3000,
});

const LIVE_DIRECTORY_EVIDENCE = [
  /^直播中$/,
  /超粉千人团/,
  /直播招人/,
];
const LIVE_ROOM_EVIDENCE = [
  /欢迎来到直播间/,
  /更多直播/,
  /游戏频道/,
  /频道$/,
  /第\d+名$/,
  /点歌/,
  /送人气票/,
  /送出/,
  /小时榜/,
  /粉丝团/,
  /直播间/,
];

export function kuaishouLiveDurationToMs(
  value,
  { defaultMs = 30 * 1000, maxMs = MAX_DURATION_MS } = {},
) {
  if (value === undefined || value === null || value === '') return defaultMs;

  const amount = Number(
    value && typeof value === 'object' && 'amount' in value ? value.amount : value,
  );
  const unit =
    value && typeof value === 'object' && value.unit ? String(value.unit) : '秒';
  const factors = {
    毫秒: 1,
    秒: 1000,
    分钟: 60 * 1000,
    小时: 60 * 60 * 1000,
    ms: 1,
    s: 1000,
    min: 60 * 1000,
    h: 60 * 60 * 1000,
  };
  const factor = factors[unit];

  if (!Number.isFinite(amount) || amount <= 0 || !factor) {
    throw new Error(`无效的快手直播观看时长: ${JSON.stringify(value)}`);
  }
  return Math.min(maxMs, Math.max(1000, Math.round(amount * factor)));
}

export function buildKuaishouLiveCorrectedSteps(screen = DEFAULT_SCREEN) {
  const size = normalizeScreen(screen);
  const packages = ['com.kuaishou.hmapp', 'com.smile.gifmaker'];
  const state = (textAny, extra = {}) => ({
    packages,
    activities: ['EntryAbility'],
    textAny,
    nodeIds: [],
    strength: 2,
    ...extra,
  });

  return [
    pointStep(size, 0.1047, 0.9431, DEFAULT_TIMINGS.afterHomeTapMs),
    assertState(state(['直播', '发现', '同城', '探索'])),
    pointStep(size, 0.6234, 0.0802, DEFAULT_TIMINGS.afterLiveTabTapMs, {
      texts: ['直播'],
      required: false,
    }),
    assertState(state(['直播中', '超粉千人团', '直播招人'])),
    pointStep(size, 0.2961, 0.3259, DEFAULT_TIMINGS.afterRoomTapMs),
    assertState(
      state([
        '说点什么',
        '更多直播',
        '游戏频道',
        '精选频道',
        '点歌',
        '欢迎来到直播间',
      ]),
    ),
    {
      type: 'hold_state',
      durationParameter: 'duration',
      durationMs: 5000,
      pollMs: STATUS_CHECK_INTERVAL_MS,
      state: state([
        '说点什么',
        '更多直播',
        '游戏频道',
        '精选频道',
        '点歌',
        '欢迎来到直播间',
      ]),
      optional: false,
      delayMs: 0,
    },
    {
      type: 'swipe',
      ...swipe(size),
      referenceScreen: size,
      coordinateSpace: 'safe_area',
      delayMs: 0,
    },
    assertState(
      state([
        '说点什么',
        '更多直播',
        '游戏频道',
        '精选频道',
        '点歌',
        '欢迎来到直播间',
      ]),
    ),
  ];
}

export async function executeKuaishouLiveBrowse({
  device,
  app,
  parameters = {},
  durationMs = null,
  switchIntervalMs = null,
  validationDurationMs = null,
  startCapture = null,
  onStep = () => {},
  sleep = wait,
  now = () => Date.now(),
  random = Math.random,
  timings = {},
} = {}) {
  if (!device) throw new Error('快手直播缺少设备适配器');
  if (app?.id !== 'kuaishou' || !app.packageName) {
    throw new Error('快手直播 skill 只能用于快手 App');
  }

  const delays = { ...DEFAULT_TIMINGS, ...timings };
  const effectiveDurationMs =
    durationMs === null || durationMs === undefined
      ? kuaishouLiveDurationToMs(parameters.duration)
      : normalizeKuaishouLiveDurationMs(durationMs);
  const effectiveSwitchIntervalMs =
    switchIntervalMs === null || switchIntervalMs === undefined
      ? kuaishouLiveDurationToMs(parameters.switchInterval, {
          defaultMs: null,
        })
      : normalizeKuaishouLiveDurationMs(switchIntervalMs);
  const validationRun =
    Number.isFinite(Number(validationDurationMs)) &&
    Number(validationDurationMs) > 0;
  const checks = [];
  const totalSteps = 8 + (startCapture ? 1 : 0);
  let replayStepIndex = 0;
  let screen = DEFAULT_SCREEN;
  let observedStartedAt = null;

  const runStage = async (id, label, action, detail = '') => {
    replayStepIndex += 1;
    onStep(replayStepIndex, label, totalSteps);
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
      checks.push({
        id,
        label,
        status: 'failed',
        detail: error.message,
      });
      throw error;
    }
  };

  try {
    const status = await runStage(
      'device_connected',
      '设备连接',
      async () => {
        const current = await device.getDeviceStatus();
        if (!current?.connected) throw new Error('未检测到已连接设备');
        if (
          current.platform &&
          current.platform !== 'harmony' &&
          current.provider !== 'hdc'
        ) {
          throw new Error('快手直播录制修正版当前只支持鸿蒙 HDC 设备');
        }
        screen = normalizeScreen(
          current.screen || (await device.getScreenSize?.().catch(() => null)),
        );
        return current;
      },
      (current) => current.serial || current.provider || 'connected',
    );

    const launchResult = await runStage(
      'app_launched',
      '冷启动快手并处理开屏页面',
      async () => {
        await device.forceStopPackage(app.packageName);
        await device.launchPackage(app.packageName);
        const result = await waitForKuaishouReady({
          device,
          app,
          screen,
          delays,
          sleep,
          now,
        });
        await assertKuaishouForeground(device, app);
        return result;
      },
      (result) =>
        result.adSkipped
          ? `${status.serial || app.harmonyBundleName || app.packageName}，已跳过开屏广告`
          : status.serial || app.harmonyBundleName || app.packageName,
    );

    const homeSnapshot = await runStage(
      'home_opened',
      '进入快手首页频道页',
      async () => {
        let snapshot = await dismissKuaishouPrompt({
          device,
          snapshot: launchResult.snapshot,
          screen,
          delays,
          sleep,
        });
        if (isKuaishouHome(snapshot)) return snapshot;

        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await device.tap(point(screen, 0.1047, 0.9431));
          await sleep(delays.afterHomeTapMs);
          try {
            snapshot = await waitForSnapshot({
              device,
              predicate: isKuaishouHome,
              timeoutMs: delays.homeTimeoutMs,
              pollMs: delays.pollIntervalMs,
              message: '快手未显示包含直播频道的首页',
              sleep,
              now,
            });
            return snapshot;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error('快手未显示包含直播频道的首页');
      },
      '首页频道栏已显示',
    );

    const directorySnapshot = await runStage(
      'live_directory_opened',
      '进入快手直播频道',
      async () => {
        let snapshot = homeSnapshot;
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const liveTab =
            findTextNodeInRegion(snapshot, /^直播$/, {
              minX: 0,
              minY: 0,
              maxX: screen.width,
              maxY: Math.round(screen.height * 0.22),
            }) || null;
          await tapNodeOrCoordinate(device, liveTab, point(screen, 0.6234, 0.0802));
          await sleep(delays.afterLiveTabTapMs);
          try {
            snapshot = await waitForSnapshot({
              device,
              predicate: isKuaishouLiveDirectory,
              timeoutMs: delays.directoryTimeoutMs,
              pollMs: delays.pollIntervalMs,
              message: '快手直播频道未加载出直播卡片',
              sleep,
              now,
            });
            return snapshot;
          } catch (error) {
            lastError = error;
            snapshot = await getSnapshotWithRetry(device, {
              attempts: 2,
              pollMs: delays.pollIntervalMs,
              sleep,
            }).catch(() => snapshot);
          }
        }
        throw lastError || new Error('快手直播频道未加载出直播卡片');
      },
      '直播频道和直播卡片已显示',
    );

    const roomSnapshot = await runStage(
      'live_room_opened',
      '进入快手真实直播间',
      async () => {
        const candidates = [
          point(screen, 0.2961, 0.3259),
          point(screen, 0.742, 0.3259),
        ];
        let lastError = null;

        for (const candidate of candidates) {
          await device.tap(candidate);
          await sleep(delays.afterRoomTapMs);
          try {
            let snapshot = await waitForSnapshot({
              device,
              predicate: isKuaishouLiveRoom,
              timeoutMs: delays.roomTimeoutMs,
              pollMs: delays.pollIntervalMs,
              message: '快手未进入包含互动控件的真实直播间',
              sleep,
              now,
            });
            if (!isKuaishouLiveRoom(snapshot)) {
              await device.tap(point(screen, 0.5, 0.35));
              await sleep(delays.afterRoomRevealMs);
              snapshot = await getSnapshotWithRetry(device, {
                attempts: 3,
                pollMs: delays.pollIntervalMs,
                sleep,
              });
            }
            if (!isKuaishouLiveRoom(snapshot)) {
              throw new Error('快手直播间控件未显示');
            }
            await assertKuaishouForeground(device, app);
            return snapshot;
          } catch (error) {
            lastError = error;
            const snapshot = await getSnapshotWithRetry(device, {
              attempts: 2,
              pollMs: delays.pollIntervalMs,
              sleep,
            }).catch(() => null);
            if (snapshot && !isKuaishouLiveDirectory(snapshot)) break;
          }
        }
        throw lastError || new Error('快手未进入包含互动控件的真实直播间');
      },
      (snapshot) => describeLiveRoom(snapshot),
    );

    await runStage(
      'live_motion_verified',
      '确认快手直播画面持续变化',
      async () => {
        const ratio = await assertScreenChanges({
          device,
          intervalMs: delays.motionIntervalMs,
          minimum: 0.0005,
          sleep,
        });
        return ratio;
      },
      (ratio) => `画面变化率 ${ratio.toFixed(5)}`,
    );

    if (startCapture) {
      await runStage(
        'capture_started',
        '开始采集快手直播内容',
        () => startCapture(),
        '确认进入直播间后启动采集',
      );
    }

    observedStartedAt = now();
    const browseResult = await runStage(
      'duration_observed',
      '按设置时长浏览快手直播',
      () =>
        browseKuaishouLive({
          device,
          app,
          screen,
          initialSnapshot: roomSnapshot,
          durationMs: effectiveDurationMs,
          switchIntervalMs: effectiveSwitchIntervalMs,
          forceValidationSwitch: validationRun,
          delays,
          sleep,
          now,
          random,
        }),
      (result) =>
        `${result.observedMs}ms，切换直播 ${result.switchCount} 次，状态检查 ${result.stateCheckCount} 次`,
    );

    await runStage(
      'final_live_state',
      '确认任务结束时仍在快手直播间',
      async () => {
        const snapshot = await getSnapshotWithRetry(device, {
          attempts: 1,
          pollMs: delays.pollIntervalMs,
          sleep,
          snapshotOptions: QUICK_LAYOUT_OPTIONS,
        }).catch(() => null);
        if (snapshot && !isKuaishouLiveRoom(snapshot)) {
          throw new Error('任务结束时快手已离开直播间');
        }
        await assertKuaishouForeground(device, app);
        if (snapshot) return { mode: 'layout' };
        return { mode: 'foreground' };
      },
      (result) =>
        result.mode === 'layout'
          ? `已完成 ${browseResult.switchCount} 次直播切换，直播间控件仍存在`
          : `已完成 ${browseResult.switchCount} 次直播切换，布局读取超时后确认快手仍在前台`,
    );

    return {
      validationMode: KUAISHOU_LIVE_VALIDATION_MODE,
      validationChecks: checks,
      effectiveDurationMs,
      effectiveSwitchIntervalMs,
      replayStepIndex,
      replaySource: KUAISHOU_LIVE_VALIDATION_MODE,
      switchCount: browseResult.switchCount,
      correctedSteps: buildKuaishouLiveCorrectedSteps(screen),
      correctionChanges: [
        '冷启动快手并识别、跳过可选开屏广告',
        '用页面状态确认首页和直播频道，不复用录制时的瞬时节点状态',
        '进入直播间后校验互动控件和动态画面',
        '短时回放强制切换一次直播，切换后再次验证直播间状态',
        '按持续时间参数浏览，采集仅在确认进入直播间后启动',
      ],
      correctionConfidence: 0.99,
    };
  } catch (error) {
    error.validationMode = KUAISHOU_LIVE_VALIDATION_MODE;
    error.validationChecks = checks;
    error.replayStepIndex = replayStepIndex;
    error.effectiveDurationMs =
      observedStartedAt == null ? null : Math.max(0, now() - observedStartedAt);
    error.effectiveSwitchIntervalMs = effectiveSwitchIntervalMs;
    throw error;
  }
}

async function waitForKuaishouReady({
  device,
  app,
  screen,
  delays,
  sleep,
  now,
}) {
  const deadline = now() + delays.startupTimeoutMs;
  let adSkipped = false;
  let lastError = null;

  while (now() <= deadline) {
    try {
      const snapshot = await device.getUiTextSnapshot();
      if (isKuaishouReady(snapshot)) return { snapshot, adSkipped };

      if (isKuaishouStartupAd(snapshot)) {
        const skipNode = findLayoutNode(snapshot, (node) =>
          node.textValues.some((value) => /^跳过(?:\s*\d+)?$/.test(value)),
        );
        await tapNodeOrCoordinate(device, skipNode, point(screen, 0.87, 0.045));
        adSkipped = true;
        await sleep(delays.afterAdSkipMs);
        continue;
      }
    } catch (error) {
      lastError = error;
    }

    await assertKuaishouForeground(device, app).catch((error) => {
      lastError = error;
    });
    await sleep(delays.pollIntervalMs);
  }

  throw new Error(
    lastError
      ? `快手冷启动页面未就绪: ${lastError.message}`
      : '快手冷启动页面未就绪',
  );
}

async function dismissKuaishouPrompt({
  device,
  snapshot,
  screen,
  delays,
  sleep,
}) {
  if (!snapshotText(snapshot).includes('打开推送通知')) return snapshot;

  const ignoreNode = findLayoutNode(snapshot, (node) =>
    node.textValues.some((value) => /^忽略$/.test(value)),
  );
  await tapNodeOrCoordinate(device, ignoreNode, point(screen, 0.3, 0.62));
  await sleep(delays.afterPromptDismissMs);
  return getSnapshotWithRetry(device, {
    attempts: 3,
    pollMs: delays.pollIntervalMs,
    sleep,
  });
}

async function browseKuaishouLive({
  device,
  app,
  screen,
  initialSnapshot,
  durationMs,
  switchIntervalMs,
  forceValidationSwitch,
  delays,
  sleep,
  now,
  random,
}) {
  const startedAt = now();
  const deadline = startedAt + durationMs;
  let snapshot = initialSnapshot;
  let stateCheckCount = 0;
  let switchCount = 0;
  let nextSwitchAt =
    forceValidationSwitch && durationMs >= 2000
      ? startedAt + Math.min(2000, Math.max(600, Math.floor(durationMs / 2)))
      : startedAt + nextSwitchWaitMs(switchIntervalMs, random);

  while (now() < deadline) {
    const wakeAt = Math.min(
      deadline,
      nextSwitchAt,
      now() + STATUS_CHECK_INTERVAL_MS,
    );
    const waitMs = Math.max(0, wakeAt - now());
    if (waitMs > 0) await sleep(waitMs);

    stateCheckCount += 1;
    await assertKuaishouForeground(device, app);

    if (now() >= nextSwitchAt && now() < deadline) {
      const before = await device.screenshotPng?.().catch(() => null);
      await device.swipe(swipe(screen));
      await sleep(delays.afterSwitchMs);
      snapshot = await getSnapshotWithRetry(device, {
        attempts: 1,
        pollMs: delays.pollIntervalMs,
        sleep,
        snapshotOptions: QUICK_LAYOUT_OPTIONS,
      }).catch(() => null);
      if (snapshot && !isKuaishouLiveRoom(snapshot)) {
        throw new Error('切换后未进入下一场快手直播');
      }
      await assertKuaishouForeground(device, app);
      const after = await device.screenshotPng?.().catch(() => null);
      if (before && after) {
        const ratio = estimateBufferDifference(before, after);
        if (ratio < 0.0005) {
          throw new Error(`快手直播切换后画面变化不足，变化率 ${ratio.toFixed(5)}`);
        }
      }
      switchCount += 1;
      nextSwitchAt = now() + nextSwitchWaitMs(switchIntervalMs, random);
    }
  }

  return {
    observedMs: Math.max(0, now() - startedAt),
    switchCount,
    stateCheckCount,
  };
}

async function waitForSnapshot({
  device,
  predicate,
  timeoutMs,
  pollMs,
  message,
  sleep,
  now,
}) {
  const deadline = now() + timeoutMs;
  let lastError = null;
  while (now() <= deadline) {
    try {
      const snapshot = await device.getUiTextSnapshot();
      if (predicate(snapshot)) return snapshot;
    } catch (error) {
      lastError = error;
    }
    await sleep(pollMs);
  }
  throw new Error(lastError ? `${message}: ${lastError.message}` : message);
}

async function getSnapshotWithRetry(
  device,
  {
    attempts = 3,
    pollMs = 500,
    sleep = wait,
    snapshotOptions = undefined,
  } = {},
) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await device.getUiTextSnapshot(snapshotOptions);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(pollMs);
    }
  }
  throw lastError || new Error('无法读取快手界面');
}

async function assertScreenChanges({
  device,
  intervalMs,
  minimum,
  sleep,
}) {
  if (typeof device.screenshotPng !== 'function') {
    throw new Error('当前设备适配器不支持快手直播画面验证');
  }
  const first = await device.screenshotPng();
  await sleep(intervalMs);
  const second = await device.screenshotPng();
  const ratio = estimateBufferDifference(first, second);
  if (ratio < minimum) {
    throw new Error(`快手直播画面变化不足，变化率 ${ratio.toFixed(5)}`);
  }
  return ratio;
}

async function assertKuaishouForeground(device, app) {
  if (typeof device.getCurrentFocus !== 'function') return;
  const focus = await device.getCurrentFocus();
  const actual = focus?.bundleName || focus?.packageName || '';
  const expected = [app.packageName, app.harmonyBundleName].filter(Boolean);
  if (actual && !expected.includes(actual)) {
    throw new Error(`快手不在前台，当前前台应用为 ${actual}`);
  }
}

function isKuaishouStartupAd(snapshot) {
  const text = snapshotText(snapshot);
  return /广告/.test(text) && /跳过\s*\d*/.test(text);
}

function isKuaishouReady(snapshot) {
  return ['首页', '精选', '消息', '我'].every((value) =>
    hasSnapshotText(snapshot, new RegExp(`^${value}$`)),
  );
}

function isKuaishouHome(snapshot) {
  return (
    isKuaishouReady(snapshot) &&
    ['发现', '同城', '直播', '探索'].every((value) =>
      hasSnapshotText(snapshot, new RegExp(`^${value}$`)),
    )
  );
}

function isKuaishouLiveDirectory(snapshot) {
  return (
    isKuaishouHome(snapshot) &&
    LIVE_DIRECTORY_EVIDENCE.some((matcher) => hasSnapshotText(snapshot, matcher))
  );
}

function isKuaishouLiveRoom(snapshot) {
  return (
    hasSnapshotText(snapshot, /^说点什么(?:\.\.\.)?$/) &&
    LIVE_ROOM_EVIDENCE.some((matcher) => hasSnapshotText(snapshot, matcher))
  );
}

function describeLiveRoom(snapshot) {
  const text = snapshotText(snapshot);
  if (/游戏频道/.test(text)) return '已进入快手游戏直播间';
  if (/更多直播/.test(text)) return '已进入快手直播间';
  return '已显示快手直播互动控件';
}

function findTextNodeInRegion(snapshot, matcher, region) {
  return findLayoutNode(snapshot, (node) => {
    if (!node.bounds) return false;
    if (!node.textValues.some((value) => matcher.test(value))) return false;
    return (
      node.centerX >= region.minX &&
      node.centerX <= region.maxX &&
      node.centerY >= region.minY &&
      node.centerY <= region.maxY
    );
  });
}

function findLayoutNode(snapshot, predicate) {
  return flattenLayout(snapshot?.layout).find(predicate) || null;
}

function hasSnapshotText(snapshot, matcher) {
  return (snapshot?.values || []).some((value) => matcher.test(String(value)));
}

function snapshotText(snapshot) {
  return (snapshot?.values || []).map(String).join('\n');
}

function flattenLayout(layout) {
  const nodes = [];
  const visit = (raw) => {
    if (!raw || typeof raw !== 'object') return;
    nodes.push(normalizeLayoutNode(raw));
    for (const child of Array.isArray(raw.children) ? raw.children : []) visit(child);
  };
  visit(layout);
  return nodes;
}

function normalizeLayoutNode(raw) {
  const attributes =
    raw?.attributes && typeof raw.attributes === 'object'
      ? raw.attributes
      : raw?.attrs && typeof raw.attrs === 'object'
        ? raw.attrs
        : raw || {};
  const bounds = parseBounds(
    attributes.bounds ?? attributes.rect ?? attributes.frame,
  );
  return {
    raw,
    attributes,
    bounds,
    centerX: bounds ? Math.round((bounds.x1 + bounds.x2) / 2) : null,
    centerY: bounds ? Math.round((bounds.y1 + bounds.y2) / 2) : null,
    textValues: [
      attributes.text,
      attributes.originalText,
      attributes.description,
      attributes.contentDescription,
      attributes['content-desc'],
      attributes.hint,
      attributes.label,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  };
}

function parseBounds(value) {
  if (typeof value === 'string') {
    const match = value.match(
      /\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/,
    );
    if (match) {
      return {
        x1: Number(match[1]),
        y1: Number(match[2]),
        x2: Number(match[3]),
        y2: Number(match[4]),
      };
    }
  }
  return null;
}

async function tapNodeOrCoordinate(device, node, fallback) {
  await device.tap({
    x: node?.centerX ?? fallback.x,
    y: node?.centerY ?? fallback.y,
  });
}

function nextSwitchWaitMs(switchIntervalMs, random) {
  const requested = Number(switchIntervalMs);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.max(MIN_SWITCH_INTERVAL_MS, Math.round(requested));
  }
  return randomInt(DEFAULT_SWITCH_MIN_MS, DEFAULT_SWITCH_MAX_MS, random);
}

function normalizeKuaishouLiveDurationMs(value) {
  const durationMs = Number(value);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`无效的快手直播观看时长毫秒数: ${JSON.stringify(value)}`);
  }
  return Math.min(MAX_DURATION_MS, Math.max(1000, Math.round(durationMs)));
}

function randomInt(min, max, random) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return low + Math.floor(random() * (high - low + 1));
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

function normalizeScreen(screen) {
  return {
    width: Number(screen?.width) || DEFAULT_SCREEN.width,
    height: Number(screen?.height) || DEFAULT_SCREEN.height,
  };
}

function point(screen, normalizedX, normalizedY) {
  return {
    x: Math.round(screen.width * normalizedX),
    y: Math.round(screen.height * normalizedY),
  };
}

function swipe(screen) {
  const x = Math.round(screen.width * 0.52);
  return {
    x1: x,
    y1: Math.round(screen.height * 0.78),
    x2: x,
    y2: Math.round(screen.height * 0.22),
    durationMs: 420,
  };
}

function pointStep(screen, normalizedX, normalizedY, delayMs, target = null) {
  return {
    type: 'tap',
    ...point(screen, normalizedX, normalizedY),
    normalizedX,
    normalizedY,
    referenceScreen: screen,
    coordinateSpace: 'safe_area',
    delayMs,
    ...(target ? { target } : {}),
  };
}

function assertState(state) {
  return {
    type: 'assert_state',
    state,
    timeoutMs: 5000,
    pollMs: 500,
    optional: false,
    delayMs: 0,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
