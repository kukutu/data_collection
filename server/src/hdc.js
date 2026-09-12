import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_HDC_PATH = process.env.HDC_PATH || 'hdc';
const DEFAULT_TIMEOUT_MS = Number(process.env.HDC_TIMEOUT_MS || 15000);
const DEFAULT_REMOTE_SCREEN = '/data/local/tmp/android-controller-screen.png';
const DEFAULT_REMOTE_LAYOUT = '/data/local/tmp/android-controller-layout.json';
const HARMONY_KEYCODE_0 = 2000;
const HARMONY_KEYCODE_A = 2017;
const HARMONY_KEYCODE_DELETE = 2055;
const HARMONY_KEYCODE_CTRL_LEFT = 2072;

const HDC_TRANSPORTS = new Set(['USB', 'UART', 'TCP', 'WIFI', 'BLUETOOTH']);
const CONNECTED_STATES = new Set(['CONNECTED', 'READY', 'ONLINE']);
const UI_LAYOUT_ATTEMPTS = 2;
const UI_LAYOUT_RETRY_DELAY_MS = 300;

function execHdc(hdcPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      hdcPath,
      args,
      {
        encoding: options.encoding ?? 'utf8',
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export function parseHdcTargets(output) {
  const targets = [];

  for (const line of String(output || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const tokens = trimmed.split(/\s+/);
    const transportIndex = tokens.findIndex((token) => HDC_TRANSPORTS.has(token.toUpperCase()));
    if (transportIndex <= 0) continue;

    const transport = tokens[transportIndex].toUpperCase();
    const state = tokens[transportIndex + 1] || '';
    if (transport === 'UART') continue;

    targets.push({
      serial: tokens[0],
      transport,
      state,
    });
  }

  return targets;
}

export function parseBundleLaunchInfo(output) {
  const root = parseHdcJson(output);
  if (!root || typeof root !== 'object') return null;

  const moduleInfos = [
    ...(Array.isArray(root.hapModuleInfos) ? root.hapModuleInfos : []),
    ...(Array.isArray(root.moduleInfos) ? root.moduleInfos : []),
  ];
  const moduleName =
    String(
      root.entryModuleName ||
        root.mainEntry ||
        root.moduleName ||
        root.moduleNames?.[0] ||
        root.hapModuleNames?.[0] ||
        moduleInfos[0]?.moduleName ||
        '',
    ).trim() || null;

  const preferredModule =
    moduleInfos.find((module) => module.moduleName === moduleName) ||
    moduleInfos.find((module) => module.mainAbility || module.mainElementName) ||
    moduleInfos[0] ||
    root;

  const abilityInfos = Array.isArray(preferredModule?.abilityInfos)
    ? preferredModule.abilityInfos
    : Array.isArray(root.abilityInfos)
      ? root.abilityInfos
      : [];
  const launcherAbility =
    abilityInfos.find((ability) => ability.isLauncherAbility) ||
    abilityInfos.find((ability) => ability.name) ||
    null;
  const abilityName =
    String(
      preferredModule?.mainAbility ||
        preferredModule?.mainElementName ||
        preferredModule?.abilityName ||
        launcherAbility?.name ||
        root.mainAbility ||
        root.mainElementName ||
        '',
    ).trim() || null;

  if (!moduleName || !abilityName) return null;
  return { moduleName, abilityName };
}

export function parseHarmonyForeground(output, apps = []) {
  const compatibilityFocus = parseHarmonyCompatibilityForeground(output, apps);
  if (compatibilityFocus) return compatibilityFocus;

  const records = splitHarmonyAbilityRecords(output);

  for (const record of records) {
    if (!/^\s*state\s+#FOREGROUND\b/im.test(record)) continue;

    const bundleName =
      matchBracketValue(record, /^\s*bundle\s+name\s*\[([^\]]+)\]/im) ||
      matchLineValue(record, /^\s*bundle(?:Name)?\s*[:=]\s*([^\s]+)/im);
    if (!bundleName) continue;

    const activity =
      matchBracketValue(record, /^\s*(?:main\s+name|ability\s+name)\s*\[([^\]]+)\]/im) ||
      matchLineValue(record, /^\s*(?:mainName|abilityName)\s*[:=]\s*([^\s]+)/im) ||
      null;
    const app = apps.find(
      (candidate) =>
        candidate.harmonyBundleName === bundleName || candidate.packageName === bundleName,
    );

    return {
      packageName: app?.packageName || bundleName,
      bundleName,
      activity,
      raw: record.trim(),
    };
  }

  return null;
}

function parseHarmonyCompatibilityForeground(output, apps = []) {
  const records = splitHarmonyMissionRecords(output);

  for (const record of records) {
    if (!/^\s*state\s+#FOREGROUND\b/im.test(record)) continue;

    const mission = record.match(
      /mission\s+name\s+#\[#([^:\]\s]+):([^:\]\s]+):([^\]\s]+)\]/i,
    );
    if (!mission) continue;

    const packageName = mission[1].trim();
    const moduleName = mission[2].trim();
    const activity = mission[3].trim();
    const hostBundleName =
      matchBracketValue(record, /^\s*bundle\s+name\s*\[([^\]]+)\]/im) ||
      matchLineValue(record, /^\s*bundle(?:Name)?\s*[:=]\s*([^\s]+)/im);
    const app = apps.find((candidate) => candidate.packageName === packageName);
    const compatibilityMode =
      app?.harmonyLaunch?.compatibility || hostBundleName === 'com.huawei.shell_assistant';
    if (!compatibilityMode) continue;

    return {
      packageName: app?.packageName || packageName,
      bundleName: app?.harmonyBundleName || packageName,
      moduleName,
      activity,
      hostBundleName,
      compatibility: true,
      raw: record.trim(),
    };
  }

  return null;
}

export function parseHarmonyScreenSize(output) {
  const source = String(output || '');
  const candidates = [];

  for (const match of source.matchAll(
    /bounds"\s*:\s*"\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]"/g,
  )) {
    candidates.push({
      x1: Number(match[1]),
      y1: Number(match[2]),
      x2: Number(match[3]),
      y2: Number(match[4]),
    });
  }

  for (const match of source.matchAll(
    /bounds\s*[:=]\s*"?\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]"?/g,
  )) {
    candidates.push({
      x1: Number(match[1]),
      y1: Number(match[2]),
      x2: Number(match[3]),
      y2: Number(match[4]),
    });
  }

  if (!candidates.length) {
    const direct = source.match(
      /(?:screen|display)?\s*(?:width|w)\s*[:=]\s*(\d+)[^\d]+(?:height|h)\s*[:=]\s*(\d+)/i,
    );
    if (direct) return { width: Number(direct[1]), height: Number(direct[2]) };
    return null;
  }

  candidates.sort(
    (left, right) =>
      Math.abs(right.x2 - right.x1) * Math.abs(right.y2 - right.y1) -
      Math.abs(left.x2 - left.x1) * Math.abs(left.y2 - left.y1),
  );
  const root = candidates[0];
  const width = Math.abs(root.x2 - root.x1);
  const height = Math.abs(root.y2 - root.y1);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function mapHarmonyKeyEvent(code) {
  const value = String(code || '').trim();
  const normalized = value.toUpperCase();
  const keyMap = {
    KEYCODE_BACK: 'Back',
    BACK: 'Back',
    '4': 'Back',
    KEYCODE_HOME: 'Home',
    HOME: 'Home',
    '3': 'Home',
    KEYCODE_POWER: 'Power',
    POWER: 'Power',
    KEYCODE_ENTER: 'Enter',
    ENTER: 'Enter',
    KEYCODE_MENU: 'Menu',
    MENU: 'Menu',
    KEYCODE_APP_SWITCH: 'Recent',
    KEYCODE_RECENT_APPS: 'Recent',
  };
  return keyMap[normalized] || value;
}

export function encodeHarmonyKeyText(text) {
  const normalized = String(text || '').trim().toUpperCase();
  if (!normalized) return [];
  if (!/^[A-Z0-9]+$/.test(normalized)) {
    throw new Error('Harmony key text only supports ASCII letters and digits without spaces');
  }

  return [...normalized].map((character) => {
    if (character >= 'A' && character <= 'Z') {
      return HARMONY_KEYCODE_A + character.charCodeAt(0) - 65;
    }
    return HARMONY_KEYCODE_0 + Number(character);
  });
}

export function createSerialTaskQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(
      () => task(),
      () => task(),
    );
    tail = result.catch(() => {});
    return result;
  };
}

