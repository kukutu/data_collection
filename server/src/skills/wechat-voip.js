import { config } from '../config.js';
import { startCaptureBeforeAction } from './capture-timing.js';

export const WECHAT_AUDIO_CALL_WORKFLOW_ID = 'voip:wechat:audio-call';
export const WECHAT_VIDEO_CALL_WORKFLOW_ID = 'voip:wechat:video-call';
export const WECHAT_VOIP_VALIDATION_MODE = 'wechat_voip_call_v1';

const MAX_CALL_DURATION_MS = 2 * 60 * 60 * 1000;
const CALL_STATUS_CHECK_INTERVAL_MS = 30 * 1000;

const DEFAULT_SCREEN = {
  width: config.screen.defaultWidth,
  height: config.screen.defaultHeight,
};

const DEFAULT_TIMINGS = Object.freeze({
  afterLaunchMs: 3500,
  afterConversationMs: 1800,
  afterDetailsMs: 900,
  afterProfileMs: 900,
  afterTypeSheetMs: 600,
  permissionSettleMs: 700,
  pollIntervalMs: 500,
  callStartTimeoutMs: 15_000,
  callObservationMs: 3000,
  controlsSettleMs: 500,
  hangupSettleMs: 1400,
  hangupTimeoutMs: 10_000,
});

export function isWechatVoipWorkflowId(workflowId) {
  return [
    WECHAT_AUDIO_CALL_WORKFLOW_ID,
    WECHAT_VIDEO_CALL_WORKFLOW_ID,
  ].includes(workflowId);
}

export function callTypeForWechatWorkflow(workflowId) {
  return workflowId === WECHAT_VIDEO_CALL_WORKFLOW_ID ? 'video' : 'audio';
}

export function buildWechatVoipCorrectedSteps(screen = DEFAULT_SCREEN, callType = 'audio') {
  const size = normalizeScreen(screen);
  const packages = ['com.tencent.wechat', 'com.tencent.mm'];
  const state = (values, extra = {}) => ({
    packages,
    textAny: values,
    nodeIds: [],
    activities: [],
    strength: 2,
    ...extra,
  });
  return [
    pointStep(size, 0.5, 0.217, DEFAULT_TIMINGS.afterLaunchMs),
    assertState(state([], { nodeIds: ['chat_list'] })),
    pointStep(size, 0.922, 0.075, DEFAULT_TIMINGS.afterConversationMs),
    assertState(state(['聊天详情'])),
    pointStep(size, 0.1, 0.159, DEFAULT_TIMINGS.afterDetailsMs),
    assertState(state(['音视频通话', '发消息'])),
    pointStep(size, 0.5, 0.571, DEFAULT_TIMINGS.afterProfileMs, {
      texts: ['音视频通话'],
      required: false,
    }),
    assertState(state(['视频通话', '语音通话'])),
    pointStep(
      size,
      0.614,
      callType === 'video' ? 0.755 : 0.831,
      DEFAULT_TIMINGS.afterTypeSheetMs,
      {
        texts: [callType === 'video' ? '视频通话' : '语音通话'],
        required: false,
      },
    ),
    assertState(
      state([
        '等待对方',
        '通话时长',
        '已接通',
        callType === 'video' ? '摄像头' : '麦克风',
      ]),
    ),
    {
      type: 'hold_state',
      durationParameter: 'duration',
      durationMs: DEFAULT_TIMINGS.callObservationMs,
      pollMs: CALL_STATUS_CHECK_INTERVAL_MS,
      state: state(['等待对方', '通话时长', '已接通']),
      optional: false,
      delayMs: 0,
    },
    pointStep(size, 0.5, 0.494, 0),
    pointStep(size, 0.503, 0.863, DEFAULT_TIMINGS.controlsSettleMs, {
      texts: ['挂断', '取消'],
      required: false,
    }),
    {
      ...assertState(state(['发消息', '音视频通话', '聊天详情'])),
      optional: true,
    },
  ];
}

