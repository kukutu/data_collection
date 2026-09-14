import { config } from '../config.js';

export const TAOBAO_LIVE_WORKFLOW_ID = 'live:taobao:live-browse';
export const TAOBAO_LIVE_VALIDATION_MODE = 'taobao_live_browse_v1';

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
  videoPageMs: 5000,
  liveRoomMs: 6000,
  motionMs: 1500,
  switchMs: 3000,
  switchBufferMs: 2500,
  couponPollMs: 3000,
  couponSettleMs: 800,
});

const VIDEO_TAB_IDS = ['tab_video'];
const LIVE_TAB_IDS = ['tab_innerLive'];
const LIVE_ROOM_NODE_IDS = ['taoliveTmsEmbed', 'LiveTMSEmbedComponent'];
const TOP_NAVIGATION_TEXT = new Set([
  '视频',
  '直播',
  '短剧',
  '关注',
  '推荐',
  '返回',
]);
const LIVE_UNAVAILABLE_EVIDENCE = [
  /直播已结束/,
  /主播已下播/,
  /暂未开播/,
  /直播间已关闭/,
];
const COUPON_CONTEXT_EVIDENCE = [
  /优惠券/,
  /领券中心/,
  /直播券/,
  /店铺券/,
  /无门槛/,
  /满\s*\d+(?:\.\d+)?\s*减\s*\d+(?:\.\d+)?/,
];
const COUPON_CLAIM_EVIDENCE = /^(?:立即|马上|一键|全部|点击)?领取(?:优惠券)?(?:\s*[>›»])?$/;

export async function executeTaobaoLiveBrowse({
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
  if (!device) throw new Error('淘宝直播缺少设备适配器');
  if (app?.id !== 'taobao' || !app.packageName) {
    throw new Error('淘宝直播 skill 只能用于淘宝 App');
  }

  const delays = { ...DEFAULT_TIMINGS, ...timings };
  const effectiveDurationMs = normalizeDurationMs(durationMs);
  const effectiveSwitchIntervalMs = normalizeSwitchIntervalMs(switchIntervalMs);
  const validationChecks = [];
  const totalSteps = 7 + (startCapture ? 1 : 0);
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

  await runStage('device_connected', '确认淘宝直播测试设备', async () => {
    const status = await device.getDeviceStatus?.();
    if (status && !status.connected) throw new Error('未检测到已连接设备');
    screen = normalizeScreen(
      status?.screen || (await device.getScreenSize?.().catch(() => null)),
    );
    return status;
  });

  const videoSnapshot = await runStage(
    'video_page_opened',
    '从淘宝首页底部进入视频页面',
    () =>
      openTaobaoVideoPage({
        device,
        app,
        screen,
        delays,
        sleep,
        now,
      }),
    '已识别顶部视频、直播和短剧频道',
  );

  const openedSnapshot = await runStage(
    'live_room_opened',
    '点击淘宝视频页顶部直播频道',
    () =>
      openTaobaoLiveRoom({
        device,
        app,
        screen,
        videoSnapshot,
        delays,
        sleep,
        now,
      }),
    describeTaobaoLiveRoom,
  );

  const couponResult = await runStage(
    'coupon_processed',
    '检查并领取淘宝直播优惠券',
    async () => {
      const result = await claimVisibleTaobaoCoupons({
        device,
        screen,
        snapshot: openedSnapshot,
        delays,
        sleep,
      });
      if (!isTaobaoLiveRoom(result.snapshot)) {
        result.snapshot = await waitForSnapshot({
          device,
          predicate: isTaobaoLiveRoom,
          timeoutMs: 5000,
          pollMs: 600,
          sleep,
          now,
          message: '领取淘宝直播优惠券后未恢复直播间',
        });
      }
      return result;
    },
    (result) =>
      result.claimedCount > 0
        ? `已领取 ${result.claimedCount} 张优惠券`
        : '当前未出现优惠券弹窗',
  );
  const roomSnapshot = couponResult.snapshot;

  await runStage(
    'live_room_verified',
    '确认淘宝真实直播间控件',
    async () => {
      if (!isTaobaoLiveRoom(roomSnapshot)) {
        throw new Error('淘宝直播间缺少观看人数、评论输入框或直播容器');
      }
      await assertTaobaoForeground(device, app);
      return roomSnapshot;
    },
    describeTaobaoLiveRoom,
  );

  await runStage(
    'live_motion_verified',
    '确认淘宝直播画面持续变化',
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
      '开始采集淘宝直播内容',
      () => startCapture(),
      '真实直播间和动态画面验证通过后启动采集',
    );
  }

  const browseResult = await runStage(
    'duration_observed',
    '按设置时长浏览并切换淘宝直播',
    () =>
      browseTaobaoLive({
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
        initialCouponClaimCount: couponResult.claimedCount,
      }),
    (result) =>
      `浏览 ${result.observedMs}ms，成功上滑切换 ${result.switchCount} 次，领取优惠券 ${result.couponClaimCount} 张`,
  );

  return {
    validationMode: TAOBAO_LIVE_VALIDATION_MODE,
    validationChecks,
    effectiveDurationMs,
    effectiveSwitchIntervalMs,
    replayStepIndex,
    replaySource: TAOBAO_LIVE_VALIDATION_MODE,
    switchCount: browseResult.switchCount,
    couponClaimCount: browseResult.couponClaimCount,
    browseResult,
  };
}

