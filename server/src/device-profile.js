const MAX_SAFE_AREA_RATIO = 0.2;

export function createDeviceProfile({
  status = {},
  screen = null,
  contexts = [],
  snapshot = null,
} = {}) {
  const normalizedScreen = normalizeScreen(screen || status.screen);
  const orientation = normalizedScreen
    ? normalizedScreen.width > normalizedScreen.height
      ? 'landscape'
      : 'portrait'
    : 'unknown';
  const explicitSafeArea = normalizeSafeArea(status.safeArea, normalizedScreen);
  const inferredSafeArea = inferSafeArea(normalizedScreen, [
    ...normalizeContexts(contexts),
    ...(snapshot ? [{ snapshot }] : []),
  ]);
  const safeArea = explicitSafeArea || inferredSafeArea || emptySafeArea();
  const profile = {
    provider: String(status.provider || ''),
    platform: String(status.platform || ''),
    serial: String(status.serial || ''),
    model: String(status.model || ''),
    systemVersion: String(status.systemVersion || status.harmonyVersion || ''),
    orientation,
    screen: normalizedScreen,
    safeArea,
  };
  return {
    ...profile,
    id: deviceProfileKey(profile),
  };
}

export function deviceProfileKey(profile = {}) {
  const screen = normalizeScreen(profile.screen);
  return [
    profile.provider || 'device',
    profile.serial || profile.model || 'unknown',
    profile.orientation || 'unknown',
    screen ? `${screen.width}x${screen.height}` : 'unknown',
  ].join(':');
}

export function selectDeviceProfile(baselines = [], currentProfile = null) {
  if (!currentProfile) return null;
  const candidates = Array.isArray(baselines) ? baselines : [];
  const match =
    candidates.find(
      (baseline) =>
        currentProfile.serial &&
        baseline.serial === currentProfile.serial &&
        baseline.orientation === currentProfile.orientation,
    ) ||
    candidates.find(
      (baseline) =>
        currentProfile.model &&
        baseline.model === currentProfile.model &&
        sameScreen(baseline.screen, currentProfile.screen),
    ) ||
    candidates.find(
      (baseline) =>
        baseline.orientation === currentProfile.orientation &&
        sameScreen(baseline.screen, currentProfile.screen),
    );
  if (!match) return currentProfile;
  return {
    ...match,
    ...currentProfile,
    safeArea: hasSafeArea(currentProfile.safeArea)
      ? currentProfile.safeArea
      : normalizeSafeArea(match.safeArea, currentProfile.screen) || emptySafeArea(),
  };
}

export function upsertDeviceBaseline(
  baselines,
  profile,
  { passed, at = new Date().toISOString() } = {},
) {
  if (!profile?.id) return Array.isArray(baselines) ? baselines : [];
  const result = (Array.isArray(baselines) ? baselines : []).map((entry) => ({
    ...entry,
  }));
  const index = result.findIndex((entry) => entry.id === profile.id);
  const previous = index >= 0 ? result[index] : {};
  const updated = {
    ...previous,
    ...profile,
    successfulReplays:
      Number(previous.successfulReplays || 0) + (passed === true ? 1 : 0),
    failedReplays:
      Number(previous.failedReplays || 0) + (passed === false ? 1 : 0),
    lastReplayAt: at,
    lastReplayStatus: passed === true ? 'passed' : passed === false ? 'failed' : 'unknown',
  };
  if (index >= 0) result[index] = updated;
  else result.push(updated);
  return result.slice(-20);
}

export function annotateStepCoordinates(step, profile) {
  if (!step || !profile?.screen) return { ...step };
  if (step.type === 'tap' || step.type === 'long_press') {
    const normalized = normalizedPoint(step, profile);
    return {
      ...step,
      ...normalized,
      referenceScreen: profile.screen,
      coordinateSpace: 'safe_area',
    };
  }
  if (step.type === 'swipe') {
    const start = normalizedPoint({ x: step.x1, y: step.y1 }, profile);
    const end = normalizedPoint({ x: step.x2, y: step.y2 }, profile);
    return {
      ...step,
      normalizedX1: start.normalizedX,
      normalizedY1: start.normalizedY,
      normalizedX2: end.normalizedX,
      normalizedY2: end.normalizedY,
      referenceScreen: profile.screen,
      coordinateSpace: 'safe_area',
    };
  }
  return { ...step };
}