export async function executeWechatVoipCall({
  device,
  app,
  workflowId = null,
  callType = null,
  parameters = {},
  durationMs = null,
  startCapture = null,
  onStep = () => {},
  sleep = wait,
  now = () => Date.now(),
  timings = {},
} = {}) {
  if (!device) throw new Error('微信音视频通话缺少设备适配器');
  if (app?.id !== 'wechat' || !app.packageName) {
    throw new Error('微信音视频通话 skill 只能用于微信 App');
  }

  const type = normalizeCallType(callType || callTypeForWechatWorkflow(workflowId));
  const typeLabel = type === 'video' ? '视频通话' : '语音通话';
  const delays = { ...DEFAULT_TIMINGS, ...timings };
  const callDurationMs = resolveCallDurationMs(
    durationMs,
    parameters.duration,
    delays.callObservationMs,
  );
  const validationChecks = [];
  const totalSteps = 9 + (startCapture ? 1 : 0);
  let replayStepIndex = 0;
  let screen = DEFAULT_SCREEN;
  let callStarted = false;
  let callStartedAt = null;

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
          throw new Error('微信音视频通话当前只支持鸿蒙 HDC 设备');
        }
        screen = normalizeScreen(
          current.screen || (await device.getScreenSize?.().catch(() => null)),
        );
        return current;
      },
      (current) => current.serial || current.provider || 'connected',
    );

    const listSnapshot = await runStage(
      'app_launched',
      '打开微信聊天列表',
      async () => {
        await device.forceStopPackage(app.packageName);
        await device.launchPackage(app.packageName);
        await sleep(delays.afterLaunchMs);
        await device.assertNoSensitivePrompt?.();
        const snapshot = await waitForSnapshot(
          device,
          isWechatConversationList,
          delays,
          '微信未显示聊天列表',
          sleep,
        );
        await assertWechatForeground(device, app);
        return snapshot;
      },
      status.serial || app.harmonyBundleName || app.packageName,
    );

    const chatSnapshot = await runStage(
      'first_conversation_opened',
      '进入第一个会话',
      async () => {
        const firstTitle = findLayoutNode(
          listSnapshot,
          (node) => node.attributes.id === 'Title' && node.centerY > screen.height * 0.12,
        );
        await tapNodeOrCoordinate(device, firstTitle, point(screen, 0.5, 0.217));
        await sleep(delays.afterConversationMs);
        const snapshot = await waitForSnapshot(
          device,
          isWechatChat,
          delays,
          '微信首个会话未显示消息输入框',
          sleep,
        );
        await assertWechatForeground(device, app);
        return snapshot;
      },
      '聊天列表中的第一个会话',
    );

    const detailsSnapshot = await runStage(
      'chat_details_opened',
      '打开聊天详情',
      async () => {
        const detailsButton = findLayoutNode(
          chatSnapshot,
          (node) =>
            isTrue(node.attributes.clickable) &&
            node.bounds &&
            node.centerX > screen.width * 0.84 &&
            node.bounds.y1 >= screen.height * 0.04 &&
            node.bounds.y2 <= screen.height * 0.12,
        );
        await tapNodeOrCoordinate(device, detailsButton, point(screen, 0.922, 0.075));
        await sleep(delays.afterDetailsMs);
        return waitForSnapshot(
          device,
          (snapshot) => hasSnapshotText(snapshot, /^聊天详情$/),
          delays,
          '微信未打开聊天详情',
          sleep,
        );
      },
      '聊天详情已显示',
    );

    const profileSnapshot = await runStage(
      'contact_profile_opened',
      '打开第一个联系人资料',
      async () => {
        const firstContact = findLayoutNode(
          detailsSnapshot,
          (node) =>
            isTrue(node.attributes.clickable) &&
            node.attributes.type === 'GridItem' &&
            node.centerY < screen.height * 0.25,
        );
        await tapNodeOrCoordinate(device, firstContact, point(screen, 0.1, 0.159));
        await sleep(delays.afterProfileMs);
        return waitForSnapshot(
          device,
          isWechatContactProfile,
          delays,
          '微信未打开联系人资料页',
          sleep,
        );
      },
      '第一个联系人资料已显示',
    );

    const typeSheetSnapshot = await runStage(
      'call_type_sheet_opened',
      '打开音视频通话类型',
      async () => {
        await tapClickableTextOrCoordinate(
          device,
          profileSnapshot,
          /^音视频通话$/,
          point(screen, 0.5, 0.571),
        );
        await sleep(delays.afterTypeSheetMs);
        return waitForSnapshot(
          device,
          isWechatCallTypeSheet,
          delays,
          '微信未显示语音和视频通话选项',
          sleep,
        );
      },
      '语音通话和视频通话选项已显示',
    );

    if (startCapture) {
      await runStage(
        'capture_started',
        `开始采集微信${typeLabel}`,
        () => startCaptureBeforeAction(startCapture, sleep),
        `${typeLabel}拨号前已预留1秒采集窗口`,
      );
    }

    const callSnapshot = await runStage(
      'call_started',
      `发起${typeLabel}`,
      async () => {
        await tapCallType(device, typeSheetSnapshot, type, screen);
        const snapshot = await waitForCallState({
          device,
          type,
          screen,
          delays,
          sleep,
        });
        callStarted = true;
        callStartedAt = now();
        assertCallType(snapshot, type);
        await assertWechatForeground(device, app);
        return snapshot;
      },
      (snapshot) => describeCallState(snapshot, typeLabel),
    );

    await runStage(
      'call_observed',
      `保持${typeLabel}测试状态`,
      async () => {
        return observeWechatCall({
          device,
          type,
          durationMs: callDurationMs,
          sleep,
        });
      },
      `${callDurationMs}ms`,
    );

    await runStage(
      'call_ended',
      `挂断${typeLabel}`,
      async () => {
        const snapshot = await endWechatCall({
          device,
          screen,
          delays,
          sleep,
        });
        callStarted = false;
        return snapshot;
      },
      '已退出通话页',
    );

    return {
      validationMode: WECHAT_VOIP_VALIDATION_MODE,
      validationChecks,
      effectiveDurationMs: callDurationMs,
      callType: type,
      replayStepIndex,
      replaySource: WECHAT_VOIP_VALIDATION_MODE,
      correctedSteps: buildWechatVoipCorrectedSteps(screen, type),
      correctionChanges: [
        '忽略缺失或空的原始通话录制轨迹',
        '从微信首页进入聊天列表中的第一个会话和联系人资料',
        `明确选择${typeLabel}并验证实际拨号类型`,
        '按设置的通话时长保持并检查通话状态，最后正常挂断',
      ],
      correctionConfidence: 0.99,
      callSnapshot,
    };
  } catch (error) {
    if (callStarted) {
      await endWechatCall({ device, screen, delays, sleep }).catch(() => {});
    }
    error.validationMode = WECHAT_VOIP_VALIDATION_MODE;
    error.validationChecks = validationChecks;
    error.replayStepIndex = replayStepIndex;
    error.effectiveDurationMs =
      callStartedAt == null ? null : Math.max(0, now() - callStartedAt);
    throw error;
  }
}

