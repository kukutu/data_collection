import { config } from '../config.js';

const DEFAULT_SCREEN = { width: config.screen.defaultWidth, height: config.screen.defaultHeight };
const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 8 * 1000;
const MIN_INTERVAL_MS = 3 * 1000;
const MAX_INTERVAL_MS = 5 * 60 * 1000;

const DEFAULT_MESSAGES = [
  'Reply with one short English sentence about productivity.',
  'Ask one simple English question.',
  'Give one concise English learning tip.',
  'Share one quick tip for staying focused.',
  'Name one useful morning habit.',
  'Give one short idea for better planning.',
  'Ask a friendly question about today.',
  'Tell me one fact about technology.',
  'Suggest one calm activity after work.',
  'Give one short writing tip.',
  'Explain one common word in simple English.',
  'Share one idea for learning faster.',
  'Tell me one sentence about healthy sleep.',
  'Ask one question about hobbies.',
  'Give one brief reminder about taking breaks.',
  'Share one small goal for the next hour.',
  'Tell me one fact about science.',
  'Give one short tip for clear communication.',
  'Ask one simple question about food.',
  'Share one idea for organizing notes.',
  'Tell me one sentence about patience.',
  'Give one short tip for reading more.',
  'Ask one question about travel.',
  'Share one simple exercise idea.',
  'Tell me one fact about the ocean.',
  'Give one brief tip for saving time.',
  'Ask one friendly question about music.',
  'Share one idea for reducing stress.',
  'Tell me one sentence about teamwork.',
  'Give one short tip for learning English.',
  'Ask one simple question about books.',
  'Share one quick idea for a weekend plan.',
  'Tell me one fact about history.',
  'Give one brief tip for better focus.',
  'Ask one question about creativity.',
  'Share one small habit for a tidy desk.',
  'Tell me one sentence about curiosity.',
  'Give one short tip for making decisions.',
  'Ask one friendly question about movies.',
  'Share one idea for a simple meal.',
  'Tell me one fact about plants.',
  'Give one brief tip for remembering tasks.',
  'Ask one simple question about learning.',
];

export function buildAiChatPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  messages = DEFAULT_MESSAGES,
  screen = DEFAULT_SCREEN,
}) {
  if (!app?.packageName) {
    throw new Error('AI chat skill requires an app packageName');
  }

  const safeDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));
  const safeInterval = Math.max(MIN_INTERVAL_MS, Math.min(intervalMs, MAX_INTERVAL_MS));
  const size = {
    width: Number(screen.width) || DEFAULT_SCREEN.width,
    height: Number(screen.height) || DEFAULT_SCREEN.height,
  };
  const centerX = Math.round(size.width * 0.5);
  const inputY = Math.round(size.height * 0.92);
  const sendX = Math.round(size.width * 0.885);
  const sendY = Math.round(size.height * 0.593);
  const usableMessages = Array.isArray(messages) && messages.length > 0 ? messages : DEFAULT_MESSAGES;

  const steps = [
    { type: 'launch_app', packageName: app.packageName, label: `打开${app.name}` },
    { type: 'wait', ms: Math.min(5000, safeDuration), label: '等待 AI 应用加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'tap_text',
      texts: ['稍后', '取消', '暂不', '跳过', '我知道了'],
      optional: true,
      partial: true,
      label: '关闭非必要提示',
    },
  ];

  let elapsed = sumWaits(steps);
  let index = 0;
  while (elapsed < safeDuration) {
    const message = sanitizeMessage(usableMessages[index % usableMessages.length]);
    steps.push({ type: 'tap', x: centerX, y: inputY, label: '聚焦输入框' });
    steps.push({ type: 'input_text', text: message, label: '输入英文测试消息' });
    steps.push({ type: 'wait', ms: 300, label: '等待输入框更新' });
    steps.push({ type: 'tap', x: sendX, y: sendY, label: '点击千问发送按钮' });

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

  steps.push({ type: 'complete', label: `${app.name}AI 对话会话完成` });
  return steps;
}

function sanitizeMessage(message) {
  const text = String(message || '').replace(/[^\x20-\x7E]/g, '').trim();
  return text || DEFAULT_MESSAGES[0];
}

function sumWaits(steps) {
  return steps.filter((step) => step.type === 'wait').reduce((sum, step) => sum + step.ms, 0);
}