export function resolveProfiledPoint(point, sourceProfile, targetProfile) {
  const sourceScreen = normalizeScreen(sourceProfile?.screen || point?.referenceScreen);
  const targetScreen = normalizeScreen(targetProfile?.screen);
  if (!targetScreen) {
    return {
      x: roundFinite(point?.x),
      y: roundFinite(point?.y),
    };
  }

  const safeCoordinates = point?.coordinateSpace === 'safe_area';
  const sourceViewport = viewportFor(
    sourceScreen,
    safeCoordinates ? sourceProfile?.safeArea : null,
  );
  const targetViewport = viewportFor(
    targetScreen,
    safeCoordinates ? targetProfile?.safeArea : null,
  );
  const normalizedX = finiteNumber(point?.normalizedX);
  const normalizedY = finiteNumber(point?.normalizedY);
  const ratioX =
    normalizedX ??
    coordinateRatio(point?.x, sourceViewport.x1, sourceViewport.width);
  const ratioY =
    normalizedY ??
    coordinateRatio(point?.y, sourceViewport.y1, sourceViewport.height);

  return {
    x: clampCoordinate(
      targetViewport.x1 + clampRatio(ratioX) * targetViewport.width,
      targetScreen.width,
    ),
    y: clampCoordinate(
      targetViewport.y1 + clampRatio(ratioY) * targetViewport.height,
      targetScreen.height,
    ),
  };
}

export function resolveProfiledSwipe(step, sourceProfile, targetProfile) {
  const start = resolveProfiledPoint(
    {
      x: step?.x1,
      y: step?.y1,
      normalizedX: step?.normalizedX1,
      normalizedY: step?.normalizedY1,
      referenceScreen: step?.referenceScreen,
      coordinateSpace: step?.coordinateSpace,
    },
    sourceProfile,
    targetProfile,
  );
  const end = resolveProfiledPoint(
    {
      x: step?.x2,
      y: step?.y2,
      normalizedX: step?.normalizedX2,
      normalizedY: step?.normalizedY2,
      referenceScreen: step?.referenceScreen,
      coordinateSpace: step?.coordinateSpace,
    },
    sourceProfile,
    targetProfile,
  );
  return {
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
  };
}

export function normalizedRegion(bounds, profile, paddingRatio = 0.02) {
  const parsed = normalizeBounds(bounds);
  if (!parsed || !profile?.screen) return null;
  const viewport = viewportFor(profile.screen, profile.safeArea);
  const paddingX = viewport.width * paddingRatio;
  const paddingY = viewport.height * paddingRatio;
  return {
    minX: clampRatio((parsed.x1 - paddingX - viewport.x1) / viewport.width),
    minY: clampRatio((parsed.y1 - paddingY - viewport.y1) / viewport.height),
    maxX: clampRatio((parsed.x2 + paddingX - viewport.x1) / viewport.width),
    maxY: clampRatio((parsed.y2 + paddingY - viewport.y1) / viewport.height),
    coordinateSpace: 'safe_area',
  };
}

export function resolveNormalizedRegion(region, profile) {
  if (!region || !profile?.screen) return region || null;
  const viewport = viewportFor(
    profile.screen,
    region.coordinateSpace === 'safe_area' ? profile.safeArea : null,
  );
  return {
    minX: Math.round(viewport.x1 + clampRatio(region.minX) * viewport.width),
    minY: Math.round(viewport.y1 + clampRatio(region.minY) * viewport.height),
    maxX: Math.round(viewport.x1 + clampRatio(region.maxX) * viewport.width),
    maxY: Math.round(viewport.y1 + clampRatio(region.maxY) * viewport.height),
  };
}

function normalizedPoint(point, profile) {
  const viewport = viewportFor(profile.screen, profile.safeArea);
  return {
    normalizedX: clampRatio(
      (finiteNumber(point?.x) - viewport.x1) / viewport.width,
    ),
    normalizedY: clampRatio(
      (finiteNumber(point?.y) - viewport.y1) / viewport.height,
    ),
  };
}