async function observeWechatCall({ device, type, durationMs, sleep }) {
  let remainingMs = Math.max(0, Number(durationMs) || 0);
  let snapshot = null;

  do {
    if (remainingMs > 0) {
      const chunkMs = Math.min(CALL_STATUS_CHECK_INTERVAL_MS, remainingMs);
      await sleep(chunkMs);
      remainingMs -= chunkMs;
    }
    snapshot = await device.getUiTextSnapshot();
    if (isWechatCallState(snapshot)) {
      assertCallType(snapshot, type);
      continue;
    }

    // Harmony may temporarily expose only the video surface after the
    // controls auto-hide. That is still an active call, so keep observing
    // and let the cleanup path reveal the controls before hanging up.
    if (isWechatCallSurface(snapshot)) continue;

    throw new Error('微信通话状态已提前结束');
  } while (remainingMs > 0);

  return snapshot;
}

async function waitForCallState({ device, type, screen, delays, sleep }) {
  const deadline = Date.now() + delays.callStartTimeoutMs;
  let permissionAttempts = 0;
  let choiceRetries = 0;
  let lastError = null;

  while (Date.now() <= deadline) {
    let snapshot = null;
    try {
      snapshot = await device.getUiTextSnapshot();
      if (isWechatCallState(snapshot)) {
        return snapshot;
      }
    } catch (error) {
      lastError = error;
    }

    const focus = await device.getCurrentFocus?.().catch(() => null);
    if (isPermissionPrompt(snapshot, focus) && permissionAttempts < 3) {
      await allowCallPermission(device, snapshot, screen);
      permissionAttempts += 1;
      await sleep(delays.permissionSettleMs);
      continue;
    }

    if (snapshot && isWechatCallTypeSheet(snapshot) && choiceRetries < 2) {
      await tapCallType(device, snapshot, type, screen);
      choiceRetries += 1;
    }
    await sleep(delays.pollIntervalMs);
  }

  throw new Error(
    lastError
      ? `微信${type === 'video' ? '视频' : '语音'}通话未进入拨号页: ${lastError.message}`
      : `微信${type === 'video' ? '视频' : '语音'}通话未进入拨号页`,
  );
}

