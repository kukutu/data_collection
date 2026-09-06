import { config } from '../config.js';

export const WECHAT_MEDIA_WORKFLOW_ID = 'transfer:wechat:send-media';
export const WECHAT_MEDIA_VALIDATION_MODE = 'wechat_media_send_v1';

const DEFAULT_SCREEN = {
  width: config.screen.defaultWidth,
  height: config.screen.defaultHeight,
};

const DEFAULT_TIMINGS = Object.freeze({
  afterLaunchMs: 3500,
  afterConversationMs: 1800,
  afterMenuMs: 900,
  afterPickerMs: 1800,
  afterSelectionMs: 500,
  pollIntervalMs: 500,
  sendTimeoutMs: 20_000,
});

const DEFAULT_EXECUTION = Object.freeze({
  sendMode: 'count',
  sendCount: 1,
  durationMs: 5 * 60 * 1000,
  intervalMs: 8 * 1000,
});

export function buildWechatMediaCorrectedSteps(screen = DEFAULT_SCREEN) {
  const size = normalizeScreen(screen);
  return [
    {
      type: 'tap',
      x: Math.round(size.width * 0.5),
      y: Math.round(size.height * 0.217),
      delayMs: DEFAULT_TIMINGS.afterLaunchMs,
    },
    {
      type: 'tap',
      x: Math.round(size.width * 0.933),
      y: Math.round(size.height * 0.929),
      delayMs: DEFAULT_TIMINGS.afterConversationMs,
    },
    {
      type: 'tap',
      x: Math.round(size.width * 0.146),
      y: Math.round(size.height * 0.739),
      delayMs: DEFAULT_TIMINGS.afterMenuMs,
    },
    {
      type: 'tap',
      x: Math.round(size.width * 0.207),
      y: Math.round(size.height * 0.323),
      delayMs: DEFAULT_TIMINGS.afterPickerMs,
    },
    {
      type: 'tap',
      x: Math.round(size.width * 0.858),
      y: Math.round(size.height * 0.929),
      delayMs: DEFAULT_TIMINGS.afterSelectionMs,
    },
  ];
}