async function openTaobaoVideoPage({
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
  await assertTaobaoForeground(device, app);

  let snapshot = await getSnapshot(device);
  if (isTaobaoVideoPage(snapshot)) return snapshot;

  const videoPoint = findUiPoint(snapshot, {
    ids: VIDEO_TAB_IDS,
    texts: ['视频'],
    minYRatio: 0.85,
    screen,
  });
  await device.tap(videoPoint || point(screen, 0.3, 0.955));
  await sleep(delays.videoPageMs);

  snapshot = await waitForSnapshot({
    device,
    predicate: isTaobaoVideoPage,
    timeoutMs: 9000,
    pollMs: 600,
    sleep,
    now,
    message: '淘宝底部视频入口未进入带顶部频道栏的视频页面',
  });
  await assertTaobaoForeground(device, app);
  return snapshot;
}

async function openTaobaoLiveRoom({
  device,
  app,
  screen,
  videoSnapshot,
  delays,
  sleep,
  now,
}) {
  let snapshot = await getSnapshot(device).catch(() => videoSnapshot);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (isTaobaoLiveRoom(snapshot) || findTaobaoCouponClaimPoint(snapshot, screen)) {
      await assertTaobaoForeground(device, app);
      return snapshot;
    }
    if (!isTaobaoVideoPage(snapshot)) break;

    const livePoint = findUiPoint(snapshot, {
      ids: LIVE_TAB_IDS,
      texts: ['直播'],
      maxYRatio: 0.16,
      screen,
    });
    if (!livePoint) {
      throw new Error('淘宝视频页缺少可点击的顶部直播频道');
    }

    await device.tap(livePoint);
    await sleep(delays.liveRoomMs);
    snapshot = await getSnapshot(device);
  }

  snapshot = await waitForSnapshot({
    device,
    predicate: (value) =>
      isTaobaoLiveRoom(value) || Boolean(findTaobaoCouponClaimPoint(value, screen)),
    timeoutMs: 4000,
    pollMs: 600,
    sleep,
    now,
    message: '淘宝顶部直播频道未进入真实直播间',
  });
  await assertTaobaoForeground(device, app);
  return snapshot;
}

