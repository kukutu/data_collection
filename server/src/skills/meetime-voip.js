import { config } from '../config.js';
import { startCaptureBeforeAction } from './capture-timing.js';

export const MEETIME_AUDIO_CALL_WORKFLOW_ID = 'voip:meetime:audio-call';
export const MEETIME_VOIP_VALIDATION_MODE = 'meetime_voip_call_v1';

const MAX_CALL_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SCREEN = {
  width: config.screen.defaultWidth,
  height: config.screen.defaultHeight,
};
const DEFAULT_TIMINGS = Object.freeze({
  afterLaunchMs: 1800,
  afterDigitMs: 100,
  callStartTimeoutMs: 15000,
  pollIntervalMs: 500,
  connectedObservationMs: 3000,
  hangupSettleMs: 900,
  hangupTimeoutMs: 10000,
});

export function normalizeMeetimePhoneNumber(value) {
  const source = String(value || '').trim();
  const digits = source.replace(/[^\d+]/g, '');
  const normalized = digits.startsWith('+')
    ? `+${digits.slice(1).replace(/\D/g, '')}`
    : digits.replace(/\D/g, '');
  return normalized;
}

export function isMeetimeWorkflowId(workflowId) {
  return workflowId === MEETIME_AUDIO_CALL_WORKFLOW_ID;
}

export function inspectMeetimeCall(snapshot) {
  const all = flattenSnapshot(snapshot);
  const active = all.some((node) => node.id === 'callui_normalCallUI_Stack');
  const values = all.flatMap((node) => node.textValues);
  const timer = values.map((value) => value.match(/\b\d{2,}:\d{2}(?::\d{2})?\b/)?.[0]).find(Boolean) || '';
  const dialing = values.some((value) => /正在拨号|对方已振铃|正在连接/.test(value));
  const video = all.some((node) => node.id === 'videoMute') ||
    (all.some((node) => node.id === 'hangUp') && all.some((node) => node.id === 'speaker'));
  return { active, connected: active && Boolean(timer) && !dialing, timer, video };
}

export async function executeMeetimeVoipCall({
  device,
  app,
  phoneNumber,
  callType = 'audio',
  video = false,
  durationMs = 30000,
  startCapture = null,
  onStep = () => {},
  sleep = wait,
  now = () => Date.now(),
  timings = {},
} = {}) {
  if (!device) throw new Error('畅连通话缺少设备适配器');
  if (app?.id !== 'meetime' || !app.packageName) {
    throw new Error('畅连通话 skill 只能用于畅连 App');
  }

  const number = normalizeMeetimePhoneNumber(phoneNumber);
  if (!/^\+?\d{3,20}$/.test(number)) throw new Error('畅连通话电话号码无效');
  const type = callType === 'video' || video ? 'video' : 'audio';
  const delays = { ...DEFAULT_TIMINGS, ...timings };
  const callDurationMs = Math.min(
    MAX_CALL_DURATION_MS,
    Math.max(1000, Number(durationMs) || delays.connectedObservationMs),
  );
  const checks = [];
  let step = 0;
  let callStarted = false;
  let screen = DEFAULT_SCREEN;
  const totalSteps = 8 + (startCapture ? 1 : 0) + (type === 'video' ? 1 : 0);
  const report = (label) => onStep(++step, label, totalSteps);
  const snapshot = () => device.getUiTextSnapshot({ attempts: 2, timeoutMs: 8000 });
  const stage = async (id, label, action, detail = '') => {
    report(label);
    try {
      const result = await action();
      checks.push({ id, label, status: 'passed', detail: typeof detail === 'function' ? detail(result) : detail });
      return result;
    } catch (error) {
      checks.push({ id, label, status: 'failed', detail: error.message });
      throw error;
    }
  };

  try {
    const status = await stage(
      'device_connected',
      '设备连接',
      async () => {
        const current = await device.getDeviceStatus();
        if (!current?.connected) throw new Error('未检测到已连接设备');
        if (current.platform && current.platform !== 'harmony' && current.provider !== 'hdc') {
          throw new Error('畅连通话当前只支持鸿蒙 HDC 设备');
        }
        screen = normalizeScreen(current.screen || await device.getScreenSize?.().catch(() => null));
        return current;
      },
      (current) => current.serial || current.provider || 'connected',
    );

    const dialer = await stage(
      'dialer_opened',
      '打开畅连拨号盘',
      async () => {
        await device.forceStopPackage(app.packageName);
        await device.launchPackage(app.packageName);
        await sleep(delays.afterLaunchMs);
        const current = await waitForSnapshot(device, isDialer, delays, sleep);
        return current;
      },
      status.serial || app.harmonyBundleName || app.packageName,
    );

    await stage(
      'number_entered',
      `输入电话号码 ${number}`,
      async () => enterPhoneNumber(device, dialer, number, screen, sleep, delays),
      number,
    );

    if (startCapture) {
      await stage(
        'capture_started',
        '开始采集畅连通话',
        () => startCaptureBeforeAction(startCapture, sleep),
        '拨号前已预留1秒采集窗口',
      );
    }

    await stage(
      'call_started',
      '发起畅连通话',
      async () => {
        const current = await snapshot();
        const dialButton = findVisibleNode(current, (node) => node.id === 'floating_button_dial' && node.centerY > screen.height * 0.65);
        if (!dialButton) throw new Error('畅连拨号盘未找到拨号按钮');
        await tapNode(device, dialButton);
        const call = await waitForSnapshot(device, (value) => inspectMeetimeCall(value).active, delays, sleep);
        callStarted = true;
        return call;
      },
      '畅连系统通话页已显示',
    );

    await stage(
      'call_connected',
      '等待畅连通话接通',
      async () => waitForConnected(device, screen, delays, sleep),
      '已出现通话计时',
    );

    if (type === 'video') {
      await stage(
        'video_enabled',
        '切换畅连视频通话',
        async () => enableVideo(device, screen, delays, sleep),
        '视频通话控件已显示',
      );
    }

    await stage(
      'duration_observed',
      `保持畅连${type === 'video' ? '视频' : '音频'}通话`,
      async () => {
        const deadline = now() + callDurationMs;
        while (now() < deadline) {
          await sleep(Math.min(5000, Math.max(1, deadline - now())));
          const current = await snapshot();
          if (!inspectMeetimeCall(current).connected) throw new Error('畅连通话提前结束');
        }
      },
      `${callDurationMs}ms`,
    );

    await stage(
      'normal_hangup',
      '正常挂断畅连通话',
      async () => {
        await endCall(device, screen, delays, sleep);
        callStarted = false;
      },
      '已退出系统通话页',
    );

    return {
      validationMode: MEETIME_VOIP_VALIDATION_MODE,
      validationChecks: checks,
      effectiveDurationMs: callDurationMs,
      callType: type,
      phoneNumber: number,
      replaySource: MEETIME_VOIP_VALIDATION_MODE,
    };
  } catch (error) {
    if (callStarted) await endCall(device, screen, delays, sleep).catch(() => {});
    error.validationMode = MEETIME_VOIP_VALIDATION_MODE;
    error.validationChecks = checks;
    throw error;
  }
}

