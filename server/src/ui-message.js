const DEFAULT_ATTEMPTS = 3;
const DEFAULT_READY_CHECKS = 8;
const DEFAULT_CONFIRMATION_CHECKS = 10;
const DEFAULT_POLL_MS = 250;
const DEFAULT_FOCUS_WAIT_MS = 700;

export async function executeUiMessage({
  device,
  message,
  inputResourceId,
  sendResourceId,
  attempts = DEFAULT_ATTEMPTS,
  readyChecks = DEFAULT_READY_CHECKS,
  confirmationChecks = DEFAULT_CONFIRMATION_CHECKS,
  pollMs = DEFAULT_POLL_MS,
  focusWaitMs = DEFAULT_FOCUS_WAIT_MS,
  confirmOnEditorClear = false,
  sleep = wait,
  onRetry = null,
}) {
  const text = String(message || '').trim();
  if (!text) throw new Error('send_ui_message requires message text');
  if (!inputResourceId || !sendResourceId) {
    throw new Error('send_ui_message requires input and send resource ids');
  }
  if (
    typeof device?.getUiTextSnapshot !== 'function' ||
    typeof device?.tap !== 'function' ||
    typeof device?.inputText !== 'function'
  ) {
    throw new Error('Current device adapter cannot execute send_ui_message');
  }

  const maxAttempts = clampInteger(attempts, 1, 5, DEFAULT_ATTEMPTS);
  const maxReadyChecks = clampInteger(readyChecks, 1, 20, DEFAULT_READY_CHECKS);
  const maxConfirmationChecks = clampInteger(
    confirmationChecks,
    1,
    20,
    DEFAULT_CONFIRMATION_CHECKS,
  );
  const checkIntervalMs = clampInteger(pollMs, 50, 2000, DEFAULT_POLL_MS);
  const keyboardWaitMs = clampInteger(
    focusWaitMs,
    100,
    5000,
    DEFAULT_FOCUS_WAIT_MS,
  );

  const initialSnapshot = await device.getUiTextSnapshot();
  const baselineMessageCount = inspectSnapshot(initialSnapshot, {
    inputResourceId,
    sendResourceId,
    message: text,
  }).messageCount;
  let lastState = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let snapshot =
      attempt === 1 ? initialSnapshot : await device.getUiTextSnapshot();
    let state = inspectSnapshot(snapshot, {
      inputResourceId,
      sendResourceId,
      message: text,
    });
    lastState = state;

    if (isConfirmedSent(state, baselineMessageCount)) {
      return buildResult({ attempt, state, baselineMessageCount, autoSubmitted: true });
    }

    if (!state.inputNode) {
      await retryOrThrow({
        attempt,
        maxAttempts,
        reason: `input resource not found: ${inputResourceId}`,
        sleep,
        onRetry,
        pollMs: checkIntervalMs,
      });
      continue;
    }

    await device.tap(nodeCenter(state.inputNode));
    await sleep(keyboardWaitMs);

    snapshot = await device.getUiTextSnapshot();
    state = inspectSnapshot(snapshot, {
      inputResourceId,
      sendResourceId,
      message: text,
    });
    lastState = state;

    if (isConfirmedSent(state, baselineMessageCount)) {
      return buildResult({ attempt, state, baselineMessageCount, autoSubmitted: true });
    }

    if (state.inputText !== text) {
      await device.inputText(text, {
        clearExisting: Boolean(state.inputText),
      });
    }

    let tappedSend = false;
    for (let check = 0; check < maxReadyChecks; check += 1) {
      if (check > 0) await sleep(checkIntervalMs);
      snapshot = await device.getUiTextSnapshot();
      state = inspectSnapshot(snapshot, {
        inputResourceId,
        sendResourceId,
        message: text,
      });
      lastState = state;

      if (isConfirmedSent(state, baselineMessageCount)) {
        return buildResult({
          attempt,
          state,
          baselineMessageCount,
          autoSubmitted: true,
        });
      }

      if (state.inputText === text && state.sendNode) {
        await device.tap(nodeCenter(state.sendNode));
        tappedSend = true;
        break;
      }
    }

    if (!tappedSend) {
      await retryOrThrow({
        attempt,
        maxAttempts,
        reason: describeState('message editor did not become ready', lastState),
        sleep,
        onRetry,
        pollMs: checkIntervalMs,
      });
      continue;
    }

    let repeatedSend = false;
    for (let check = 0; check < maxConfirmationChecks; check += 1) {
      await sleep(checkIntervalMs);
      snapshot = await device.getUiTextSnapshot();
      state = inspectSnapshot(snapshot, {
        inputResourceId,
        sendResourceId,
        message: text,
      });
      lastState = state;

      if (isConfirmedSent(state, baselineMessageCount)) {
        return buildResult({ attempt, state, baselineMessageCount });
      }
      if (confirmOnEditorClear && isEditorClearedAfterSend(state)) {
        return buildResult({
          attempt,
          state,
          baselineMessageCount,
          editorClearConfirmed: true,
        });
      }

      if (
        !repeatedSend &&
        check >= 1 &&
        state.inputText === text &&
        state.sendNode
      ) {
        await device.tap(nodeCenter(state.sendNode));
        repeatedSend = true;
      }
    }

    await retryOrThrow({
      attempt,
      maxAttempts,
      reason: describeState('message send was not confirmed', lastState),
      sleep,
      onRetry,
      pollMs: checkIntervalMs,
    });
  }

  throw new Error(describeState('message send failed', lastState));
}

