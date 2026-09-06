import { config } from '../config.js';

const DEFAULT_SCREEN = { width: config.screen.defaultWidth, height: config.screen.defaultHeight };
const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 8 * 1000;
const MAX_DURATION_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 3 * 1000;

const DEFAULT_MESSAGES = [
  'FACT',
  'JOKE',
  'PRODUCTIVITY',
  'RELAXATION',
  'SCIENCE',
  'QUESTION',
  'ENGLISH',
  'HEALTH',
  'STORY',
  'FOCUS',
  'ANIMALS',
  'NOTES',
  'DINNER',
  'BOOKS',
  'PHRASE',
  'SLEEP',
  'OCEAN',
  'BREAK',
  'MUSIC',
  'WRITING',
  'HISTORY',
  'TIDY',
  'TRAVEL',
  'TIME',
  'TECHNOLOGY',
  'STRESS',
  'PLANTS',
  'LEARNING',
  'DECISIONS',
  'EXERCISE',
  'BODY',
  'FOOD',
  'TEAMWORK',
  'GOAL',
  'ART',
  'HOBBIES',
  'READING',
  'WEATHER',
  'CREATIVITY',
  'WATER',
  'IDIOM',
  'EVENING',
  'COMPUTERS',
  'MOVIES',
  'TASKS',
  'PATIENCE',
  'SPACE',
  'HABITS',
];

export function buildDoubaoChatPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  messages = DEFAULT_MESSAGES,
  platform = 'android',
  screen = DEFAULT_SCREEN,
}) {
  if (!app?.packageName) {
    throw new Error('Doubao chat skill requires an app packageName');
  }

  const harmonyMode = platform === 'harmony';
  const resources = app.skillConfig?.resources || {};
  if (!harmonyMode && (!resources.input || !resources.send)) {
    throw new Error('Doubao chat skill requires input and send resource ids in app.skillConfig.resources');
  }

  const safeDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));
  const safeInterval = Math.max(MIN_INTERVAL_MS, Math.min(intervalMs, safeDuration));
  const sourceMessages = Array.isArray(messages) && messages.length > 0 ? messages : DEFAULT_MESSAGES;
  const safeMessages = sourceMessages.map(sanitizeEnglishMessage).filter(Boolean);
  if (safeMessages.length === 0) {
    throw new Error('Doubao chat skill requires at least one safe English message');
  }

  const size = {
    width: Number(screen.width) || DEFAULT_SCREEN.width,
    height: Number(screen.height) || DEFAULT_SCREEN.height,
  };
  const inputX = Math.round(size.width * 0.5);
  const inputY = Math.round(size.height * 0.935);
  const sendX = Math.round(size.width * 0.877);
  const sendY = Math.round(size.height * 0.549);

  const steps = [
    { type: 'launch_app', packageName: app.packageName, label: '打开豆包' },
    { type: 'wait', ms: 3000, label: '等待豆包加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'tap_text',
      texts: ['稍后', '取消', '暂不', '跳过', '我知道了'],
      optional: true,
      partial: true,
      label: '关闭非必要提示',
    },
    { type: 'assert_foreground_package', packageName: app.packageName, label: '确认仍在豆包' },
    { type: 'start_capture', label: '开始采集豆包对话内容' },
  ];

  let elapsed = 3000;
  let index = 0;

  while (elapsed < safeDuration) {
    const message = safeMessages[index % safeMessages.length];
    if (harmonyMode) {
      steps.push({ type: 'tap', x: inputX, y: inputY, label: '聚焦豆包输入框' });
      steps.push({ type: 'wait', ms: 500, label: '等待鸿蒙键盘弹出' });
      steps.push({
        type: 'input_key_text',
        text: message,
        clearExisting: true,
        clearCharacters: 48,
        label: `通过 HDC 输入: ${message}`,
      });
      steps.push({ type: 'wait', ms: 250, label: '等待输入框更新' });
      steps.push({ type: 'tap', x: sendX, y: sendY, label: '点击豆包发送按钮' });
      steps.push({
        type: 'assert_screen_changes',
        intervalMs: Math.min(3000, safeInterval),
        minDiffRatio: 0.0003,
        label: '确认豆包已发送并开始回复',
      });
    } else {
      steps.push({ type: 'tap_resource', resourceId: resources.input, label: '点击豆包输入框' });
      steps.push({ type: 'input_text', text: message, label: `输入: ${message}` });
      steps.push({ type: 'tap_resource', resourceId: resources.send, label: '发送消息' });
    }

    const waitMs = Math.min(safeInterval, safeDuration - elapsed);
    if (waitMs > 0) {
      steps.push({
        type: 'wait_for_screen_idle',
        minMs: Math.min(MIN_INTERVAL_MS, waitMs),
        maxMs: waitMs,
        pollMs: 1000,
        stablePolls: 2,
        label: `等待回复完成，最多 ${Math.round(waitMs / 1000)} 秒`,
      });
      elapsed += waitMs;
    }

    index += 1;
  }

  steps.push({ type: 'complete', label: '豆包英文聊天完成' });
  return steps;
}

function sanitizeEnglishMessage(message) {
  return String(message || '')
    .toUpperCase()
    .match(/[A-Z0-9]+/)?.[0]
    ?.slice(0, 24) || '';
}
