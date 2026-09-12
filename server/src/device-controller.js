const DEVICE_METHODS = [
  'getInstalledPackages',
  'getCurrentFocus',
  'getScreenSize',
  'getDisplayOrientation',
  'getMediaPlaybackState',
  'forceStopPackage',
  'uninstallPackage',
  'launchPackage',
  'startUiRecording',
  'readUiRecording',
  'recoverUiRecording',
  'startActivity',
  'keyevent',
  'openUri',
  'swipe',
  'tap',
  'longPress',
  'tapText',
  'tapTextInRegion',
  'assertNoSensitivePrompt',
  'inputText',
  'inputKeyText',
  'tapResource',
  'findResourceNode',
  'findTextNode',
  'findUiNode',
  'getUiTextSnapshot',
  'screenshotPng',
];

export function createDeviceController({ adbAdapter, hdcAdapter }) {
  let preferredAdapter = null;
  let preferredStatus = null;
  let activeSession = null;
  let sessionSequence = 0;

  async function inspect(adapter) {
    if (!adapter?.getDeviceStatus) {
      return { connected: false };
    }
    try {
      return await adapter.getDeviceStatus();
    } catch (error) {
      return {
        connected: false,
        provider: adapter === adbAdapter ? 'adb' : 'hdc',
        error: error.message,
      };
    }
  }

  async function select() {
    const adapters = preferredAdapter
      ? [preferredAdapter, preferredAdapter === adbAdapter ? hdcAdapter : adbAdapter]
      : [adbAdapter, hdcAdapter];
    const statuses = [];

    for (const adapter of adapters) {
      if (!adapter || statuses.some((entry) => entry.adapter === adapter)) continue;
      const status = await inspect(adapter);
      statuses.push({ adapter, status });
      if (status.connected) {
        preferredAdapter = adapter;
        preferredStatus = status;
        return { adapter, status };
      }
    }

    const adbStatus = statuses.find((entry) => entry.adapter === adbAdapter)?.status;
    const hdcStatus = statuses.find((entry) => entry.adapter === hdcAdapter)?.status;
    preferredAdapter = null;
    preferredStatus = null;
    return {
      adapter: hdcAdapter || adbAdapter,
      status: hdcStatus?.provider ? hdcStatus : adbStatus || { connected: false },
    };
  }

  async function getDeviceStatus() {
    if (activeSession) {
      const status = await inspect(activeSession.adapter);
      const lockedSerial = activeSession.status.serial || '';
      if (
        status.connected &&
        lockedSerial &&
        status.serial &&
        status.serial !== lockedSerial
      ) {
        return {
          ...status,
          connected: false,
          locked: true,
          lockedSerial,
          error: `Locked device ${lockedSerial} changed to ${status.serial}`,
        };
      }

      preferredStatus = status;
      activeSession.status = {
        ...activeSession.status,
        ...status,
        serial: lockedSerial || status.serial || '',
      };
      return {
        ...activeSession.status,
        connected: Boolean(status.connected),
        provider: status.provider || activeSession.status.provider || 'none',
        locked: true,
      };
    }

    const selected = await select();
    const status = selected.status || {};
    return {
      ...status,
      connected: Boolean(status.connected),
      provider: status.provider || 'none',
    };
  }

  async function beginSession({ owner = 'device-session' } = {}) {
    if (activeSession) {
      throw new Error(
        `Device is already locked by ${activeSession.owner || activeSession.id}`,
      );
    }

    const selected = await select();
    if (!selected.status?.connected) {
      throw new Error('No connected ADB or HDC device');
    }

    const session = {
      id: `device-session-${++sessionSequence}`,
      owner,
      adapter: selected.adapter,
      status: { ...selected.status },
    };

    try {
      if (
        session.status.serial &&
        typeof session.adapter?.setTargetSerial === 'function'
      ) {
        await session.adapter.setTargetSerial(session.status.serial);
      }
      activeSession = session;
      preferredAdapter = session.adapter;
      preferredStatus = session.status;
      return publicSession(session);
    } catch (error) {
      if (typeof session.adapter?.setTargetSerial === 'function') {
        await Promise.resolve(session.adapter.setTargetSerial('')).catch(() => {});
      }
      throw error;
    }
  }

  async function endSession(session) {
    if (!activeSession) return false;
    const sessionId = typeof session === 'string' ? session : session?.id;
    if (sessionId && sessionId !== activeSession.id) {
      throw new Error(`Cannot unlock device session ${sessionId}`);
    }

    const locked = activeSession;
    activeSession = null;
    try {
      if (typeof locked.adapter?.setTargetSerial === 'function') {
        await locked.adapter.setTargetSerial('');
      }
    } finally {
      preferredAdapter = locked.adapter;
      preferredStatus = locked.status;
    }
    return true;
  }

  async function call(method, ...args) {
    let adapter = activeSession?.adapter || preferredAdapter;
    if (!adapter) {
      const selected = await select();
      if (!selected.status.connected) {
        throw new Error('未检测到已连接的 ADB 或 HDC 设备');
      }
      adapter = selected.adapter;
    }
    const handler = adapter?.[method];
    if (typeof handler !== 'function') {
      throw new Error(`当前设备适配器不支持 ${method}`);
    }
    try {
      const preparedArgs = await prepareCallArguments(method, args, adapter);
      const result = await handler(...preparedArgs);
      rememberDeviceResult(method, result);
      return result;
    } catch (error) {
      if (isConnectionFailure(error) && !activeSession) {
        preferredAdapter = null;
        preferredStatus = null;
      }
      throw error;
    }
  }

  async function prepareCallArguments(method, args, adapter) {
    if (!['tap', 'longPress', 'swipe', 'inputText'].includes(method) || !args[0]) {
      return args;
    }

    if (method === 'inputText') {
      const options = args[1];
      if (
        !options ||
        (!hasPointCoordinates(options) && !options.target && !options.anchor)
      ) {
        return args;
      }
      return [args[0], await resolvePointerOptions(adapter, options), ...args.slice(2)];
    }

    if (method === 'swipe') {
      return [
        resolveSwipeCoordinates(args[0], currentScreen(args[0])),
        ...args.slice(1),
      ];
    }

    return [await resolvePointerOptions(adapter, args[0]), ...args.slice(1)];
  }

  async function resolvePointerOptions(adapter, point) {
    const target = point.target || point.anchor;
    if (target) {
      const node = await findTargetNode(adapter, target).catch((error) => {
        if (target.required) throw error;
        return null;
      });
      const center = getNodeCenter(node);
      if (center) {
        return {
          ...point,
          x: center.x,
          y: center.y,
          resolvedBy: 'ui-node',
        };
      }
      if (target.required) {
        throw new Error(`UI target not found: ${describeTarget(target)}`);
      }
    }

    return resolvePointCoordinates(point, currentScreen(point));
  }

  function currentScreen(point) {
    return (
      normalizeScreen(point?.targetScreen) ||
      normalizeScreen(activeSession?.status?.screen) ||
      normalizeScreen(preferredStatus?.screen)
    );
  }

  function rememberDeviceResult(method, result) {
    if (method === 'getScreenSize') {
      const screen = normalizeScreen(result);
      if (screen) updateRememberedScreen(screen);
      return;
    }
    if (method === 'getDisplayOrientation') {
      const screen = parseScreenText(result?.raw);
      if (screen) updateRememberedScreen(screen);
    }
  }

  function updateRememberedScreen(screen) {
    preferredStatus = {
      ...(preferredStatus || {}),
      screen,
    };
    if (activeSession) {
      activeSession.status = {
        ...activeSession.status,
        screen,
      };
    }
  }

  const controller = {
    getDeviceStatus,
    beginSession,
    endSession,
    getActiveSession: () => (activeSession ? publicSession(activeSession) : null),
  };
  for (const method of DEVICE_METHODS) {
    controller[method] = (...args) => call(method, ...args);
  }
  return controller;
}