async function endWechatCall({ device, screen, delays, sleep }) {
  const deadline = Date.now() + delays.hangupTimeoutMs;
  let lastSnapshot = null;

  while (Date.now() <= deadline) {
    lastSnapshot = await device.getUiTextSnapshot().catch(() => null);
    if (
      lastSnapshot &&
      !isWechatCallState(lastSnapshot) &&
      !isWechatCallSurface(lastSnapshot)
    ) {
      return lastSnapshot;
    }

    let controls = lastSnapshot;
    let target =
      findClickableTextNode(controls, /^挂断$/) ||
      findClickableTextNode(controls, /^取消$/);
    if (!target) {
      await device.tap(point(screen, 0.5, 0.494));
      await sleep(delays.controlsSettleMs);
      controls = await device.getUiTextSnapshot().catch(() => lastSnapshot);
      target =
        findClickableTextNode(controls, /^挂断$/) ||
        findClickableTextNode(controls, /^取消$/);
    }
    await tapNodeOrCoordinate(device, target, point(screen, 0.503, 0.863));
    await sleep(delays.hangupSettleMs);

    lastSnapshot = await device.getUiTextSnapshot().catch(() => null);
    if (
      lastSnapshot &&
      !isWechatCallState(lastSnapshot) &&
      !isWechatCallSurface(lastSnapshot)
    ) {
      return lastSnapshot;
    }
  }

  throw new Error('微信通话未能通过页面挂断控件结束');
}

async function tapCallType(device, snapshot, type, screen) {
  const matcher = type === 'video' ? /^视频通话$/ : /^语音通话$/;
  const labelNode = findLayoutNode(snapshot, (node) =>
    node.textValues.some((value) => matcher.test(value)),
  );
  const fallback = point(screen, 0.614, type === 'video' ? 0.755 : 0.831);
  await device.tap({
    x: fallback.x,
    y: labelNode?.centerY ?? fallback.y,
  });
}

async function allowCallPermission(device, snapshot, screen) {
  const target = findClickableTextNode(
    snapshot,
    /^(?:仅在使用期间允许|使用应用时允许|允许|始终允许)$/,
  );
  await tapNodeOrCoordinate(device, target, point(screen, 0.614, 0.755));
}

function isPermissionPrompt(snapshot, focus) {
  const values = snapshot?.values || [];
  const text = values.join('\n');
  return (
    /security\.privacycenter/i.test(String(focus?.bundleName || focus?.packageName || '')) ||
    (/(?:麦克风|相机|摄像头|权限)/.test(text) && /允许/.test(text))
  );
}