export function buildHdcUiRecordArgs(
  targetSerial,
  {
    recordWidgetInfo = false,
    printToConsole = true,
    saveLayout = true,
  } = {},
) {
  return [
    '-t',
    targetSerial,
    'shell',
    'uitest',
    'uiRecord',
    'record',
    '-W',
    String(Boolean(recordWidgetInfo)),
    ...(saveLayout ? ['-l'] : []),
    '-c',
    String(Boolean(printToConsole)),
  ];
}

export function parseUiRecordingLayoutPaths(output) {
  const paths = new Set();
  const addPath = (value) => {
    const path = String(value || '').trim();
    if (
      path &&
      path.startsWith('/data/') &&
      !path.includes('..') &&
      (/\.(?:json|xml)$/i.test(path) || /layout/i.test(path))
    ) {
      paths.add(path);
    }
  };
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:FILEPAHT|FILEPATH|filePath|layoutPath)$/i.test(key)) addPath(entry);
      else if (entry && typeof entry === 'object') visit(entry);
    }
  };

  for (const line of String(output || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      visit(JSON.parse(trimmed));
    } catch {
      for (const match of trimmed.matchAll(/(\/data\/[^\s"',]+\.(?:json|xml))/gi)) {
        addPath(match[1]);
      }
    }
  }
  return [...paths];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHdcAdapter({
  apps = [],
  hdcPath = DEFAULT_HDC_PATH,
  serial = process.env.HDC_SERIAL || '',
  remoteScreenFile = process.env.HDC_SCREEN_REMOTE_FILE || DEFAULT_REMOTE_SCREEN,
  remoteLayoutFile = process.env.HDC_LAYOUT_REMOTE_FILE || DEFAULT_REMOTE_LAYOUT,
} = {}) {
  const runUiLayoutExclusive = createSerialTaskQueue();
  const configuredSerial = String(serial || '').trim();
  let sessionSerial = '';
  let activeUiRecorder = null;

  async function listTargets() {
    const { stdout } = await execHdc(hdcPath, ['list', 'targets', '-v']);
    return parseHdcTargets(stdout);
  }

  async function resolveSerial() {
    const targets = await listTargets();
    const preferredSerial = sessionSerial || configuredSerial;
    if (preferredSerial) {
      const preferred = targets.find((target) => target.serial === preferredSerial);
      if (preferred && CONNECTED_STATES.has(preferred.state.toUpperCase())) {
        return preferred.serial;
      }
      throw new Error(`HDC target ${preferredSerial} is not connected`);
    }

    const active = targets.find((target) => CONNECTED_STATES.has(target.state.toUpperCase()));
    if (active) return active.serial;

    throw new Error('未检测到已连接的 HDC 设备');
  }

  async function targetCommand(args, options = {}) {
    const targetSerial = options.serial || (await resolveSerial());
    return execHdc(hdcPath, ['-t', targetSerial, ...args], options);
  }

  async function hdcText(args, options = {}) {
    const { stdout } = await targetCommand(args, options);
    return String(stdout);
  }

  async function getDeviceStatus() {
    let devices;
    try {
      devices = await listTargets();
    } catch (error) {
      return {
        connected: false,
        provider: 'hdc',
        platform: 'harmony',
        devices: [],
        error: error.message,
      };
    }

    const preferredSerial = sessionSerial || configuredSerial;
    const preferred = preferredSerial
      ? devices.find((target) => target.serial === preferredSerial) || null
      : null;
    const active =
      (preferred && CONNECTED_STATES.has(preferred.state.toUpperCase()) ? preferred : null) ||
      (!preferredSerial
        ? devices.find((target) => CONNECTED_STATES.has(target.state.toUpperCase())) || null
        : null);
    if (!active) {
      return {
        connected: false,
        provider: 'hdc',
        platform: 'harmony',
        serial: preferredSerial,
        locked: Boolean(sessionSerial),
        devices,
        ...(preferredSerial
          ? { error: `HDC target ${preferredSerial} is not connected` }
          : {}),
      };
    }

    const [model, systemVersion, focus, screen] = await Promise.all([
      readParam('const.product.model', active.serial),
      readParam('const.product.software.version', active.serial),
      getCurrentFocus(active.serial).catch(() => null),
      getScreenSize(active.serial).catch(() => null),
    ]);

    return {
      connected: true,
      provider: 'hdc',
      platform: 'harmony',
      serial: active.serial,
      transport: active.transport,
      model,
      harmonyVersion: extractHarmonyVersion(systemVersion),
      systemVersion,
      focus,
      screen,
      devices,
    };
  }

  function setTargetSerial(targetSerial) {
    sessionSerial = String(targetSerial || '').trim();
    return sessionSerial;
  }

  async function readParam(name, targetSerial) {
    return hdcText(['shell', 'param', 'get', name], { serial: targetSerial })
      .then((value) => value.trim().split(/\r?\n/)[0].trim())
      .catch(() => '');
  }

  async function getInstalledPackages() {
    const nativePackages = await hdcText(['shell', 'bm', 'dump', '-a'], {
      timeoutMs: 30000,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (!apps.some((app) => app.harmonyLaunch?.compatibility)) {
      return nativePackages;
    }

    const compatibilityMissions = await hdcText(['shell', 'aa', 'dump', '-l'], {
      timeoutMs: 10000,
      maxBuffer: 10 * 1024 * 1024,
    }).catch(() => '');
    return [nativePackages, compatibilityMissions].filter(Boolean).join('\n');
  }

  async function getCurrentFocus(targetSerial) {
    const output = await hdcText(['shell', 'aa', 'dump', '-l'], {
      serial: targetSerial,
      timeoutMs: 10000,
    });
    return parseHarmonyForeground(output, apps);
  }

  function getUiLayout(targetSerial, options = {}) {
    return runUiLayoutExclusive(() => readUiLayout(targetSerial, options));
  }

  async function readUiLayout(
    targetSerial,
    { attempts = UI_LAYOUT_ATTEMPTS, timeoutMs = 15000 } = {},
  ) {
    const localRoot = await mkdtemp(join(tmpdir(), 'android-controller-hdc-'));
    const localFile = join(localRoot, 'layout.json');
    const maxAttempts = Math.max(1, Math.min(3, Number(attempts) || 1));
    const commandTimeoutMs = Math.max(1000, Number(timeoutMs) || 15000);
    try {
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await hdcText(['shell', 'uitest', 'dumpLayout', '-p', remoteLayoutFile], {
            serial: targetSerial,
            timeoutMs: commandTimeoutMs,
          });
          await targetCommand(['file', 'recv', remoteLayoutFile, localFile], {
            serial: targetSerial,
            timeoutMs: commandTimeoutMs,
            maxBuffer: 5 * 1024 * 1024,
          });
          return parseHarmonyLayout(await readFile(localFile, 'utf8'));
        } catch (error) {
          lastError = error;
          if (attempt < maxAttempts) {
            await wait(UI_LAYOUT_RETRY_DELAY_MS);
          }
        }
      }
      throw lastError;
    } finally {
      await rm(localRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function getScreenSize(targetSerial) {
    const layout = await getUiLayout(targetSerial);
    return parseHarmonyScreenSize(JSON.stringify(layout));
  }

  async function getDisplayOrientation() {
    const screen = await getScreenSize();
    return {
      rotation: null,
      isLandscape: Boolean(screen && screen.width > screen.height),
      raw: screen ? `${screen.width}x${screen.height}` : '',
    };
  }

  async function getMediaPlaybackState(packageName) {
    return {
      packageName,
      active: false,
      stateName: 'UNSUPPORTED',
      stateCode: null,
      isPlaying: false,
      unsupported: true,
      raw: '',
    };
  }

  function bundleForPackage(packageName) {
    const app = apps.find(
      (candidate) =>
        candidate.packageName === packageName || candidate.harmonyBundleName === packageName,
    );
    return {
      app,
      bundleName: app?.harmonyBundleName || packageName,
    };
  }

  async function startUiRecording({
    recordWidgetInfo = false,
    printToConsole = true,
    saveLayout = true,
  } = {}) {
    const targetSerial = await resolveSerial();
    await stopActiveUiRecorder();
    const args = buildHdcUiRecordArgs(targetSerial, {
      recordWidgetInfo,
      printToConsole,
      saveLayout,
    });
    const child = spawn(hdcPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeUiRecorder = child;
    child.once('close', () => {
      if (activeUiRecorder === child) activeUiRecorder = null;
    });
    return {
      process: child,
      provider: 'hdc',
      serial: targetSerial,
      mode: 'uitest-uiRecord',
      readyMessage: 'Started Recording Successfully',
      readUiRecording: (options = {}) => readUiRecording({ serial: targetSerial, ...options }),
      readUiRecordingLayouts: (output, options = {}) =>
        readUiRecordingLayouts(output, { serial: targetSerial, ...options }),
    };
  }

  async function recoverUiRecording({ serial: targetSerial } = {}) {
    await stopActiveUiRecorder();
    await readUiRecording({ serial: targetSerial, timeoutMs: 3000 }).catch(() => '');
    await wait(300);
  }

  async function stopActiveUiRecorder() {
    const child = activeUiRecorder;
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin?.write('\u0003');
    } catch {
      // The process may already be closing.
    }
    try {
      child.kill('SIGINT');
    } catch {
      // The process may already be closing.
    }
    await waitForChildExit(child, 1000);
    if (activeUiRecorder === child && child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // The process may already be closing.
      }
      await waitForChildExit(child, 500);
    }
    if (activeUiRecorder === child) activeUiRecorder = null;
  }

  async function readUiRecording({ serial: targetSerial, timeoutMs = 15000 } = {}) {
    return hdcText(['shell', 'uitest', 'uiRecord', 'read'], {
      serial: targetSerial,
      timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  async function readUiRecordingLayouts(
    output,
    { serial: targetSerial, outputDir } = {},
  ) {
    if (!outputDir) return [];
    const remotePaths = parseUiRecordingLayoutPaths(output);
    const layouts = [];
    for (const [index, remoteFile] of remotePaths.entries()) {
      const actionIndex = layoutActionIndex(remoteFile, index + 1);
      const extension = remoteFile.toLowerCase().endsWith('.xml') ? 'xml' : 'json';
      const localFile = join(
        outputDir,
        `action-layout-${String(actionIndex).padStart(3, '0')}.${extension}`,
      );
      try {
        await targetCommand(['file', 'recv', remoteFile, localFile], {
          serial: targetSerial,
          timeoutMs: 15000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const content = await readFile(localFile, 'utf8');
        layouts.push({
          actionIndex,
          remoteFile,
          localFile,
          summary: summarizeRecordedLayout(content),
        });
      } catch (error) {
        layouts.push({
          actionIndex,
          remoteFile,
          localFile: null,
          summary: [],
          error: error.message,
        });
      }
    }
    return layouts;
  }

  async function launchPackage(packageName) {
    const { app, bundleName } = bundleForPackage(packageName);
    const launchInfo = await resolveLaunchInfo(app, bundleName);
    if (!launchInfo) {
      throw new Error(`无法从 bm dump 获取鸿蒙应用 ${bundleName} 的启动 Ability`);
    }
    return hdcText(
      [
        'shell',
        'aa',
        'start',
        '-a',
        launchInfo.abilityName,
        '-b',
        bundleName,
        '-m',
        launchInfo.moduleName,
      ],
      { timeoutMs: 20000 },
    );
  }

  async function getLaunchInfo(bundleName) {
    const output = await hdcText(['shell', 'bm', 'dump', '-n', bundleName], {
      timeoutMs: 30000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return parseBundleLaunchInfo(output);
  }

  async function resolveLaunchInfo(app, bundleName) {
    const nativeLaunch = await getLaunchInfo(bundleName).catch(() => null);
    if (nativeLaunch) return nativeLaunch;

    const configured = app?.harmonyLaunch;
    const moduleName = String(configured?.moduleName || '').trim();
    const abilityName = String(configured?.abilityName || '').trim();
    return moduleName && abilityName ? { moduleName, abilityName } : null;
  }

  async function startActivity({ packageName, activityName }) {
    if (!packageName || !activityName) {
      throw new Error('startActivity requires packageName and activityName');
    }

    const { app, bundleName } = bundleForPackage(packageName);
    const launchInfo = await resolveLaunchInfo(app, bundleName);
    if (!launchInfo) {
      throw new Error(`无法从 bm dump 获取鸿蒙应用 ${bundleName} 的启动 Ability`);
    }

    const requestedAbility =
      activityName.startsWith('.') || activityName.includes('.ui.')
        ? launchInfo.abilityName
        : activityName;
    return hdcText(
      [
        'shell',
        'aa',
        'start',
        '-a',
        requestedAbility,
        '-b',
        bundleName,
        '-m',
        launchInfo.moduleName,
      ],
      { timeoutMs: 20000 },
    );
  }

  async function forceStopPackage(packageName) {
    const { bundleName } = bundleForPackage(packageName);
    return hdcText(['shell', 'aa', 'force-stop', bundleName], { timeoutMs: 15000 });
  }

  async function uninstallPackage(packageName) {
    if (!packageName) throw new Error('uninstallPackage requires packageName');
    const { bundleName } = bundleForPackage(packageName);
    return hdcText(['shell', 'bm', 'uninstall', '-n', bundleName], {
      timeoutMs: 30000,
    });
  }

  async function keyevent(code) {
    return hdcText(['shell', 'uitest', 'uiInput', 'keyEvent', mapHarmonyKeyEvent(code)]);
  }

  async function swipe({ x1, y1, x2, y2, durationMs }) {
    const distance = Math.hypot(Number(x2) - Number(x1), Number(y2) - Number(y1));
    const duration = Math.max(50, Number(durationMs) || 300);
    const velocity = Math.min(40000, Math.max(200, Math.round((distance * 1000) / duration)));
    return hdcText([
      'shell',
      'uitest',
      'uiInput',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(velocity),
    ]);
  }

  async function tap({ x, y, centerX, centerY }) {
    const resolvedX = Number(x ?? centerX);
    const resolvedY = Number(y ?? centerY);
    if (!Number.isFinite(resolvedX) || !Number.isFinite(resolvedY)) {
      throw new Error('tap requires finite x/y coordinates');
    }
    return hdcText([
      'shell',
      'uitest',
      'uiInput',
      'click',
      String(Math.round(resolvedX)),
      String(Math.round(resolvedY)),
    ]);
  }

  async function longPress({ x, y }) {
    return hdcText([
      'shell',
      'uitest',
      'uiInput',
      'longClick',
      String(Math.round(x)),
      String(Math.round(y)),
    ]);
  }

  async function openUri({ uri, packageName }) {
    if (!uri) throw new Error('openUri requires uri');
    const { bundleName } = bundleForPackage(packageName || '');
    const args = ['shell', 'aa', 'start', '-U', String(uri)];
    if (bundleName && bundleName !== packageName) args.push('-b', bundleName);
    return hdcText(args, { timeoutMs: 20000 });
  }

  async function clearFocusedText() {
    await hdcText([
      'shell',
      'uitest',
      'uiInput',
      'keyEvent',
      String(HARMONY_KEYCODE_CTRL_LEFT),
      String(HARMONY_KEYCODE_A),
    ]);
    return hdcText([
      'shell',
      'uitest',
      'uiInput',
      'keyEvent',
      String(HARMONY_KEYCODE_DELETE),
    ]);
  }

  async function inputText(text, { clearExisting = false, x, y } = {}) {
    if (!String(text || '')) return '';
    if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
      await tap({ x: Number(x), y: Number(y) });
    }
    if (clearExisting) await clearFocusedText();
    return hdcText(['shell', 'uitest', 'uiInput', 'text', String(text)]);
  }

  async function inputKeyText(text, { clearExisting = false, clearCharacters = 48 } = {}) {
    const keyCodes = encodeHarmonyKeyText(text);
    if (!keyCodes.length) return '';

    if (clearExisting) await clearFocusedText();
    const args = ['shell', 'uinput', '-K'];
    for (const keyCode of keyCodes) {
      args.push('-d', String(keyCode), '-u', String(keyCode));
    }
    return hdcText(args, { timeoutMs: 30000 });
  }

  async function findResourceNode(resourceId) {
    const layout = await getUiLayout();
    const candidates = flattenHarmonyLayout(layout);
    return candidates.find((node) => {
      const attrs = node.attributes;
      return [attrs.id, attrs.key, attrs.resourceId, attrs.accessibilityId].some(
        (value) => String(value || '') === String(resourceId),
      );
    }) || null;
  }

  async function findUiNode({
    types = [],
    ids = [],
    keys = [],
    clickable,
    region,
    layout: providedLayout,
  } = {}) {
    const layout = providedLayout || (await getUiLayout());
    return findHarmonyUiNodeInLayout(layout, {
      types,
      ids,
      keys,
      clickable,
      region,
    });
  }

  async function findTextNode(texts, { partial = false, region } = {}) {
    const layout = await getUiLayout();
    const candidates = flattenHarmonyLayout(layout);
    const expected = Array.isArray(texts) ? texts : [texts];

    return (
      candidates.find((node) => {
        const values = node.textValues;
        const matches = expected.some((candidate) =>
          values.some((value) => {
            if (candidate instanceof RegExp) return candidate.test(value);
            return partial ? value.includes(String(candidate)) : value === String(candidate);
          }),
        );
        return matches && (!region || isPointInRegion(node.centerX, node.centerY, region));
      }) || null
    );
  }

  async function tapResource(resourceId, { optional = false } = {}) {
    let node;
    try {
      node = await findResourceNode(resourceId);
    } catch (error) {
      if (optional) return '';
      throw error;
    }
    if (!node) {
      if (optional) return '';
      throw new Error(`resource not found: ${resourceId}`);
    }
    return tap(node);
  }

  async function tapText(texts, { optional = false, partial = false } = {}) {
    let node;
    try {
      node = await findTextNode(texts, { partial });
    } catch (error) {
      if (optional) return '';
      throw error;
    }
    if (!node) {
      if (optional) return '';
      const label = Array.isArray(texts) ? texts.join('/') : texts;
      throw new Error(`text not found: ${label}`);
    }
    return tap(node);
  }

  async function tapTextInRegion(texts, { optional = false, partial = false, region } = {}) {
    let node;
    try {
      node = await findTextNode(texts, { partial, region });
    } catch (error) {
      if (optional) return '';
      throw error;
    }
    if (!node) {
      if (optional) return '';
      const label = Array.isArray(texts) ? texts.join('/') : texts;
      throw new Error(`text not found in region: ${label}`);
    }
    return tap(node);
  }

  async function assertNoSensitivePrompt() {
    const snapshot = await getUiTextSnapshot();
    const text = snapshot.text || '';
    if (/[Cc]aptcha|[Vv]erification|\u6ed1\u5757|\u4eba\u673a\u9a8c\u8bc1/.test(text)) {
      throw new Error('检测到安全验证或人机验证，不能自动绕过');
    }

    const hasAgreement = /\u7528\u6237\u534f\u8bae|\u9690\u79c1|\u670d\u52a1\u534f\u8bae|\u6743\u9650\u8bf4\u660e|[Pp]rivacy|[Tt]erms/.test(
      text,
    );
    const hasDecision = /\u540c\u610f|\u63a5\u53d7|\u5141\u8bb8|\u6388\u6743|[Aa]gree|[Aa]llow|[Aa]ccept/.test(
      text,
    );
    if (!hasAgreement || !hasDecision) return '';

    const decisionNode = await findTextNode(
      [
        '\u540c\u610f\u5e76\u7ee7\u7eed',
        '\u540c\u610f',
        '\u63a5\u53d7',
        '\u5141\u8bb8',
        '\u6388\u6743',
        'Agree',
        'Allow',
        'Accept',
      ],
      { partial: true },
    );
    if (!decisionNode) throw new Error('检测到协议或权限弹窗，但未找到明确的同意按钮');
    await tap(decisionNode);
    return '';
  }

  async function getUiTextSnapshot(options = {}) {
    const request =
      options && typeof options === 'object' && !Array.isArray(options)
        ? options
        : {};
    const layout = await getUiLayout(request.serial, request);
    const values = [];
    for (const node of flattenHarmonyLayout(layout)) {
      for (const value of node.textValues) {
        if (value && !values.includes(value)) values.push(value);
      }
    }
    return {
      text: values.join('\n'),
      values,
      layout,
      xml: '',
    };
  }

  async function screenshotPng() {
    const targetSerial = await resolveSerial();
    const localRoot = await mkdtemp(join(tmpdir(), 'android-controller-hdc-'));
    const localFile = join(localRoot, 'screen.png');
    try {
      await targetCommand(['shell', 'uitest', 'screenCap', '-p', remoteScreenFile], {
        serial: targetSerial,
        timeoutMs: 20000,
      });
      await targetCommand(['file', 'recv', remoteScreenFile, localFile], {
        serial: targetSerial,
        timeoutMs: 20000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return await readFile(localFile);
    } finally {
      await rm(localRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    listTargets,
    hdcText,
    getDeviceStatus,
    getInstalledPackages,
    getCurrentFocus,
    getScreenSize,
    getDisplayOrientation,
    getMediaPlaybackState,
    forceStopPackage,
    uninstallPackage,
    launchPackage,
    startUiRecording,
    readUiRecording,
    recoverUiRecording,
    startActivity,
    keyevent,
    openUri,
    swipe,
    tap,
    longPress,
    tapText,
    tapTextInRegion,
    assertNoSensitivePrompt,
    inputText,
    inputKeyText,
    tapResource,
    findResourceNode,
    findTextNode,
    findUiNode,
    getUiTextSnapshot,
    screenshotPng,
    setTargetSerial,
  };
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once?.('exit', onExit);
    child.once?.('close', onExit);
  });
}

function summarizeRecordedLayout(output) {
  try {
    return flattenHarmonyLayout(parseHarmonyLayout(output))
      .map((node) => ({
        text: node.textValues[0] || '',
        id: String(
          node.attributes.id ||
          node.attributes.resourceId ||
          node.attributes.key ||
          '',
        ),
        type: String(
          node.attributes.type ||
          node.attributes.className ||
          node.attributes.componentType ||
          '',
        ),
        bounds: node.bounds,
      }))
      .filter((node) => node.text || node.id || node.type)
      .slice(0, 100);
  } catch {
    return [];
  }
}

export function findHarmonyUiNodeInLayout(
  layout,
  {
    types = [],
    ids = [],
    keys = [],
    clickable,
    region,
  } = {},
) {
  const candidates = flattenHarmonyLayout(layout);
  const expectedTypes = normalizeExpectedValues(types);
  const expectedIds = normalizeExpectedValues(ids);
  const expectedKeys = normalizeExpectedValues(keys);

  return candidates.find((node) => {
    const attrs = node.attributes;
    if (
      expectedTypes.length &&
      ![attrs.type, attrs.className, attrs.componentType].some((value) =>
        matchesExpectedValue(value, expectedTypes),
      )
    ) {
      return false;
    }
    if (
      expectedIds.length &&
      ![attrs.id, attrs.resourceId, attrs.accessibilityId].some((value) =>
        matchesExpectedValue(value, expectedIds),
      )
    ) {
      return false;
    }
    if (expectedKeys.length && !matchesExpectedValue(attrs.key, expectedKeys)) {
      return false;
    }
    const actualClickable =
      attrs.clickable === true || String(attrs.clickable) === 'true';
    if (typeof clickable === 'boolean' && actualClickable !== clickable) {
      return false;
    }
    if (region && !isPointInRegion(node.centerX, node.centerY, region)) {
      return false;
    }
    return true;
  }) || null;
}

export function layoutActionIndex(path, fallback) {
  const source = String(path || '');
  const trailingAction = source.match(
    /(?:^|[_-])(\d+)\.(?:json|xml)$/i,
  );
  const trailingCandidate = Number(trailingAction?.[1]);
  if (Number.isInteger(trailingCandidate) && trailingCandidate > 0) {
    return trailingCandidate;
  }
  const matches = [
    ...source.matchAll(
      /(?:action|step|layout)[_-]?(?:action[_-]?)?(\d+)(?=\D|$)/gi,
    ),
  ];
  const candidate = Number(matches.at(-1)?.[1]);
  return Number.isInteger(candidate) && candidate > 0 ? candidate : fallback;
}

function normalizeExpectedValues(values) {
  if (!values) return [];
  return Array.isArray(values) ? values : [values];
}

function matchesExpectedValue(value, expectedValues) {
  const actual = String(value || '');
  return expectedValues.some((expected) =>
    expected instanceof RegExp ? expected.test(actual) : actual === String(expected),
  );
}

function parseHdcJson(output) {
  const source = String(output || '');
  const firstBrace = source.indexOf('{');
  const lastBrace = source.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;

  try {
    return JSON.parse(source.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function splitHarmonyAbilityRecords(output) {
  const source = String(output || '');
  const matches = [...source.matchAll(/^\s*AbilityRecord\b[^\r\n]*/gim)];
  if (!matches.length) return [source];

  return matches.map((match, index) => {
    const start = match.index;
    const end = matches[index + 1]?.index ?? source.length;
    return source.slice(start, end);
  });
}

function splitHarmonyMissionRecords(output) {
  const source = String(output || '');
  const matches = [...source.matchAll(/^\s*Mission ID #\d+[^\r\n]*/gim)];
  if (!matches.length) return [];

  return matches.map((match, index) => {
    const start = match.index;
    const end = matches[index + 1]?.index ?? source.length;
    return source.slice(start, end);
  });
}

function matchBracketValue(source, pattern) {
  return source.match(pattern)?.[1]?.trim() || '';
}

function matchLineValue(source, pattern) {
  return source.match(pattern)?.[1]?.trim() || '';
}

function parseHarmonyLayout(output) {
  const source = String(output || '').trim();
  try {
    return JSON.parse(source);
  } catch {
    const firstBrace = source.indexOf('{');
    const lastBrace = source.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      throw new Error('鸿蒙 UI 布局不是有效 JSON');
    }
    return JSON.parse(source.slice(firstBrace, lastBrace + 1));
  }
}

function flattenHarmonyLayout(layout) {
  const nodes = [];

  function visit(node) {
    if (!node || typeof node !== 'object') return;
    const attributes =
      node.attributes && typeof node.attributes === 'object'
        ? node.attributes
        : node.attrs && typeof node.attrs === 'object'
          ? node.attrs
          : node;
    const bounds = parseNodeBounds(attributes);
    if (bounds) {
      const textValues = [
        attributes.text,
        attributes.originalText,
        attributes.description,
        attributes.contentDescription,
        attributes['content-desc'],
        attributes.hint,
        attributes.label,
      ]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      nodes.push({
        attributes,
        bounds,
        centerX: Math.round((bounds.x1 + bounds.x2) / 2),
        centerY: Math.round((bounds.y1 + bounds.y2) / 2),
        textValues,
        raw: node,
      });
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  }

  visit(layout);
  return nodes;
}

function parseNodeBounds(attributes) {
  const rawBounds = attributes.bounds ?? attributes.rect ?? attributes.frame;
  if (typeof rawBounds === 'string') {
    const match = rawBounds.match(
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

  if (rawBounds && typeof rawBounds === 'object') {
    const x1 = Number(rawBounds.x1 ?? rawBounds.left ?? rawBounds.x ?? 0);
    const y1 = Number(rawBounds.y1 ?? rawBounds.top ?? rawBounds.y ?? 0);
    const x2 = Number(rawBounds.x2 ?? rawBounds.right ?? x1 + Number(rawBounds.width || 0));
    const y2 = Number(rawBounds.y2 ?? rawBounds.bottom ?? y1 + Number(rawBounds.height || 0));
    if (x2 > x1 && y2 > y1) return { x1, y1, x2, y2 };
  }

  return null;
}

function isPointInRegion(x, y, region) {
  const minX = Number(region.minX ?? region.x1 ?? 0);
  const minY = Number(region.minY ?? region.y1 ?? 0);
  const maxX = Number(region.maxX ?? region.x2 ?? Number.POSITIVE_INFINITY);
  const maxY = Number(region.maxY ?? region.y2 ?? Number.POSITIVE_INFINITY);
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

function extractHarmonyVersion(value) {
  const source = String(value || '').trim();
  return source.match(/\d+(?:\.\d+){2,3}(?:\([^)]+\))?/)?.[0] || source;
}