export function resolvePointCoordinates(point = {}, targetScreen = null) {
  const target = normalizeScreen(point.targetScreen) || normalizeScreen(targetScreen);
  const reference = normalizeScreen(point.referenceScreen);
  const normalizedX = finiteNumber(point.normalizedX);
  const normalizedY = finiteNumber(point.normalizedY);
  let x = normalizedX === null || !target ? finiteNumber(point.x) : normalizedX * target.width;
  let y = normalizedY === null || !target ? finiteNumber(point.y) : normalizedY * target.height;

  if (reference && target) {
    if (normalizedX === null && x !== null) x *= target.width / reference.width;
    if (normalizedY === null && y !== null) y *= target.height / reference.height;
  }

  return {
    ...point,
    ...(x === null ? {} : { x: clampCoordinate(x, target?.width) }),
    ...(y === null ? {} : { y: clampCoordinate(y, target?.height) }),
  };
}

export function resolveSwipeCoordinates(swipe = {}, targetScreen = null) {
  const shared = {
    referenceScreen: swipe.referenceScreen,
    targetScreen: swipe.targetScreen,
  };
  const start = resolvePointCoordinates(
    {
      ...shared,
      x: swipe.x1,
      y: swipe.y1,
      normalizedX: swipe.normalizedX1,
      normalizedY: swipe.normalizedY1,
    },
    targetScreen,
  );
  const end = resolvePointCoordinates(
    {
      ...shared,
      x: swipe.x2,
      y: swipe.y2,
      normalizedX: swipe.normalizedX2,
      normalizedY: swipe.normalizedY2,
    },
    targetScreen,
  );
  return {
    ...swipe,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
  };
}

