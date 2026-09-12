import { execFile, spawn } from 'node:child_process';

import { config } from './config.js';

const ADB = process.env.ADB_PATH || 'adb';
const AUTO_CONSENT_ATTEMPTS = 4;
const CONSENT_BUTTON_TEXTS = [
  '同意并继续',
  '同意并使用',
  '同意并进入',
  '接受并继续',
  '我已阅读并同意',
  '同意',
  '接受',
  '继续',
  '开始使用',
  '进入应用',
  '我知道了',
  '知道了',
];
const PERMISSION_BUTTON_TEXTS = [
  '仅使用期间允许',
  '使用应用时允许',
  '仅在使用该应用时允许',
  '允许',
  '始终允许',
];
const BLOCKED_VERIFICATION_PROMPT = /安全风险|安全验证|验证一下|快速验证|验证码|人机验证|滑块|拖动滑块|拼图验证/;

function execAdb(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      ADB,
      args,
      {
        encoding: options.encoding ?? 'utf8',
        timeout: options.timeoutMs ?? 15000,
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

export async function adbText(args, options) {
  const { stdout } = await execAdb(args, options);
  return String(stdout);
}

export async function listDevices() {
  const output = await adbText(['devices']);
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    });
}

export async function getDeviceStatus() {
  const devices = await listDevices();
  const active = devices.find((device) => device.state === 'device') || null;
  if (!active) {
    return {
      connected: false,
      provider: 'adb',
      platform: 'android',
      devices,
    };
  }

  const [model, focus, screen] = await Promise.all([
    adbText(['shell', 'getprop', 'ro.product.model']).then((value) => value.trim()).catch(() => ''),
    getCurrentFocus().catch(() => null),
    getScreenSize().catch(() => null),
  ]);

  return {
    connected: true,
    provider: 'adb',
    platform: 'android',
    serial: active.serial,
    model,
    focus,
    screen,
    devices,
  };
}

export async function getInstalledPackages() {
  return adbText(['shell', 'pm', 'list', 'packages'], { timeoutMs: 30000 });
}

export async function getCurrentFocus() {
  const output = await adbText(['shell', 'dumpsys', 'window'], { timeoutMs: 10000 });
  const candidates = [];
  for (const line of output.split(/\r?\n/)) {
    if (!/mCurrentFocus=|mFocusedApp=|mTopFullscreenOpaqueWindowState=/.test(line) || !line.includes('/')) {
      continue;
    }
    const match = line.match(/\s([a-zA-Z0-9_.]+)\/([^\s}]+)/);
    if (!match) continue;
    candidates.push({
      packageName: match[1],
      activity: normalizeActivityName(match[1], match[2]),
      raw: line.trim(),
    });
  }
  return candidates.at(-1) || null;
}

