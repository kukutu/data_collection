import {
  annotateStepCoordinates,
  normalizedRegion,
} from './device-profile.js';

const LONG_HOLD_THRESHOLD_MS = 1500;
const MAX_STATE_TEXT_TOKENS = 4;
const ACTION_TYPES = new Set([
  'tap',
  'long_press',
  'swipe',
  'keyevent',
  'input_text',
]);

export function enrichRecordedSteps({
  steps = [],
  contexts = [],
  profile = null,
} = {}) {
  const contextByStep = actionContextsByStep(contexts);
  return steps.map((original, index) => {
    const step = annotateStepCoordinates(original, profile);
    if (!new Set(['tap', 'long_press', 'input_text']).has(step.type)) {
      return step;
    }
    const context = contextByStep.get(index + 1);
    const target = buildActionTarget(step, context, profile);
    return target ? { ...step, target } : step;
  });
}

export function buildSemanticTrajectory({
  steps = [],
  contexts = [],
  parameterSchema = [],
  workflowId = null,
  app = null,
} = {}) {
  if (!steps.length) return [];
  const contextByStep = actionContextsByStep(contexts);
  const startContext = contexts.find(
    (context) => context.phase === 'recording-start',
  );
  const durationParameter = findDurationParameter(parameterSchema, workflowId);
  const longestDelay = Math.max(
    0,
    ...steps.slice(1).map((step) => Number(step.delayMs) || 0),
  );
  const result = [];

  for (const [index, original] of steps.entries()) {
    const step = { ...original };
    const delayMs = Math.max(0, Number(step.delayMs) || 0);
    if (index > 0 && delayMs >= LONG_HOLD_THRESHOLD_MS) {
      const previousContext = contextByStep.get(index);
      const state = buildStateExpectation(previousContext, { app });
      result.push({
        type: 'hold_state',
        durationMs: delayMs,
        ...(durationParameter && delayMs === longestDelay
          ? { durationParameter: durationParameter.id }
          : {}),
        pollMs: Math.min(5000, Math.max(750, Math.round(delayMs / 4))),
        state,
        optional: state.strength < 2,
        sourceStepIndex: index,
        evidenceId: `step-${String(index).padStart(3, '0')}-hold`,
      });
      step.delayMs = 0;
    }

    result.push({
      ...step,
      evidenceId:
        step.evidenceId || `step-${String(index + 1).padStart(3, '0')}`,
    });

    const currentContext = contextByStep.get(index + 1);
    const previousContext =
      index === 0 ? startContext : contextByStep.get(index);
    if (shouldAssertTransition(previousContext, currentContext)) {
      const state = buildStateExpectation(currentContext, { app });
      if (state.strength > 0) {
        result.push({
          type: 'assert_state',
          state,
          timeoutMs: 5000,
          pollMs: 500,
          stablePolls: state.strength >= 3 ? 2 : 1,
          optional: state.strength < 2,
          sourceStepIndex: index + 1,
          recovery: {
            relaunchApp: true,
            retryPreviousAction: true,
          },
          evidenceId: `step-${String(index + 1).padStart(3, '0')}-assert`,
        });
      }
    }
  }
  return result;
}

export function buildStateExpectation(context, { app = null } = {}) {
  const focus = context?.focus || {};
  const packages = uniqueStrings([
    focus.bundleName,
    focus.packageName,
    app?.harmonyBundleName,
    app?.packageName,
  ]).slice(0, 4);
  const activities = uniqueStrings([
    focus.abilityName,
    focus.activity,
    focus.currentFocus,
  ]).slice(0, 3);
  const textAny = stableTextTokens(context).slice(0, MAX_STATE_TEXT_TOKENS);
  const nodeIds = uniqueStrings(
    (context?.nativeLayoutSummary || [])
      .map((node) => node?.id)
      .filter(isStableNodeId),
  ).slice(0, 3);
  const strength =
    (packages.length ? 1 : 0) +
    (activities.length ? 1 : 0) +
    (textAny.length ? 1 : 0) +
    (nodeIds.length ? 1 : 0);
  return {
    packages,
    activities,
    textAny,
    nodeIds,
    strength,
  };
}