async function browseTaobaoLive({
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
  initialCouponClaimCount = 0,
}) {
  const startedAt = now();
  const deadline = startedAt + durationMs;
  let snapshot = initialSnapshot;
  let switchCount = 0;
  let retryCount = 0;
  let couponClaimCount = initialCouponClaimCount;
  let nextSwitchAt = startedAt + nextSwitchWaitMs(switchIntervalMs, random);
  let nextCouponPollAt = startedAt + Number(delays.couponPollMs || 3000);

  while (now() < deadline) {
    const wakeAt = Math.min(deadline, nextSwitchAt, nextCouponPollAt);
    const waitMs = Math.max(0, wakeAt - now());
    if (waitMs > 0) await sleep(waitMs);
    if (now() >= deadline) break;

    if (now() >= nextCouponPollAt) {
      await assertTaobaoForeground(device, app);
      const couponResult = await claimVisibleTaobaoCoupons({
        device,
        screen,
        snapshot: await getSnapshot(device),
        delays,
        sleep,
      });
      snapshot = couponResult.snapshot;
      couponClaimCount += couponResult.claimedCount;
      nextCouponPollAt = now() + Number(delays.couponPollMs || 3000);
      if (now() < nextSwitchAt) continue;
    }

    const remainingMs = deadline - now();
    if (remainingMs < minimumSwitchBudgetMs(delays)) {
      await sleep(remainingMs);
      break;
    }

    await assertTaobaoForeground(device, app);
    const switched = await switchTaobaoLiveRoom({
      device,
      app,
      screen,
      currentSnapshot: snapshot,
      delays,
      sleep,
    });
    snapshot = switched.snapshot;
    retryCount += switched.retryCount;
    couponClaimCount += switched.couponClaimCount;
    switchCount += 1;
    nextSwitchAt = now() + nextSwitchWaitMs(switchIntervalMs, random);
  }

  await assertTaobaoForeground(device, app);
  const finalCouponResult = await claimVisibleTaobaoCoupons({
    device,
    screen,
    snapshot: await getSnapshot(device).catch(() => snapshot),
    delays,
    sleep,
  });
  const finalSnapshot = finalCouponResult.snapshot;
  couponClaimCount += finalCouponResult.claimedCount;
  if (!isTaobaoLiveRoom(finalSnapshot)) {
    throw new Error('淘宝直播浏览结束时已离开真实直播间');
  }

  return {
    observedMs: Math.max(0, now() - startedAt),
    switchCount,
    retryCount,
    couponClaimCount,
    finalIdentity: extractTaobaoLiveRoomIdentity(finalSnapshot),
  };
}

async function switchTaobaoLiveRoom({
  device,
  app,
  screen,
  currentSnapshot,
  delays,
  sleep,
}) {
  const beforeCouponResult = await claimVisibleTaobaoCoupons({
    device,
    screen,
    snapshot: currentSnapshot,
    delays,
    sleep,
  });
  const beforeIdentity = extractTaobaoLiveRoomIdentity(beforeCouponResult.snapshot);
  let couponClaimCount = beforeCouponResult.claimedCount;
  const gestures = [
    {
      x1: Math.round(screen.width * 0.28),
      y1: Math.round(screen.height * 0.81),
      x2: Math.round(screen.width * 0.28),
      y2: Math.round(screen.height * 0.15),
      durationMs: 620,
    },
    {
      x1: Math.round(screen.width * 0.5),
      y1: Math.round(screen.height * 0.84),
      x2: Math.round(screen.width * 0.5),
      y2: Math.round(screen.height * 0.12),
      durationMs: 560,
    },
  ];

  for (const [index, gesture] of gestures.entries()) {
    await device.swipe(gesture);
    await sleep(delays.switchMs);
    const couponResult = await claimVisibleTaobaoCoupons({
      device,
      screen,
      snapshot: await getSnapshot(device),
      delays,
      sleep,
    });
    const snapshot = couponResult.snapshot;
    couponClaimCount += couponResult.claimedCount;
    const nextIdentity = extractTaobaoLiveRoomIdentity(snapshot);
    if (
      isTaobaoLiveRoom(snapshot) &&
      beforeIdentity &&
      nextIdentity &&
      beforeIdentity !== nextIdentity
    ) {
      await assertTaobaoForeground(device, app);
      return {
        snapshot,
        retryCount: index,
        couponClaimCount,
        fromIdentity: beforeIdentity,
        toIdentity: nextIdentity,
      };
    }
  }

  throw new Error('淘宝直播完成上滑，但主播未变化，未计为成功切换');
}