export async function getScreenSize() {
  const output = await adbText(['shell', 'wm', 'size']);
  const match = output.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

export async function getDisplayOrientation() {
  const output = await adbText(['shell', 'dumpsys', 'window'], { timeoutMs: 10000 });
  const rotationMatches = [...output.matchAll(/mDisplayRotation=ROTATION_(\d+)/g)];
  const rotation = rotationMatches.length ? Number(rotationMatches.at(-1)[1]) : null;
  return {
    rotation,
    isLandscape: rotation === 90 || rotation === 270,
    raw: rotationMatches.length ? rotationMatches.at(-1)[0] : '',
  };
}

export async function getMediaPlaybackState(packageName) {
  const output = await adbText(['shell', 'dumpsys', 'media_session'], {
    timeoutMs: 10000,
    maxBuffer: 5 * 1024 * 1024,
  });
  const blocks = output.split(/\n(?=\s{4}\S)/);
  const block = blocks.find((candidate) => candidate.includes(`package=${packageName}`)) || '';
  const stateMatch = block.match(/state=PlaybackState\s*\{state=([A-Z_]+)\((\d+)\)/);
  const active = /\bactive=true\b/.test(block);
  const stateName = stateMatch?.[1] || '';
  const stateCode = stateMatch ? Number(stateMatch[2]) : null;
  return {
    packageName,
    active,
    stateName,
    stateCode,
    isPlaying: active && stateCode === 3,
    raw: block.trim(),
  };
}

export async function launchPackage(packageName) {
  return adbText(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1']);
}

export async function startUiRecording() {
  const devices = await listDevices();
  const active = devices.find((device) => device.state === 'device');
  if (!active) throw new Error('未检测到可录制的 ADB 设备');

  const child = spawn(ADB, ['-s', active.serial, 'shell', 'getevent', '-lt'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    process: child,
    provider: 'adb',
    serial: active.serial,
    mode: 'getevent',
    readUiRecording: async () => '',
  };
}

export async function readUiRecording() {
  return '';
}

export async function startActivity({ packageName, activityName }) {
  if (!packageName || !activityName) throw new Error('startActivity requires packageName and activityName');
  return adbText(['shell', 'am', 'start', '-n', `${packageName}/${activityName}`], { timeoutMs: 20000 });
}

export async function forceStopPackage(packageName) {
  return adbText(['shell', 'am', 'force-stop', packageName]);
}

export async function uninstallPackage(packageName) {
  if (!packageName) throw new Error('uninstallPackage requires packageName');
  return adbText(['shell', 'pm', 'uninstall', packageName], { timeoutMs: 30000 });
}

export async function keyevent(code) {
  return adbText(['shell', 'input', 'keyevent', code]);
}

export async function swipe({ x1, y1, x2, y2, durationMs }) {
  return adbText([
    'shell',
    'input',
    'swipe',
    String(Math.round(x1)),
    String(Math.round(y1)),
    String(Math.round(x2)),
    String(Math.round(y2)),
    String(Math.round(durationMs)),
  ]);
}

export async function tap({ x, y }) {
  return adbText(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
}

export async function longPress({ x, y, durationMs = 800 }) {
  return adbText([
    'shell',
    'input',
    'swipe',
    String(Math.round(x)),
    String(Math.round(y)),
    String(Math.round(x)),
    String(Math.round(y)),
    String(Math.max(500, Math.round(durationMs))),
  ]);
}

export async function openUri({ uri, packageName }) {
  return adbText(buildOpenUriArgs({ uri, packageName }), { timeoutMs: 20000 });
}

export function buildOpenUriArgs({ uri, packageName }) {
  const args = [
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    quoteAndroidShellArg(uri),
  ];
  if (packageName) args.push(packageName);
  return args;
}

export async function inputText(text) {
  return adbText(['shell', 'input', 'text', encodeAdbInputText(text)]);
}

export async function tapResource(resourceId, { optional = false } = {}) {
  let node = null;
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
  return tap({ x: node.centerX, y: node.centerY });
}

export async function tapText(texts, { optional = false, partial = false } = {}) {
  let node = null;
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
  return tap({ x: node.centerX, y: node.centerY });
}

export async function tapTextInRegion(texts, { optional = false, partial = false, region } = {}) {
  let node = null;
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
  return tap({ x: node.centerX, y: node.centerY });
}

export async function assertNoSensitivePrompt() {
  for (let attempt = 0; attempt < AUTO_CONSENT_ATTEMPTS; attempt += 1) {
    let snapshot = null;
    try {
      snapshot = await getUiTextSnapshot();
    } catch (error) {
      const focus = await getCurrentFocus().catch(() => null);
      if (focus?.packageName === 'com.android.permissioncontroller') {
        throw new Error('检测到系统权限弹窗，但无法读取按钮，请先在手机上手动处理后再启动自动任务');
      }
      return '';
    }
    if (!snapshot.text) return '';

    if (BLOCKED_VERIFICATION_PROMPT.test(snapshot.text)) {
      throw new Error('检测到安全验证或人机验证，不能自动绕过，请先在手机上手动处理后再启动任务');
    }

    const hasAgreement = /用户协议|隐私政策|隐私协议|服务协议|个人信息|权限说明|隐私/.test(snapshot.text);
    const hasDecision = /同意并继续|同意|接受|授权|允许|不允许|不同意|始终允许|仅使用期间允许/.test(snapshot.text);
    const hasAndroidPermission = /要允许|允许.*访问|允许.*获取.*位置|访问.*位置权限|拍摄照片|录制视频|读取.*文件/.test(snapshot.text);

    if (hasAgreement && hasDecision) {
      if (await tapFirstTextFromSnapshot(snapshot, CONSENT_BUTTON_TEXTS)) {
        await sleep(800);
        continue;
      }
      throw new Error('检测到隐私协议弹窗，但未找到明确的同意按钮');
    }

    if (hasAndroidPermission) {
      if (await tapFirstTextFromSnapshot(snapshot, PERMISSION_BUTTON_TEXTS)) {
        await sleep(800);
        continue;
      }
      throw new Error('检测到系统权限弹窗，但未找到明确的允许按钮');
    }

    return '';
  }

  return '';
}

async function tapFirstTextFromSnapshot(snapshot, texts) {
  const node = findTextNodeInXml(snapshot.xml || '', texts, { partial: false });
  if (!node) return false;
  await tap({ x: node.centerX, y: node.centerY });
  return true;
}

export async function findResourceNode(resourceId) {
  const xml = await getUiXml();

  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const node = match[0];
    if (!node.includes(`resource-id="${resourceId}"`)) continue;
    const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
    return {
      resourceId,
      bounds: { x1, y1, x2, y2 },
      centerX: Math.round((x1 + x2) / 2),
      centerY: Math.round((y1 + y2) / 2),
      raw: node,
    };
  }

  return null;
}

export async function findTextNode(texts, { partial = false, region } = {}) {
  const xml = await getUiXml();
  return findTextNodeInXml(xml, texts, { partial, region });
}

export async function findUiNode({
  types = [],
  ids = [],
  keys = [],
  clickable,
  region,
} = {}) {
  const xml = await getUiXml();
  return findUiNodeInXml(xml, {
    types,
    ids,
    keys,
    clickable,
    region,
  });
}

export function findUiNodeInXml(
  xml,
  {
    types = [],
    ids = [],
    keys = [],
    clickable,
    region,
  } = {},
) {
  const expectedTypes = normalizeExpectedValues(types);
  const expectedIds = normalizeExpectedValues(ids);
  const expectedKeys = normalizeExpectedValues(keys);

  for (const match of String(xml || '').matchAll(/<node\b[^>]*>/g)) {
    const raw = match[0];
    const node = parseAndroidUiNode(raw);
    if (!node) continue;
    if (
      expectedTypes.length &&
      ![node.attributes.class, node.attributes.className, node.attributes.type].some(
        (value) => matchesExpectedValue(value, expectedTypes),
      )
    ) {
      continue;
    }
    if (
      expectedIds.length &&
      ![
        node.attributes['resource-id'],
        node.attributes.resourceId,
        node.attributes.id,
        node.attributes['accessibility-id'],
      ].some((value) => matchesExpectedValue(value, expectedIds))
    ) {
      continue;
    }
    if (
      expectedKeys.length &&
      ![node.attributes.key, node.attributes['content-desc']].some((value) =>
        matchesExpectedValue(value, expectedKeys),
      )
    ) {
      continue;
    }
    if (
      typeof clickable === 'boolean' &&
      parseBooleanAttr(node.attributes.clickable) !== clickable
    ) {
      continue;
    }
    if (region && !isPointInRegion(node.centerX, node.centerY, region)) continue;
    return node;
  }

  return null;
}

function findTextNodeInXml(xml, texts, { partial = false, region } = {}) {
  const candidates = Array.isArray(texts) ? texts : [texts];

  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const node = match[0];
    const text = getXmlAttr(node, 'text');
    const description = getXmlAttr(node, 'content-desc');
    const haystack = [text, description].filter(Boolean);
    const found = candidates.some((candidate) =>
      haystack.some((value) => (partial ? value.includes(candidate) : value === candidate)),
    );
    if (!found) continue;
    const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
    const centerX = Math.round((x1 + x2) / 2);
    const centerY = Math.round((y1 + y2) / 2);
    if (region && !isPointInRegion(centerX, centerY, region)) continue;
    return {
      texts: candidates,
      bounds: { x1, y1, x2, y2 },
      centerX,
      centerY,
      raw: node,
    };
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPointInRegion(x, y, region) {
  const minX = Number(region.minX ?? region.x1 ?? 0);
  const minY = Number(region.minY ?? region.y1 ?? 0);
  const maxX = Number(region.maxX ?? region.x2 ?? Number.POSITIVE_INFINITY);
  const maxY = Number(region.maxY ?? region.y2 ?? Number.POSITIVE_INFINITY);
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

function parseAndroidUiNode(raw) {
  const bounds = String(raw).match(
    /bounds="\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]"/,
  );
  if (!bounds) return null;
  const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
  const attributes = {};
  for (const match of String(raw).matchAll(/([A-Za-z0-9_:-]+)="([^"]*)"/g)) {
    attributes[match[1]] = decodeXml(match[2]);
  }
  return {
    attributes,
    bounds: { x1, y1, x2, y2 },
    centerX: Math.round((x1 + x2) / 2),
    centerY: Math.round((y1 + y2) / 2),
    raw,
  };
}

function normalizeExpectedValues(values) {
  if (!values) return [];
  return Array.isArray(values) ? values : [values];
}

function matchesExpectedValue(value, expectedValues) {
  const actual = String(value || '');
  return expectedValues.some((expected) => {
    if (!(expected instanceof RegExp)) return actual === String(expected);
    expected.lastIndex = 0;
    return expected.test(actual);
  });
}

function parseBooleanAttr(value) {
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

export async function getUiTextSnapshot() {
  const xml = await getUiXml();
  const values = [];
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const node = match[0];
    for (const attr of ['text', 'content-desc']) {
      const value = getXmlAttr(node, attr).trim();
      if (value) values.push(value);
    }
  }
  return {
    text: values.join('\n'),
    values,
    xml,
  };
}

export async function screenshotPng() {
  try {
    const { stdout } = await execAdb(['exec-out', 'screencap', '-p'], {
      encoding: 'buffer',
      timeoutMs: 15000,
      maxBuffer: 30 * 1024 * 1024,
    });
    return stdout;
  } catch (directError) {
    const remoteFile = '/sdcard/android-controller-screen.png';
    try {
      await adbText(['shell', 'screencap', '-p', remoteFile], { timeoutMs: 15000 });
      const { stdout } = await execAdb(['exec-out', 'cat', remoteFile], {
        encoding: 'buffer',
        timeoutMs: 15000,
        maxBuffer: 30 * 1024 * 1024,
      });
      return stdout;
    } catch (fallbackError) {
      throw new Error(`截图失败: ${fallbackError.message || directError.message}`);
    } finally {
      await adbText(['shell', 'rm', '-f', remoteFile], { timeoutMs: 5000 }).catch(() => '');
    }
  }
}

function encodeAdbInputText(text) {
  return String(text || '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/%/g, '%25')
    .replace(/\s/g, '%s')
    .replace(/([\\'";&|<>()[\]{}$`!*?])/g, '\\$1');
}

function quoteAndroidShellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function getUiXml() {
  let lastError = null;
  const dumpCommands = [
    ['shell', 'uiautomator', 'dump', '--compressed', config.adb.uiDumpRemoteFile],
    ['shell', 'uiautomator', 'dump', config.adb.uiDumpRemoteFile],
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const command of dumpCommands) {
      try {
        await adbText(command, { timeoutMs: 10000 });
        return await readRemoteTextFile(config.adb.uiDumpRemoteFile);
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError;
}

async function readRemoteTextFile(remoteFile) {
  try {
    return await adbText(['exec-out', 'cat', remoteFile], { timeoutMs: 10000 });
  } catch {
    return adbText(['shell', 'cat', remoteFile], { timeoutMs: 10000 });
  }
}

function getXmlAttr(node, name) {
  const match = node.match(new RegExp(`${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : '';
}

function decodeXml(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeActivityName(packageName, activity) {
  const value = String(activity || '');
  return value.startsWith('.') ? `${packageName}${value}` : value;
}

export const adb = {
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
  tapResource,
  findResourceNode,
  findTextNode,
  findUiNode,
  getUiTextSnapshot,
  screenshotPng,
};