export async function executeWechatMediaTransfer({
  device,
  app,
  parameters = {},
  sendMode = null,
  sendCount = null,
  durationMs = null,
  intervalMs = null,
  startCapture = null,
  onStep = () => {},
  sleep = wait,
  now = () => Date.now(),
  timings = {},
} = {}) {
  if (!device) throw new Error('微信媒体发送缺少设备适配器');
  if (app?.id !== 'wechat' || !app.packageName) {
    throw new Error('微信媒体发送 skill 只能用于微信 App');
  }

  const delays = { ...DEFAULT_TIMINGS, ...timings };
  const execution = normalizeExecution({
    parameters,
    sendMode,
    sendCount,
    durationMs,
    intervalMs,
  });
  const validationChecks = [];
  let totalSteps =
    execution.sendMode === 'count'
      ? 3 + execution.sendCount * 4 + (startCapture ? 1 : 0)
      : 7 + (startCapture ? 1 : 0);
  let replayStepIndex = 0;
  let screen = DEFAULT_SCREEN;
  let sentCount = 0;
  let sentSnapshot = null;

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
          throw new Error('微信媒体发送当前只支持鸿蒙 HDC 设备');
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
          (current) => isWechatConversationList(current),
          {
            timeoutMs: 10_000,
            intervalMs: delays.pollIntervalMs,
            sleep,
            message: '微信未显示聊天列表',
          },
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
        await tapNodeOrCoordinate(device, firstTitle, {
          x: Math.round(screen.width * 0.5),
          y: Math.round(screen.height * 0.217),
        });
        await sleep(delays.afterConversationMs);
        const snapshot = await waitForSnapshot(device, isWechatChat, {
          timeoutMs: 10_000,
          intervalMs: delays.pollIntervalMs,
          sleep,
          message: '微信首个会话未显示消息输入框',
        });
        await assertWechatForeground(device, app);
        return snapshot;
      },
      '聊天列表中的第一个会话',
    );
    let currentChatSnapshot = chatSnapshot;
    const loopStartedAt = now();
    let scheduledElapsedMs = 0;

    while (true) {
      const iteration = sentCount + 1;
      if (execution.sendMode === 'duration' && iteration > 1) {
        totalSteps += 4;
      }
      const previousMediaCount = countOutgoingMediaNodes(currentChatSnapshot, screen);
      const previousMediaSignature = outgoingMediaSignature(
        currentChatSnapshot,
        screen,
      );
      const suffix = `_${iteration}`;

      const menuSnapshot = await runStage(
        `attachment_menu_opened${suffix}`,
        `第 ${iteration} 次打开聊天附件菜单`,
        async () => {
          const plusButton = findLayoutNode(
            currentChatSnapshot,
            (node) =>
              node.attributes.type === 'Image' &&
              isTrue(node.attributes.clickable) &&
              node.centerX > screen.width * 0.85 &&
              node.centerY > screen.height * 0.82,
          );
          await tapNodeOrCoordinate(device, plusButton, {
            x: Math.round(screen.width * 0.933),
            y: Math.round(screen.height * 0.929),
          });
          await sleep(delays.afterMenuMs);
          return waitForSnapshot(
            device,
            (current) =>
              hasLayoutNode(current, (node) => node.attributes.id === 'ChatActionMenu') &&
              hasSnapshotText(current, /^照片$/),
            {
              timeoutMs: 8000,
              intervalMs: delays.pollIntervalMs,
              sleep,
              message: '微信聊天附件菜单未显示“照片”入口',
            },
          );
        },
        '照片入口已显示',
      );

      const pickerSnapshot = await runStage(
        `media_picker_opened${suffix}`,
        `第 ${iteration} 次打开图片和视频选择器`,
        async () => {
          const photoEntry = findLayoutNode(menuSnapshot, (node) =>
            node.textValues.some((value) => value === '照片'),
          );
          await tapNodeOrCoordinate(device, photoEntry, {
            x: Math.round(screen.width * 0.146),
            y: Math.round(screen.height * 0.739),
          });
          await sleep(delays.afterPickerMs);
          return waitForSnapshot(
            device,
            (current) =>
              hasLayoutNode(current, (node) => node.attributes.id === 'image_picker') &&
              hasLayoutNode(current, (node) => node.attributes.id === 'Selector_0'),
            {
              timeoutMs: 10_000,
              intervalMs: delays.pollIntervalMs,
              sleep,
              message: '微信媒体选择器未显示第一项媒体',
            },
          );
        },
        '第一项媒体可选择',
      );

      if (startCapture && iteration === 1) {
        await runStage(
          'capture_started',
          '开始采集微信媒体传输',
          async () => startCapture(),
          '媒体选择器已打开，第一次发送前启动采集',
        );
      }

      const selectedSnapshot = await runStage(
        `first_media_selected${suffix}`,
        `第 ${iteration} 次选择第一项图片或视频`,
        async () => {
          const selector = findLayoutNode(
            pickerSnapshot,
            (node) => node.attributes.id === 'Selector_0',
          );
          await tapNodeOrCoordinate(device, selector, {
            x: Math.round(screen.width * 0.207),
            y: Math.round(screen.height * 0.323),
          });
          await sleep(delays.afterSelectionMs);
          return waitForSnapshot(
            device,
            (current) => hasSnapshotText(current, /^发送[（(]1[）)]$/),
            {
              timeoutMs: 8000,
              intervalMs: delays.pollIntervalMs,
              sleep,
              message: '第一项媒体未进入选中状态',
            },
          );
        },
        inferFirstMediaKind(pickerSnapshot),
      );

      sentSnapshot = await runStage(
        `media_sent${suffix}`,
        `第 ${iteration} 次发送第一项图片或视频`,
        async () => {
          const sendButton = findLayoutNode(selectedSnapshot, (node) =>
            node.textValues.some((value) => /^发送[（(]1[）)]$/.test(value)),
          );
          await tapNodeOrCoordinate(device, sendButton, {
            x: Math.round(screen.width * 0.858),
            y: Math.round(screen.height * 0.929),
          });
          const snapshot = await waitForSnapshot(
            device,
            (current) =>
              isWechatChat(current) &&
              !hasLayoutNode(current, (node) => node.attributes.id === 'image_picker') &&
              (countOutgoingMediaNodes(current, screen) > previousMediaCount ||
                outgoingMediaSignature(current, screen) !== previousMediaSignature),
            {
              timeoutMs: delays.sendTimeoutMs,
              intervalMs: delays.pollIntervalMs,
              sleep,
              message: '媒体选择器已操作，但聊天中未检测到新增媒体消息',
            },
          );
          await assertWechatForeground(device, app);
          return snapshot;
        },
        (current) =>
          `聊天媒体节点 ${previousMediaCount} -> ${countOutgoingMediaNodes(current, screen)}`,
      );

      sentCount += 1;
      currentChatSnapshot = sentSnapshot;

      if (execution.sendMode === 'count') {
        if (sentCount >= execution.sendCount) break;
        await sleep(execution.intervalMs);
        continue;
      }

      const elapsedMs = Math.max(now() - loopStartedAt, scheduledElapsedMs);
      const remainingMs = execution.durationMs - elapsedMs;
      if (remainingMs <= 0) break;
      const waitMs = Math.min(execution.intervalMs, remainingMs);
      await sleep(waitMs);
      scheduledElapsedMs += waitMs;
      if (Math.max(now() - loopStartedAt, scheduledElapsedMs) >= execution.durationMs) {
        break;
      }
    }

    const effectiveDurationMs =
      execution.sendMode === 'duration'
        ? Math.max(now() - loopStartedAt, scheduledElapsedMs)
        : null;

    return {
      validationMode: WECHAT_MEDIA_VALIDATION_MODE,
      validationChecks,
      effectiveDurationMs,
      sentCount,
      sendMode: execution.sendMode,
      replayStepIndex,
      replaySource: WECHAT_MEDIA_VALIDATION_MODE,
      correctedSteps: buildWechatMediaCorrectedSteps(screen),
      correctionChanges: [
        '忽略缺失且坐标异常的原始录制轨迹',
        '从微信首页进入聊天列表中的第一个会话',
        '通过附件菜单选择媒体选择器中的第一项',
        '按次数或持续时间循环发送，并逐次验证聊天页新增媒体消息',
      ],
      correctionConfidence: 0.98,
      sentSnapshot,
    };
  } catch (error) {
    error.validationMode = WECHAT_MEDIA_VALIDATION_MODE;
    error.validationChecks = validationChecks;
    error.replayStepIndex = replayStepIndex;
    error.sentCount = sentCount;
    throw error;
  }
}