async function enterPhoneNumber(device, initialSnapshot, number, screen, sleep, delays) {
  let current = initialSnapshot;
  const input = findVisibleNode(current, (node) => node.id === 'DialOperatePanel_telNumberInput');
  const existing = digitsFromNode(input);
  if (existing) {
    for (let i = 0; i < existing.length + 2; i += 1) {
      current = await snapshotDevice(device);
      const deleteButton = findVisibleNode(current, (node) => node.id === 'dialer_panel_delete_button');
      if (!deleteButton) break;
      await tapNode(device, deleteButton);
      await sleep(delays.afterDigitMs);
    }
  }

  for (const digit of number.replace(/\D/g, '')) {
    current = await snapshotDevice(device);
    const button = findVisibleNode(current, (node) => node.id === `Dialer_DialButton${digit}`);
    if (!button) throw new Error(`畅连拨号盘未找到数字 ${digit}`);
    await tapNode(device, button);
    await sleep(delays.afterDigitMs);
  }

  current = await snapshotDevice(device);
  const entered = findVisibleNode(current, (node) => node.id === 'DialOperatePanel_telNumberInput');
  const actual = digitsFromNode(entered);
  if (!actual.endsWith(number.replace(/\D/g, ''))) {
    throw new Error(`畅连号码输入校验失败：${actual || '空'}`);
  }
  return current;
}

async function waitForConnected(device, screen, delays, sleep) {
  const deadline = Date.now() + delays.callStartTimeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    last = await snapshotDevice(device);
    if (hasAllowPrompt(last)) {
      const allow = findVisibleNode(last, (node) => node.textValues.some((value) => /^允许$/.test(value)));
      if (allow) await tapNode(device, allow);
      await sleep(700);
      continue;
    }
    if (inspectMeetimeCall(last).connected) return last;
    await sleep(delays.pollIntervalMs);
  }
  throw new Error(`畅连通话未接通${last ? '' : '或页面不可见'}`);
}