export async function executeStateStep(
  device,
  step,
  {
    parameters = {},
    sleep = wait,
    onCheck = () => {},
  } = {},
) {
  if (step.type === 'assert_state') {
    return waitForExpectedState(device, step.state, {
      timeoutMs: step.timeoutMs,
      pollMs: step.pollMs,
      stablePolls: step.stablePolls,
      optional: step.optional,
      sleep,
      onCheck,
    });
  }
  if (step.type !== 'hold_state') {
    throw new Error(`不是状态轨迹步骤: ${step.type}`);
  }

  const durationMs = resolveSemanticDurationMs(step, parameters);
  const pollMs = Math.min(
    Math.max(250, Number(step.pollMs) || 1000),
    Math.max(250, durationMs || 250),
  );
  const startedAt = Date.now();
  let checkCount = 0;
  let lastResult = null;

  while (Date.now() - startedAt < durationMs) {
    if (step.state?.strength > 0) {
      lastResult = await inspectExpectedState(device, step.state);
      checkCount += 1;
      onCheck(lastResult);
      if (!lastResult.passed && !step.optional) {
        throw stateMismatchError(step.state, lastResult);
      }
    }
    const remaining = durationMs - (Date.now() - startedAt);
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }

  if (durationMs === 0 && step.state?.strength > 0) {
    lastResult = await inspectExpectedState(device, step.state);
    checkCount += 1;
    onCheck(lastResult);
    if (!lastResult.passed && !step.optional) {
      throw stateMismatchError(step.state, lastResult);
    }
  }
  return {
    passed: step.optional || !lastResult || lastResult.passed,
    durationMs,
    checkCount,
    lastResult,
  };
}

export async function waitForExpectedState(
  device,
  expectation,
  {
    timeoutMs = 5000,
    pollMs = 500,
    stablePolls = 1,
    optional = false,
    sleep = wait,
    onCheck = () => {},
  } = {},
) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const requiredStablePolls = Math.max(1, Number(stablePolls) || 1);
  let stableCount = 0;
  let lastResult = null;
  do {
    lastResult = await inspectExpectedState(device, expectation);
    onCheck(lastResult);
    stableCount = lastResult.passed ? stableCount + 1 : 0;
    if (stableCount >= requiredStablePolls) {
      return {
        ...lastResult,
        stablePolls: stableCount,
      };
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(Math.max(50, Number(pollMs) || 500), deadline - Date.now()));
  } while (Date.now() <= deadline);

  if (optional) {
    return {
      ...(lastResult || { passed: false, checks: [] }),
      optional: true,
      stablePolls: stableCount,
    };
  }
  throw stateMismatchError(expectation, lastResult);
}

export async function inspectExpectedState(device, expectation = {}) {
  const [focus, snapshot] = await Promise.all([
    device.getCurrentFocus?.().catch(() => null),
    device.getUiTextSnapshot?.().catch(() => null),
  ]);
  const actualPackages = uniqueStrings([
    focus?.bundleName,
    focus?.packageName,
  ]);
  const actualActivities = uniqueStrings([
    focus?.abilityName,
    focus?.activity,
    focus?.currentFocus,
  ]);
  const text = String(snapshot?.text || '');
  const layoutIds = collectLayoutIds(snapshot?.layout);
  const checks = [];
  const addCheck = (id, expected, passed, actual) => {
    if (!expected?.length) return;
    checks.push({ id, expected, passed, actual });
  };

  addCheck(
    'package',
    expectation.packages,
    intersects(actualPackages, expectation.packages),
    actualPackages,
  );
  addCheck(
    'activity',
    expectation.activities,
    intersects(actualActivities, expectation.activities),
    actualActivities,
  );
  addCheck(
    'text_any',
    expectation.textAny,
    expectation.textAny?.some((value) => text.includes(String(value))),
    text.slice(0, 500),
  );
  addCheck(
    'node_id',
    expectation.nodeIds,
    intersects([...layoutIds], expectation.nodeIds),
    [...layoutIds].slice(0, 50),
  );
  return {
    passed: checks.length === 0 || checks.every((check) => check.passed),
    checks,
    focus,
    text: text.slice(0, 1000),
  };
}

export function resolveSemanticDurationMs(step, parameters = {}) {
  const parameterId = String(step?.durationParameter || '').trim();
  const parameter = parameterId ? parameters[parameterId] : null;
  if (parameter !== null && parameter !== undefined) {
    const parsed = durationValueToMs(parameter);
    if (parsed !== null) return parsed;
  }
  return Math.min(
    2 * 60 * 60 * 1000,
    Math.max(0, Math.round(Number(step?.durationMs) || 0)),
  );
}

export function buildEvidenceManifest({
  steps = [],
  contexts = [],
  provider = '',
  layoutCaptureSupported = false,
  sensitive = false,
} = {}) {
  const contextByStep = actionContextsByStep(contexts);
  return steps.map((step, index) => {
    const stepIndex = index + 1;
    const context = contextByStep.get(stepIndex);
    const evidenceId =
      context?.evidenceId ||
      step?.evidenceId ||
      `step-${String(stepIndex).padStart(3, '0')}`;
    const captureLatency = Number(context?.captureLatencyMs);
    return {
      evidenceId,
      stepIndex,
      type: step.type,
      contextCaptured: Boolean(context),
      screenshotFile: context?.screenshotFile || null,
      nativeLayoutFile: context?.nativeLayoutFile || null,
      captureLatencyMs: Number.isFinite(captureLatency)
        ? captureLatency
        : null,
      completeness: evidenceCompleteness({
        context,
        provider,
        layoutCaptureSupported,
        sensitive,
      }),
    };
  });
}

