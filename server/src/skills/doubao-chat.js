const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 8 * 1000;
const MAX_DURATION_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 3 * 1000;

const DEFAULT_MESSAGES = [
  'Tell me an interesting fact about space.',
  'Give me one simple productivity tip.',
  'Recommend a relaxing weekend activity.',
  'Explain a common science concept simply.',
  'Ask me a casual question.',
  'Share a short idea for learning English.',
  'What is one healthy habit I can try today?',
  'Tell me a brief story in three sentences.',
  'Give me one tip for staying focused.',
  'Ask me one question about my day.',
  'Share one quick fact about animals.',
  'Suggest one easy way to organize notes.',
  'Give me one short idea for dinner.',
  'Ask me a simple question about books.',
  'Explain one useful English phrase.',
  'Share one tip for better sleep.',
  'Tell me one fact about the ocean.',
  'Give me one idea for a five minute break.',
  'Ask me one question about music.',
  'Share one short tip for writing clearly.',
  'Tell me one fact about history.',
  'Suggest one small habit for a tidy room.',
  'Ask me one question about travel.',
  'Give me one short tip for time management.',
  'Explain one everyday technology simply.',
  'Share one idea for reducing stress.',
  'Tell me one fact about plants.',
  'Ask me one question about learning.',
  'Give me one brief tip for making decisions.',
  'Share one idea for weekend exercise.',
  'Tell me one fact about the human body.',
  'Ask me one simple question about food.',
  'Give me one short tip for teamwork.',
  'Explain one common science word.',
  'Share one small goal for today.',
  'Tell me one fact about art.',
  'Ask me one question about hobbies.',
  'Give me one brief tip for reading more.',
  'Share one easy way to practice English.',
  'Tell me one fact about weather.',
  'Ask me one question about creativity.',
  'Give me one short reminder to drink water.',
  'Explain one common idiom in simple words.',
  'Share one idea for a calm evening.',
  'Tell me one fact about computers.',
  'Ask me one question about movies.',
  'Give me one brief tip for remembering tasks.',
  'Share one positive sentence about patience.',
];

export function buildDoubaoChatPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  messages = DEFAULT_MESSAGES,
}) {
  if (!app?.packageName) {
    throw new Error('Doubao chat skill requires an app packageName');
  }
  const resources = app.skillConfig?.resources || {};
  if (!resources.input || !resources.send) {
    throw new Error('Doubao chat skill requires input and send resource ids in app.skillConfig.resources');
  }

  const safeDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));
  const safeInterval = Math.max(MIN_INTERVAL_MS, Math.min(intervalMs, safeDuration));
  const sourceMessages = Array.isArray(messages) ? messages : DEFAULT_MESSAGES;
  const safeMessages = sourceMessages.map(sanitizeEnglishMessage).filter(Boolean);
  if (safeMessages.length === 0) {
    throw new Error('Doubao chat skill requires at least one safe English message');
  }

  const steps = [
    { type: 'launch_app', packageName: app.packageName, label: '打开豆包' },
    { type: 'wait', ms: 3000, label: '等待豆包加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
  ];
  if (resources.closeButton) {
    steps.push({ type: 'tap_resource', resourceId: resources.closeButton, optional: true, label: '关闭可能出现的弹窗' });
  }

  let elapsed = 3000;
  let index = 0;

  while (elapsed < safeDuration) {
    const message = safeMessages[index % safeMessages.length];
    steps.push({ type: 'tap_resource', resourceId: resources.input, label: '点击豆包输入框' });
    steps.push({ type: 'input_text', text: message, label: `输入: ${message}` });
    steps.push({ type: 'tap_resource', resourceId: resources.send, label: '发送消息' });

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
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}