function assertCallType(snapshot, type) {
  if (!isWechatCallState(snapshot)) throw new Error('微信通话状态已提前结束');
  const text = (snapshot?.values || []).join('\n');
  const hasCameraControls = /摄像头|翻转|模糊背景|切换画面/.test(text);
  if (type === 'video' && !hasCameraControls) {
    throw new Error('已进入微信通话页，但当前不是视频通话');
  }
  if (type === 'audio' && hasCameraControls) {
    throw new Error('已进入微信通话页，但当前不是语音通话');
  }
}

function isWechatCallSurface(snapshot) {
  const text = (snapshot?.values || []).join('\n');
  return /切换画面|屏幕锁定|添加新成员|摄像头|翻转|模糊背景|麦克风|扬声器/.test(text);
}

function describeCallState(snapshot, typeLabel) {
  const text = (snapshot?.values || []).join(' ');
  if (/通话时长|已接通/.test(text)) return `${typeLabel}已接通`;
  return `${typeLabel}拨号页已显示`;
}

async function assertWechatForeground(device, app) {
  if (typeof device.getCurrentFocus !== 'function') return;
  const focus = await device.getCurrentFocus();
  const actual = focus?.bundleName || focus?.packageName || '';
  const expected = [app.packageName, app.harmonyBundleName].filter(Boolean);
  if (actual && !expected.includes(actual)) {
    throw new Error(`微信不在前台，当前前台应用为 ${actual}`);
  }
}

async function waitForSnapshot(device, predicate, delays, message, sleep) {
  const deadline = Date.now() + 10_000;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const snapshot = await device.getUiTextSnapshot();
      if (predicate(snapshot)) return snapshot;
    } catch (error) {
      lastError = error;
    }
    await sleep(delays.pollIntervalMs);
  }
  throw new Error(lastError ? `${message}: ${lastError.message}` : message);
}

function isWechatConversationList(snapshot) {
  return (
    hasLayoutNode(snapshot, (node) => node.attributes.id === 'WechatMainNavigation') &&
    hasSnapshotText(snapshot, /^微信$/) &&
    hasSnapshotText(snapshot, /^通讯录$/) &&
    !hasLayoutNode(snapshot, (node) => node.attributes.type === 'RichEditor')
  );
}

function isWechatChat(snapshot) {
  return (
    hasLayoutNode(snapshot, (node) => node.attributes.id === 'chat_list') &&
    hasLayoutNode(snapshot, (node) => node.attributes.type === 'RichEditor')
  );
}

function isWechatContactProfile(snapshot) {
  return (
    hasSnapshotText(snapshot, /^发消息$/) &&
    hasSnapshotText(snapshot, /^音视频通话$/) &&
    !hasSnapshotText(snapshot, /^视频通话$/)
  );
}

function isWechatCallTypeSheet(snapshot) {
  return (
    hasSnapshotText(snapshot, /^视频通话$/) &&
    hasSnapshotText(snapshot, /^语音通话$/) &&
    hasSnapshotText(snapshot, /^取消$/)
  );
}

function isWechatCallState(snapshot) {
  const text = (snapshot?.values || []).join('\n');
  return (
    /等待对方|通话时长|已接通/.test(text) &&
    /麦克风|扬声器|摄像头|挂断|取消/.test(text)
  );
}

async function tapClickableTextOrCoordinate(device, snapshot, matcher, fallback) {
  await tapNodeOrCoordinate(device, findClickableTextNode(snapshot, matcher), fallback);
}