function normalizeExecution({
  parameters,
  sendMode,
  sendCount,
  durationMs,
  intervalMs,
}) {
  const mode =
    (sendMode ?? parameters.sendMode) === 'duration' ? 'duration' : 'count';
  return {
    sendMode: mode,
    sendCount: positiveInteger(
      sendCount ?? parameters.count,
      DEFAULT_EXECUTION.sendCount,
    ),
    durationMs: positiveDurationMs(
      durationMs,
      parameters.duration,
      DEFAULT_EXECUTION.durationMs,
    ),
    intervalMs: positiveDurationMs(
      intervalMs,
      parameters.interval,
      DEFAULT_EXECUTION.intervalMs,
    ),
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.round(number))
    : fallback;
}

function positiveDurationMs(explicitMs, parameter, fallbackMs) {
  const milliseconds = Number(explicitMs);
  if (Number.isFinite(milliseconds) && milliseconds > 0) {
    return Math.max(1, Math.round(milliseconds));
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
  if (!Number.isFinite(amount) || amount <= 0) return fallbackMs;
  return Math.max(1, Math.round(amount * (factors[unit] || 1000)));
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

async function waitForSnapshot(
  device,
  predicate,
  {
    timeoutMs,
    intervalMs,
    sleep,
    message,
  },
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const snapshot = await device.getUiTextSnapshot();
      if (predicate(snapshot)) return snapshot;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
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

function inferFirstMediaKind(snapshot) {
  const firstItem = flattenLayout(snapshot?.layout).find(
    (node) =>
      node.attributes.id === 'ImageGridItem_Column_0' ||
      node.attributes.id === 'ThirdSelectAlbumGridBase_GridItem0',
  );
  const source = firstItem
    ? JSON.stringify(firstItem.raw)
    : JSON.stringify(snapshot?.layout || {});
  return /\.(?:mp4|mov|m4v)(?:[?"]|$)/i.test(source) ? '第一项视频' : '第一项图片';
}

function countOutgoingMediaNodes(snapshot, screen) {
  const size = normalizeScreen(screen);
  return findOutgoingMediaNodes(snapshot, size).filter(
    (node) => node.bounds.y2 <= size.height * 0.9,
  ).length;
}

function outgoingMediaSignature(snapshot, screen) {
  const size = normalizeScreen(screen);
  return JSON.stringify(
    findOutgoingMediaNodes(snapshot, size).map((node) => ({
      type: node.attributes.type,
      id: node.attributes.id || '',
      bounds: node.bounds,
    })),
  );
}

function findOutgoingMediaNodes(snapshot, size) {
  return flattenLayout(snapshot?.layout).filter((node) => {
    const { attributes, bounds } = node;
    if (!isTrue(attributes.clickable)) return false;
    if (String(attributes.text || '').trim()) return false;
    if (bounds.x1 < size.width * 0.45) return false;
    const width = bounds.x2 - bounds.x1;
    const height = bounds.y2 - bounds.y1;
    if (width < size.width * 0.12 || height < size.height * 0.07) return false;
    return ['RelativeContainer', 'Image', 'Stack'].includes(attributes.type);
  });
}

async function tapNodeOrCoordinate(device, node, fallback) {
  await device.tap({
    x: node?.centerX ?? fallback.x,
    y: node?.centerY ?? fallback.y,
  });
}

function hasSnapshotText(snapshot, matcher) {
  return (snapshot?.values || []).some((value) => matcher.test(String(value)));
}

function hasLayoutNode(snapshot, predicate) {
  return Boolean(findLayoutNode(snapshot, predicate));
}

function findLayoutNode(snapshot, predicate) {
  return flattenLayout(snapshot?.layout).find(predicate) || null;
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
    const bounds = parseBounds(attributes.bounds ?? attributes.rect ?? attributes.frame);
    if (bounds) {
      nodes.push({
        raw,
        attributes,
        bounds,
        centerX: Math.round((bounds.x1 + bounds.x2) / 2),
        centerY: Math.round((bounds.y1 + bounds.y2) / 2),
        textValues: [
          attributes.text,
          attributes.originalText,
          attributes.description,
          attributes.contentDescription,
          attributes.hint,
          attributes.label,
        ]
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      });
    }
    for (const child of Array.isArray(raw.children) ? raw.children : []) {
      visit(child);
    }
  };
  visit(layout);
  return nodes;
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
  if (value && typeof value === 'object') {
    const x1 = Number(value.x1 ?? value.left ?? value.x);
    const y1 = Number(value.y1 ?? value.top ?? value.y);
    const x2 = Number(value.x2 ?? value.right ?? x1 + Number(value.width));
    const y2 = Number(value.y2 ?? value.bottom ?? y1 + Number(value.height));
    if ([x1, y1, x2, y2].every(Number.isFinite)) return { x1, y1, x2, y2 };
  }
  return null;
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