async function enableVideo(device, screen, delays, sleep) {
  let current = await snapshotDevice(device);
  const deadline = Date.now() + delays.callStartTimeoutMs;
  while (Date.now() <= deadline) {
    if (hasAllowPrompt(current)) {
      const allow = findVisibleNode(current, (node) => node.textValues.some((value) => /^允许$/.test(value)));
      if (allow) await tapNode(device, allow);
      await sleep(700);
      current = await snapshotDevice(device);
      continue;
    }
    const video = findVisibleNode(current, (node) => node.id === 'video' && node.centerX < screen.width * 0.5 && node.centerY > screen.height * 0.65);
    if (video) {
      await tapNode(device, video);
      await sleep(delays.pollIntervalMs);
      current = await snapshotDevice(device);
      if (inspectMeetimeCall(current).video) return current;
    } else {
      await sleep(delays.pollIntervalMs);
      current = await snapshotDevice(device);
    }
  }
  throw new Error('畅连视频通话未确认生效');
}

async function endCall(device, screen, delays, sleep) {
  const deadline = Date.now() + delays.hangupTimeoutMs;
  while (Date.now() <= deadline) {
    const current = await snapshotDevice(device);
    if (!inspectMeetimeCall(current).active) return current;
    const hangup = findVisibleNode(current, (node) => node.id === 'hangUp');
    const audioFallback = findVisibleNode(current, (node) =>
      node.clickable && node.centerY > screen.height * 0.8 &&
      node.centerX > screen.width * 0.4 && node.centerX < screen.width * 0.6,
    );
    const target = hangup || audioFallback;
    if (!target) {
      await device.tap({ x: Math.round(screen.width * 0.5), y: Math.round(screen.height * 0.9) });
    } else {
      await tapNode(device, target);
    }
    await sleep(delays.hangupSettleMs);
    if (!inspectMeetimeCall(await snapshotDevice(device)).active) return current;
  }
  throw new Error('畅连通话未能正常挂断');
}

function isDialer(snapshot) {
  return Boolean(findVisibleNode(snapshot, (node) => node.id === 'Dialer_DialButton1')) &&
    Boolean(findVisibleNode(snapshot, (node) => node.id === 'floating_button_dial'));
}

function hasAllowPrompt(snapshot) {
  const text = flattenSnapshot(snapshot).flatMap((node) => node.textValues).join('\n');
  return /允许.*(麦克风|相机|摄像头)|使用.*(麦克风|相机|摄像头)/.test(text);
}

function flattenSnapshot(snapshot) {
  const out = [];
  const visit = (node, parents = []) => {
    if (!node) return;
    const attrs = node.attributes || node;
    const bounds = parseBounds(attrs.bounds);
    const item = {
      id: String(attrs.id || attrs.resourceId || attrs.key || ''),
      textValues: [attrs.text, attrs.originalText, attrs.description]
        .map((value) => String(value || '').trim())
        .filter(Boolean),
      clickable: attrs.clickable === true || String(attrs.clickable) === 'true',
      bounds,
      centerX: bounds ? (bounds.x1 + bounds.x2) / 2 : 0,
      centerY: bounds ? (bounds.y1 + bounds.y2) / 2 : 0,
      parents,
    };
    out.push(item);
    (node.children || []).forEach((child) => visit(child, [...parents, item]));
  };
  const roots = Array.isArray(snapshot?.layout) ? snapshot.layout : [snapshot?.layout];
  roots.filter(Boolean).forEach((root) => visit(root));
  return out;
}

function findVisibleNode(snapshot, predicate) {
  return flattenSnapshot(snapshot).find((node) =>
    node.bounds && node.bounds.x2 > node.bounds.x1 && node.bounds.y2 > node.bounds.y1 && predicate(node),
  ) || null;
}

async function tapNode(device, node) {
  const target = node.clickable ? node : [...(node.parents || [])].reverse().find((parent) => parent.clickable);
  const selected = target || node;
  if (!selected.bounds) throw new Error('畅连目标控件没有有效坐标');
  await device.tap({
    x: Math.round((selected.bounds.x1 + selected.bounds.x2) / 2),
    y: Math.round((selected.bounds.y1 + selected.bounds.y2) / 2),
  });
}

function digitsFromNode(node) {
  return node?.textValues.join('').replace(/\D/g, '') || '';
}

async function waitForSnapshot(device, predicate, delays, sleep) {
  const deadline = Date.now() + delays.callStartTimeoutMs;
  let current = null;
  while (Date.now() <= deadline) {
    current = await snapshotDevice(device);
    if (predicate(current)) return current;
    await sleep(delays.pollIntervalMs);
  }
  throw new Error('畅连页面未进入预期状态');
}

async function snapshotDevice(device) {
  return device.getUiTextSnapshot({ attempts: 2, timeoutMs: 8000 });
}

function normalizeScreen(screen) {
  const width = Number(screen?.width);
  const height = Number(screen?.height);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width, height }
    : DEFAULT_SCREEN;
}

function parseBounds(value) {
  const match = String(value || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!match) return null;
  return { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