function inferSafeArea(screen, contexts) {
  if (!screen) return null;
  const candidates = [];
  for (const context of contexts) {
    collectLayoutBounds(context?.snapshot?.layout, candidates);
    for (const node of context?.nativeLayoutSummary || []) {
      const bounds = normalizeBounds(node?.bounds);
      if (bounds) candidates.push(bounds);
    }
  }
  const screenArea = screen.width * screen.height;
  const usable = candidates
    .filter((bounds) => {
      const width = bounds.x2 - bounds.x1;
      const height = bounds.y2 - bounds.y1;
      return (
        width > 0 &&
        height > 0 &&
        width * height >= screenArea * 0.75 &&
        bounds.x1 >= 0 &&
        bounds.y1 >= 0 &&
        bounds.x2 <= screen.width &&
        bounds.y2 <= screen.height
      );
    })
    .sort(
      (left, right) =>
        (right.x2 - right.x1) * (right.y2 - right.y1) -
        (left.x2 - left.x1) * (left.y2 - left.y1),
    );
  if (!usable.length) return null;
  const bounds = usable[0];
  return normalizeSafeArea(
    {
      left: bounds.x1,
      top: bounds.y1,
      right: screen.width - bounds.x2,
      bottom: screen.height - bounds.y2,
    },
    screen,
  );
}

function collectLayoutBounds(value, target) {
  if (!value || typeof value !== 'object') return;
  const attributes =
    value.attributes && typeof value.attributes === 'object'
      ? value.attributes
      : value.attrs && typeof value.attrs === 'object'
        ? value.attrs
        : value;
  const bounds = normalizeBounds(
    attributes.bounds ?? attributes.rect ?? attributes.frame,
  );
  if (bounds) target.push(bounds);
  for (const child of value.children || []) collectLayoutBounds(child, target);
}

function normalizeContexts(contexts) {
  return Array.isArray(contexts) ? contexts : [];
}

function normalizeScreen(screen) {
  const width = finiteNumber(screen?.width);
  const height = finiteNumber(screen?.height);
  if (!width || !height || width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

function normalizeSafeArea(value, screen) {
  if (!value || !screen) return null;
  const safeArea = {
    left: clampInset(value.left, screen.width),
    top: clampInset(value.top, screen.height),
    right: clampInset(value.right, screen.width),
    bottom: clampInset(value.bottom, screen.height),
  };
  if (safeArea.left + safeArea.right >= screen.width) return null;
  if (safeArea.top + safeArea.bottom >= screen.height) return null;
  return safeArea;
}

function emptySafeArea() {
  return { left: 0, top: 0, right: 0, bottom: 0 };
}

function hasSafeArea(value) {
  return ['left', 'top', 'right', 'bottom'].some(
    (key) => Number(value?.[key]) > 0,
  );
}

function viewportFor(screen, safeArea) {
  const normalizedScreen = normalizeScreen(screen) || { width: 1, height: 1 };
  const insets =
    normalizeSafeArea(safeArea, normalizedScreen) || emptySafeArea();
  const x1 = insets.left;
  const y1 = insets.top;
  return {
    x1,
    y1,
    width: Math.max(1, normalizedScreen.width - insets.left - insets.right),
    height: Math.max(1, normalizedScreen.height - insets.top - insets.bottom),
  };
}

function normalizeBounds(value) {
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
  const x1 = finiteNumber(value.x1 ?? value.left ?? value.x);
  const y1 = finiteNumber(value.y1 ?? value.top ?? value.y);
  const x2 = finiteNumber(
    value.x2 ?? value.right ?? (x1 == null ? null : x1 + Number(value.width || 0)),
  );
  const y2 = finiteNumber(
    value.y2 ?? value.bottom ?? (y1 == null ? null : y1 + Number(value.height || 0)),
  );
  if ([x1, y1, x2, y2].some((entry) => entry == null)) return null;
  if (x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
}

function sameScreen(left, right) {
  const a = normalizeScreen(left);
  const b = normalizeScreen(right);
  return Boolean(a && b && a.width === b.width && a.height === b.height);
}

function coordinateRatio(value, start, length) {
  const coordinate = finiteNumber(value);
  return coordinate == null ? 0 : (coordinate - start) / Math.max(1, length);
}

function clampInset(value, dimension) {
  const number = finiteNumber(value) ?? 0;
  return Math.round(
    Math.max(0, Math.min(dimension * MAX_SAFE_AREA_RATIO, number)),
  );
}

function clampCoordinate(value, dimension) {
  return Math.max(0, Math.min(dimension - 1, Math.round(value)));
}

function clampRatio(value) {
  const number = finiteNumber(value);
  return number == null ? 0 : Math.max(0, Math.min(1, number));
}

function roundFinite(value) {
  const number = finiteNumber(value);
  return number == null ? null : Math.round(number);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