export function assessEvidenceIntegrity({
  manifest = [],
  actionCount = null,
  liveActionCount = 0,
  detailTiming = {},
} = {}) {
  const issues = [];
  const explicitActionCount = Number(actionCount);
  const count =
    actionCount !== null &&
    actionCount !== undefined &&
    Number.isFinite(explicitActionCount)
      ? Math.max(0, explicitActionCount)
      : manifest.length;
  const contextCount = manifest.filter((entry) => entry.contextCaptured).length;
  const layoutExpected = manifest.some(
    (entry) => entry.completeness.layoutExpected,
  );
  const layoutCount = manifest.filter((entry) => entry.nativeLayoutFile).length;
  const screenshotExpected = manifest.some(
    (entry) => entry.completeness.screenshotExpected,
  );
  const screenshotCount = manifest.filter((entry) => entry.screenshotFile).length;

  if (count === 0) {
    issues.push('没有可核验的动作证据');
  }
  if (count !== manifest.length) {
    issues.push(`轨迹与证据清单数量不一致（${count}/${manifest.length}）`);
  }
  if (contextCount < count) {
    issues.push(`动作上下文缺失（${contextCount}/${count}）`);
  }
  if (layoutExpected && layoutCount < count) {
    issues.push(`逐动作布局缺失（${layoutCount}/${count}）`);
  }
  if (screenshotExpected && screenshotCount < count) {
    issues.push(`逐动作截图缺失（${screenshotCount}/${count}）`);
  }
  if (liveActionCount > 0 && Math.abs(liveActionCount - count) > 1) {
    issues.push(`实时动作与最终轨迹数量不一致（${liveActionCount}/${count}）`);
  }
  if (Number(detailTiming.lateDetailCount) > 0) {
    issues.push(`有 ${detailTiming.lateDetailCount} 个动作详情延迟到达`);
  }
  if (Number(detailTiming.orphanDetailCount) > 0) {
    issues.push(`有 ${detailTiming.orphanDetailCount} 个动作详情缺少动作头`);
  }
  return {
    status: issues.length
      ? count === 0 || contextCount === 0
        ? 'unusable'
        : 'incomplete'
      : 'complete',
    issues,
    actionCount: count,
    contextCount,
    layoutCount,
    screenshotCount,
    detailTiming: { ...detailTiming },
  };
}

function buildActionTarget(step, context, profile) {
  const widget =
    step.context?.widget ||
    context?.observedAction?.context?.widget ||
    context?.action?.context?.widget;
  const coordinate =
    step.type === 'input_text'
      ? null
      : { x: Number(step.x), y: Number(step.y) };
  const layoutNode =
    coordinate && context?.nativeLayoutSummary
      ? smallestContainingNode(context.nativeLayoutSummary, coordinate)
      : null;
  const id = stableId(widget?.id) || stableId(layoutNode?.id);
  const text = stableText(widget?.text) || stableText(layoutNode?.text);
  const type = stableText(widget?.type) || stableText(layoutNode?.type);
  const bounds = widget?.bounds || layoutNode?.bounds;
  if (!id && !text && !type) return null;
  return {
    ...(id ? { id, ids: [id] } : {}),
    ...(text ? { text, texts: [text], partial: false } : {}),
    ...(type ? { types: [type] } : {}),
    ...(bounds && profile
      ? { normalizedRegion: normalizedRegion(bounds, profile) }
      : {}),
    required: false,
  };
}

function smallestContainingNode(nodes, point) {
  return (nodes || [])
    .map((node) => ({ node, bounds: parseBounds(node?.bounds) }))
    .filter(({ node, bounds }) => {
      if (!bounds || (!node.id && !node.text && !node.type)) return false;
      return (
        point.x >= bounds.x1 &&
        point.x <= bounds.x2 &&
        point.y >= bounds.y1 &&
        point.y <= bounds.y2
      );
    })
    .sort(
      (left, right) =>
        area(left.bounds) - area(right.bounds),
    )[0]?.node || null;
}

function actionContextsByStep(contexts) {
  const map = new Map();
  for (const context of contexts || []) {
    const index = Number(context?.stepIndex ?? context?.actionIndex);
    if (Number.isInteger(index) && index > 0 && !map.has(index)) {
      map.set(index, context);
    }
  }
  return map;
}