export function inspectUiMessageSnapshot(
  snapshot,
  { inputResourceId, sendResourceId, message },
) {
  return inspectSnapshot(snapshot, {
    inputResourceId,
    sendResourceId,
    message: String(message || '').trim(),
  });
}

function inspectSnapshot(
  snapshot,
  { inputResourceId, sendResourceId, message },
) {
  const nodes = flattenLayout(snapshot?.layout);
  const inputNode = findLargestNodeById(nodes, inputResourceId);
  const sendNode = findLargestNodeById(nodes, sendResourceId);
  const inputText = nodeText(inputNode);
  const messageCount = nodes.filter(
    (node) =>
      !nodeHasId(node, inputResourceId) &&
      nodeTextValues(node).some((value) => value === message),
  ).length;

  return {
    inputNode,
    sendNode,
    inputText,
    messageCount,
  };
}

function isConfirmedSent(state, baselineMessageCount) {
  return state.messageCount > baselineMessageCount && !state.inputText;
}

function isEditorClearedAfterSend(state) {
  return Boolean(state.inputNode) && !state.inputText && !state.sendNode;
}

function buildResult({
  attempt,
  state,
  baselineMessageCount,
  autoSubmitted = false,
  editorClearConfirmed = false,
}) {
  return {
    sent: true,
    attempt,
    autoSubmitted,
    editorClearConfirmed,
    messageCountDelta: state.messageCount - baselineMessageCount,
  };
}

async function retryOrThrow({
  attempt,
  maxAttempts,
  reason,
  sleep,
  onRetry,
  pollMs,
}) {
  if (attempt >= maxAttempts) throw new Error(reason);
  if (typeof onRetry === 'function') {
    onRetry({ attempt, nextAttempt: attempt + 1, reason });
  }
  await sleep(Math.max(300, pollMs * 2));
}

function describeState(prefix, state) {
  if (!state) return prefix;
  return `${prefix}: input=${JSON.stringify(state.inputText)}, send=${Boolean(
    state.sendNode,
  )}, matchingMessages=${state.messageCount}`;
}

function flattenLayout(layout) {
  const nodes = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    for (const child of Array.isArray(node.children) ? node.children : []) {
      visit(child);
    }
  };
  visit(layout);
  return nodes;
}

function findLargestNodeById(nodes, resourceId) {
  return (
    nodes
      .filter(
        (node) =>
          nodeHasId(node, resourceId) &&
          String(attributesOf(node).visible || 'true').toLowerCase() !== 'false',
      )
      .sort((left, right) => nodeArea(right) - nodeArea(left))[0] || null
  );
}

function nodeHasId(node, resourceId) {
  const expected = String(resourceId || '');
  if (!expected) return false;
  const attributes = attributesOf(node);
  return [
    attributes.id,
    attributes.key,
    attributes.resourceId,
    attributes.accessibilityId,
  ].some((value) => String(value || '') === expected);
}

function nodeText(node) {
  const attributes = attributesOf(node);
  return [attributes.text, attributes.originalText]
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
}

function nodeTextValues(node) {
  const attributes = attributesOf(node);
  return [
    attributes.text,
    attributes.originalText,
    attributes.description,
    attributes.contentDescription,
    attributes['content-desc'],
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function attributesOf(node) {
  if (!node || typeof node !== 'object') return {};
  if (node.attributes && typeof node.attributes === 'object') {
    return node.attributes;
  }
  if (node.attrs && typeof node.attrs === 'object') return node.attrs;
  return node;
}

function nodeCenter(node) {
  const bounds = parseBounds(attributesOf(node).bounds);
  if (!bounds) throw new Error('UI node has no usable bounds');
  return {
    x: Math.round((bounds.x1 + bounds.x2) / 2),
    y: Math.round((bounds.y1 + bounds.y2) / 2),
  };
}

function nodeArea(node) {
  const bounds = parseBounds(attributesOf(node).bounds);
  if (!bounds) return 0;
  return Math.max(0, bounds.x2 - bounds.x1) * Math.max(0, bounds.y2 - bounds.y1);
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

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
