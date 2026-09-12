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

export function buildXiaoyiChatPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  messages = DEFAULT_MESSAGES,
  platform = 'android',
  screen = DEFAULT_SCREEN,
}) {
  if (!app?.packageName) {
    throw new Error('Xiaoyi chat skill requires an app packageName');
  }
  if (platform !== 'harmony') {
    throw new Error('Xiaoyi chat skill currently requires a Harmony device');
  }

  const resources = app.skillConfig?.resources || {};
  if (!resources.input || !resources.send) {
    throw new Error('Xiaoyi chat skill requires input and send resource ids');
  }

  const safeDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));
  const safeInterval = Math.max(MIN_INTERVAL_MS, Math.min(intervalMs, safeDuration));
  const safeMessages = normalizeMessages(messages);
  const size = normalizeScreen(screen);
  const steps = [
    {
      type: 'manual_confirm',
      label: '等待用户进入小艺文字聊天页',
      message: '请在手机上手动进入小艺文字聊天页面，然后在前端点击“我已进入，继续”。',
      confirmLabel: '我已进入，继续',
    },
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      message: '当前未停留在小艺，请手动进入小艺文字聊天页面后重新执行。',
      label: '确认当前前台为小艺',
    },
    {
      type: 'assert_ui_node',
      ids: [resources.input],
      message: '当前不是小艺文字聊天页面，找不到消息输入框。',
      label: '确认小艺文字聊天页已打开',
    },
    { type: 'start_capture', label: '开始采集小艺对话内容' },
  ];

  let elapsed = 0;
  let index = 0;
  while (elapsed < safeDuration) {
    const message = safeMessages[index % safeMessages.length];
    steps.push({
      type: 'send_ui_message',
      text: message,
      inputResourceId: resources.input,
      sendResourceId: resources.send,
      attempts: 3,
      focusWaitMs: 700,
      pollMs: 250,
      readyChecks: 8,
      confirmationChecks: 10,
      confirmOnEditorClear: true,
      label: `发送小艺消息: ${message}`,
    });
    steps.push({
      type: 'assert_screen_changes',
      intervalMs: Math.min(3000, safeInterval),
      minDiffRatio: 0.0003,
      label: '确认小艺已发送并开始回复',
    });

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

  steps.push({ type: 'complete', label: '小艺英文聊天完成' });
  return steps.map((step) => ({
    ...step,
    referenceScreen: step.referenceScreen || size,
  }));
}

function normalizeMessages(messages) {
  const source = Array.isArray(messages) && messages.length > 0 ? messages : DEFAULT_MESSAGES;
  const normalized = source.map(sanitizeEnglishMessage).filter(Boolean);
  if (!normalized.length) {
    throw new Error('Xiaoyi chat skill requires at least one safe English message');
  }
  return normalized;
}

function sanitizeEnglishMessage(message) {
  return (
    String(message || '')
      .toUpperCase()
      .match(/[A-Z0-9]+/)?.[0]
      ?.slice(0, 24) || ''
  );
}

function normalizeScreen(screen) {
  return {
    width: Number(screen?.width) || DEFAULT_SCREEN.width,
    height: Number(screen?.height) || DEFAULT_SCREEN.height,
  };
}