function shouldAssertTransition(previous, current) {
  if (!current) return false;
  const previousFocus = focusIdentity(previous?.focus);
  const currentFocus = focusIdentity(current?.focus);
  if (previousFocus && currentFocus && previousFocus !== currentFocus) return true;
  const before = new Set(stableTextTokens(previous));
  const after = new Set(stableTextTokens(current));
  if (!after.size) return false;
  if (!before.size) return after.size >= 2;
  const intersection = [...before].filter((token) => after.has(token)).length;
  const union = new Set([...before, ...after]).size;
  return union > 0 && intersection / union < 0.5;
}

function stableTextTokens(context) {
  const values = context?.snapshot?.values?.length
    ? context.snapshot.values
    : String(context?.snapshot?.text || '').split(/\r?\n/);
  return uniqueStrings(
    values
      .map(stableText)
      .filter(Boolean)
      .filter((value) => !/^(返回|更多|取消|确定|允许|拒绝)$/.test(value)),
  );
}

function findDurationParameter(schema, workflowId) {
  if (!/^(?:voip|meeting):/.test(String(workflowId || ''))) return null;
  return (schema || []).find(
    (parameter) => parameter?.id === 'duration' && parameter?.type === 'duration',
  ) || null;
}

function evidenceCompleteness({
  context,
  provider,
  layoutCaptureSupported,
  sensitive,
}) {
  const layoutExpected = provider === 'hdc' && layoutCaptureSupported;
  const screenshotExpected = !sensitive;
  return {
    context: Boolean(context),
    layoutExpected,
    layout: !layoutExpected || Boolean(context?.nativeLayoutFile),
    screenshotExpected,
    screenshot: !screenshotExpected || Boolean(context?.screenshotFile),
  };
}

function stateMismatchError(expectation, result) {
  const failed = (result?.checks || [])
    .filter((check) => !check.passed)
    .map((check) => check.id)
    .join(', ');
  const error = new Error(`界面状态与录制预期不一致${failed ? `: ${failed}` : ''}`);
  error.code = 'RECORDED_STATE_MISMATCH';
  error.expectation = expectation;
  error.stateResult = result;
  return error;
}

function durationValueToMs(value) {
  if (value && typeof value === 'object' && 'amount' in value) {
    const amount = Number(value.amount);
    const factors = {
      毫秒: 1,
      秒: 1000,
      分钟: 60 * 1000,
      小时: 60 * 60 * 1000,
    };
    if (!Number.isFinite(amount) || amount < 0) return null;
    return Math.min(
      2 * 60 * 60 * 1000,
      Math.max(0, Math.round(amount * (factors[value.unit] || 1000))),
    );
  }
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(2 * 60 * 60 * 1000, Math.max(0, Math.round(number)))
    : null;
}

function collectLayoutIds(layout) {
  const ids = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    const attributes =
      value.attributes && typeof value.attributes === 'object'
        ? value.attributes
        : value.attrs && typeof value.attrs === 'object'
          ? value.attrs
          : value;
    for (const key of ['id', 'resourceId', 'key', 'accessibilityId']) {
      const id = stableId(attributes[key]);
      if (id) ids.add(id);
    }
    for (const child of value.children || []) visit(child);
  };
  visit(layout);
  return ids;
}

function focusIdentity(focus) {
  return uniqueStrings([
    focus?.bundleName,
    focus?.packageName,
    focus?.abilityName,
    focus?.activity,
    focus?.currentFocus,
  ]).join('|');
}

function stableId(value) {
  const id = String(value || '').trim();
  return isStableNodeId(id) ? id : '';
}

function isStableNodeId(value) {
  const id = String(value || '').trim();
  return Boolean(
    id &&
    id.length <= 160 &&
    !/^\d+$/.test(id) &&
    !/^[a-f0-9]{16,}$/i.test(id),
  );
}

function stableText(value) {
  const text = String(value || '').trim();
  if (
    text.length < 2 ||
    text.length > 80 ||
    text === '[已隐藏]' ||
    /^[\d\s:：,，.。%+\-/]+$/.test(text)
  ) {
    return '';
  }
  return text;
}

function parseBounds(value) {
  if (!value) return null;
  if (typeof value === 'string') {
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
  const x1 = Number(value.x1 ?? value.left);
  const y1 = Number(value.y1 ?? value.top);
  const x2 = Number(value.x2 ?? value.right);
  const y2 = Number(value.y2 ?? value.bottom);
  return [x1, y1, x2, y2].every(Number.isFinite)
    ? { x1, y1, x2, y2 }
    : null;
}

function area(bounds) {
  return Math.max(0, bounds.x2 - bounds.x1) * Math.max(0, bounds.y2 - bounds.y1);
}

function intersects(left, right) {
  const expected = new Set((right || []).map(String));
  return !expected.size || (left || []).some((value) => expected.has(String(value)));
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isActionStep(step) {
  return ACTION_TYPES.has(step?.type);
}