function findClickableTextNode(snapshot, matcher) {
  let result = null;
  let boundedFallback = null;
  const rootBounds = normalizeLayoutNode(snapshot?.layout).bounds;
  const visit = (raw, ancestors = []) => {
    if (result || !raw || typeof raw !== 'object') return;
    const node = normalizeLayoutNode(raw);
    const matches = node.textValues.some((value) => matcher.test(value));
    if (matches) {
      if (node.bounds && isSemanticButton(node)) {
        result = node;
        return;
      }
      const clickable = [node, ...ancestors.slice().reverse()].find(
        (candidate) =>
          isTrue(candidate.attributes.clickable) &&
          candidate.bounds &&
          !coversMostOfScreen(candidate.bounds, rootBounds),
      );
      if (clickable) {
        result = clickable;
        return;
      }
      if (node.bounds && !boundedFallback) boundedFallback = node;
    }
    for (const child of Array.isArray(raw.children) ? raw.children : []) {
      visit(child, [...ancestors, node]);
    }
  };
  visit(snapshot?.layout);
  return result || boundedFallback;
}

function isSemanticButton(node) {
  const type = String(
    node?.attributes?.type ??
      node?.attributes?.class ??
      node?.attributes?.role ??
      '',
  );
  return /(?:^|\.)(?:Button|ImageButton)$/i.test(type);
}

function coversMostOfScreen(bounds, rootBounds) {
  if (!bounds || !rootBounds) return false;
  const width = Math.max(0, bounds.x2 - bounds.x1);
  const height = Math.max(0, bounds.y2 - bounds.y1);
  const rootWidth = Math.max(1, rootBounds.x2 - rootBounds.x1);
  const rootHeight = Math.max(1, rootBounds.y2 - rootBounds.y1);
  return width / rootWidth >= 0.9 && height / rootHeight >= 0.9;
}

function findLayoutNode(snapshot, predicate) {
  return flattenLayout(snapshot?.layout).find(predicate) || null;
}

function hasLayoutNode(snapshot, predicate) {
  return Boolean(findLayoutNode(snapshot, predicate));
}

function hasSnapshotText(snapshot, matcher) {
  return (snapshot?.values || []).some((value) => matcher.test(String(value)));
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
  const bounds = parseBounds(attributes.bounds ?? attributes.rect ?? attributes.frame);
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

function point(screen, normalizedX, normalizedY) {
  return {
    x: Math.round(screen.width * normalizedX),
    y: Math.round(screen.height * normalizedY),
  };
}

function pointStep(screen, normalizedX, normalizedY, delayMs, target = null) {
  const resolved = point(screen, normalizedX, normalizedY);
  return {
    type: 'tap',
    ...resolved,
    normalizedX,
    normalizedY,
    referenceScreen: screen,
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
    stablePolls: 1,
    optional: false,
    delayMs: 0,
  };
}

function normalizeCallType(value) {
  return value === 'video' ? 'video' : 'audio';
}

function resolveCallDurationMs(explicitMs, parameter, fallbackMs) {
  const milliseconds = Number(explicitMs);
  if (Number.isFinite(milliseconds) && milliseconds > 0) {
    return Math.min(MAX_CALL_DURATION_MS, Math.max(1, Math.round(milliseconds)));
  }
  const amount = Number(
    parameter && typeof parameter === 'object' && 'amount' in parameter
      ? parameter.amount
      : parameter,
  );
  const unit =
    parameter && typeof parameter === 'object' && parameter.unit
      ? String(parameter.unit)
      : '秒';
  const factors = {
    毫秒: 1,
    秒: 1000,
    分钟: 60 * 1000,
    小时: 60 * 60 * 1000,
  };
  if (Number.isFinite(amount) && amount > 0) {
    return Math.min(
      MAX_CALL_DURATION_MS,
      Math.max(1, Math.round(amount * (factors[unit] || 1000))),
    );
  }
  return Math.min(
    MAX_CALL_DURATION_MS,
    Math.max(0, Math.round(Number(fallbackMs) || 0)),
  );
}

function normalizeScreen(screen) {
  return {
    width: Number(screen?.width) || DEFAULT_SCREEN.width,
    height: Number(screen?.height) || DEFAULT_SCREEN.height,
  };
}

function isTrue(value) {
  return value === true || String(value) === 'true';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