async function claimVisibleTaobaoCoupons({
  device,
  screen,
  snapshot,
  delays,
  sleep,
}) {
  let current = snapshot || (await getSnapshot(device));
  let claimedCount = 0;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const claimPoint = findTaobaoCouponClaimPoint(current, screen);
    if (!claimPoint) break;
    await device.tap(claimPoint);
    claimedCount += 1;
    await sleep(Number(delays.couponSettleMs || 800));
    current = await getSnapshot(device);
  }

  return { snapshot: current, claimedCount };
}

export function findTaobaoCouponClaimPoint(snapshot, screen = null) {
  const values = snapshotValues(snapshot);
  const hasCouponContext = COUPON_CONTEXT_EVIDENCE.some((matcher) =>
    values.some((value) => matcher.test(value)),
  );
  if (!hasCouponContext) return null;

  const size = normalizeScreen(screen || inferLayoutScreen(snapshot?.layout));
  const candidates = [];
  let order = 0;

  const visit = (raw, clickableAncestors = []) => {
    if (!raw || typeof raw !== 'object') return;
    const attributes = raw.attributes || raw.attrs || raw;
    const bounds = parseBounds(attributes.bounds);
    const currentAncestors =
      bounds && String(attributes.clickable) === 'true'
        ? [bounds, ...clickableAncestors]
        : clickableAncestors;
    const texts = [
      attributes.text,
      attributes.originalText,
      attributes.description,
      attributes.hint,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    if (bounds && texts.some((value) => COUPON_CLAIM_EVIDENCE.test(value))) {
      const targetBounds = currentAncestors[0] || bounds;
      const centerY = (targetBounds.y1 + targetBounds.y2) / 2;
      if (centerY >= size.height * 0.15 && centerY <= size.height * 0.92) {
        candidates.push({
          x: Math.round((targetBounds.x1 + targetBounds.x2) / 2),
          y: Math.round(centerY),
          zIndex: Number(attributes.zIndex || 0),
          order: order += 1,
        });
      }
    }

    for (const child of Array.isArray(raw.children) ? raw.children : []) {
      visit(child, currentAncestors);
    }
  };

  visit(snapshot?.layout);
  candidates.sort((left, right) =>
    right.zIndex - left.zIndex || right.order - left.order,
  );
  const candidate = candidates[0];
  return candidate ? { x: candidate.x, y: candidate.y } : null;
}

export function isTaobaoVideoPage(snapshot) {
  if (isTaobaoLiveRoom(snapshot)) return false;
  const values = snapshotValues(snapshot);
  const ids = snapshotNodeIds(snapshot);
  return (
    VIDEO_TAB_IDS.every((id) => ids.includes(id)) &&
    LIVE_TAB_IDS.every((id) => ids.includes(id)) &&
    values.includes('视频') &&
    values.includes('直播') &&
    values.includes('短剧')
  );
}

export function isTaobaoLiveRoom(snapshot) {
  if (isTaobaoLiveUnavailable(snapshot)) return false;
  const values = snapshotValues(snapshot);
  const ids = snapshotNodeIds(snapshot);
  const hasRoomContainer = LIVE_ROOM_NODE_IDS.some((id) => ids.includes(id));
  const hasCommentInput = values.some((value) => /说点什么/.test(value));
  const hasViewerCount = values.some((value) => /观看/.test(value));
  return hasRoomContainer && hasCommentInput && hasViewerCount;
}

export function isTaobaoLiveUnavailable(snapshot) {
  const values = snapshotValues(snapshot);
  return LIVE_UNAVAILABLE_EVIDENCE.some((matcher) =>
    values.some((value) => matcher.test(value)),
  );
}

export function extractTaobaoLiveRoomIdentity(snapshot) {
  const size = normalizeScreen(inferLayoutScreen(snapshot?.layout));
  for (const node of flattenLayout(snapshot?.layout)) {
    const attributes = node.attributes;
    const bounds = parseBounds(attributes.bounds);
    if (!bounds || String(attributes.type) !== 'Text') continue;
    const centerY = (bounds.y1 + bounds.y2) / 2;
    if (centerY < size.height * 0.09 || centerY > size.height * 0.145) continue;
    const value = firstNodeText(attributes);
    if (!value || TOP_NAVIGATION_TEXT.has(value)) continue;
    if (/观看|ID[:：]|\d{1,2}:\d{2}/.test(value)) continue;
    return value;
  }
  return null;
}

async function assertTaobaoForeground(device, app) {
  if (typeof device.getCurrentFocus !== 'function') return;
  const focus = await device.getCurrentFocus();
  const actual = focus?.bundleName || focus?.packageName || '';
  const expected = [app.packageName, app.harmonyBundleName].filter(Boolean);
  if (actual && !expected.includes(actual)) {
    throw new Error(`淘宝不在前台，当前前台应用为 ${actual}`);
  }
}

async function assertScreenChanges({
  device,
  intervalMs,
  minimum,
  sleep,
}) {
  if (typeof device.screenshotPng !== 'function') {
    throw new Error('当前设备适配器不支持淘宝直播画面验证');
  }
  const first = await device.screenshotPng();
  await sleep(intervalMs);
  const second = await device.screenshotPng();
  const ratio = estimateBufferDifference(first, second);
  if (ratio < minimum) {
    throw new Error(`淘宝直播画面变化不足，变化率 ${ratio.toFixed(5)}`);
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

function describeTaobaoLiveRoom(snapshot) {
  const identity = extractTaobaoLiveRoomIdentity(snapshot);
  return identity ? `已进入淘宝直播间：${identity}` : '已显示淘宝直播互动控件';
}

function findUiPoint(
  snapshot,
  {
    ids = [],
    texts = [],
    minYRatio = 0,
    maxYRatio = 1,
    screen = null,
  } = {},
) {
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
    const nodeId = String(
      attributes.id ||
        attributes.resourceId ||
        attributes.resourceIdName ||
        attributes.key ||
        '',
    ).trim();
    const nodeTexts = [
      attributes.text,
      attributes.originalText,
      attributes.description,
      attributes.hint,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const matched =
      ids.includes(nodeId) || texts.some((text) => nodeTexts.includes(text));

    if (matched && bounds) {
      const targetBounds = currentAncestors[0] || bounds;
      const centerY = (targetBounds.y1 + targetBounds.y2) / 2;
      if (
        centerY >= size.height * minYRatio &&
        centerY <= size.height * maxYRatio
      ) {
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

function normalizeDurationMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的淘宝直播观看时长: ${JSON.stringify(value)}`);
  }
  return Math.min(MAX_DURATION_MS, Math.max(1000, Math.round(parsed)));
}

function normalizeSwitchIntervalMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效的淘宝直播切换间隔: ${JSON.stringify(value)}`);
  }
  return Math.max(MIN_SWITCH_INTERVAL_MS, Math.round(parsed));
}

function nextSwitchWaitMs(switchIntervalMs, random) {
  if (switchIntervalMs) return switchIntervalMs;
  return randomInt(DEFAULT_SWITCH_MIN_MS, DEFAULT_SWITCH_MAX_MS, random);
}

function minimumSwitchBudgetMs(delays) {
  return Math.max(
    2500,
    Number(delays.switchMs || 0) + Number(delays.switchBufferMs || 0),
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