async function findTargetNode(adapter, target) {
  const resourceId = target.resourceId || target.id;
  const genericIds = target.ids || (resourceId ? [resourceId] : []);
  if (resourceId && typeof adapter.findResourceNode === 'function') {
    const node = await adapter.findResourceNode(resourceId);
    if (node && nodeMatchesTarget(node, target)) return node;
  }

  const texts = target.texts || target.text;
  if (texts && typeof adapter.findTextNode === 'function') {
    const node = await adapter.findTextNode(texts, {
      partial: Boolean(target.partial),
      region: target.region,
    });
    if (node && nodeMatchesTarget(node, target)) return node;
  }

  if (
    typeof adapter.findUiNode === 'function' &&
    (target.types ||
      genericIds.length ||
      target.keys ||
      typeof target.clickable === 'boolean')
  ) {
    return adapter.findUiNode({
      types: target.types,
      ids: genericIds,
      keys: target.keys,
      clickable: target.clickable,
      region: target.region,
    });
  }
  return null;
}

function getNodeCenter(node) {
  if (!node) return null;
  const centerX = finiteNumber(node.centerX);
  const centerY = finiteNumber(node.centerY);
  if (centerX !== null && centerY !== null) {
    return { x: Math.round(centerX), y: Math.round(centerY) };
  }

  const bounds = normalizeBounds(node.bounds || node.attributes?.bounds);
  if (!bounds) return null;
  return {
    x: Math.round((bounds.x1 + bounds.x2) / 2),
    y: Math.round((bounds.y1 + bounds.y2) / 2),
  };
}

function nodeMatchesTarget(node, target) {
  const center = getNodeCenter(node);
  if (target.region && center && !pointInRegion(center, target.region)) {
    return false;
  }
  const types = Array.isArray(target.types)
    ? target.types
    : target.types
      ? [target.types]
      : [];
  if (!types.length) return true;
  const actual = String(
    node?.attributes?.type ||
      node?.attributes?.className ||
      node?.type ||
      node?.className ||
      '',
  );
  return !actual || types.some((type) => String(type) === actual);
}

function pointInRegion(point, region) {
  const minX = finiteNumber(region.minX ?? region.x1) ?? 0;
  const minY = finiteNumber(region.minY ?? region.y1) ?? 0;
  const maxX =
    finiteNumber(region.maxX ?? region.x2) ?? Number.POSITIVE_INFINITY;
  const maxY =
    finiteNumber(region.maxY ?? region.y2) ?? Number.POSITIVE_INFINITY;
  return (
    point.x >= minX &&
    point.x <= maxX &&
    point.y >= minY &&
    point.y <= maxY
  );
}

function normalizeBounds(bounds) {
  if (!bounds) return null;
  if (typeof bounds === 'string') {
    const match = bounds.match(
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

  const x1 = finiteNumber(bounds.x1 ?? bounds.left);
  const y1 = finiteNumber(bounds.y1 ?? bounds.top);
  const x2 = finiteNumber(bounds.x2 ?? bounds.right);
  const y2 = finiteNumber(bounds.y2 ?? bounds.bottom);
  if ([x1, y1, x2, y2].some((value) => value === null)) return null;
  return { x1, y1, x2, y2 };
}

function normalizeScreen(screen) {
  const width = finiteNumber(screen?.width);
  const height = finiteNumber(screen?.height);
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { width, height };
}

function parseScreenText(value) {
  const match = String(value || '').match(/(\d+)\s*x\s*(\d+)/i);
  return match
    ? normalizeScreen({ width: Number(match[1]), height: Number(match[2]) })
    : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampCoordinate(value, limit) {
  const rounded = Math.round(value);
  if (!Number.isFinite(limit) || limit <= 0) return rounded;
  return Math.max(0, Math.min(Math.round(limit) - 1, rounded));
}

function hasPointCoordinates(value) {
  return (
    finiteNumber(value?.x) !== null ||
    finiteNumber(value?.y) !== null ||
    finiteNumber(value?.normalizedX) !== null ||
    finiteNumber(value?.normalizedY) !== null
  );
}

function describeTarget(target) {
  return String(
    target.resourceId ||
      target.id ||
      target.text ||
      target.texts ||
      target.types ||
      target.keys ||
      'unknown',
  );
}

function publicSession(session) {
  return {
    id: session.id,
    owner: session.owner,
    connected: Boolean(session.status.connected),
    provider: session.status.provider || 'none',
    platform: session.status.platform,
    serial: session.status.serial || '',
    model: session.status.model || '',
    screen: session.status.screen || null,
  };
}

function isConnectionFailure(error) {
  return /not found|offline|disconnected|未检测到|no devices|device.*not/i.test(
    String(error?.message || error || ''),
  );
}
