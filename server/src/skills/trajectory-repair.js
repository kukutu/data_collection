import { config } from '../config.js';

const ALLOWED_TYPES = new Set([
  'tap',
  'long_press',
  'swipe',
  'keyevent',
  'input_text',
]);
const MAX_STEPS = 500;

export async function repairTrajectoryWithModel({
  trajectory,
  apiKey,
  model = config.llm.model,
  baseUrl = config.llm.baseUrl,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('模型纠正需要在前端填写 API Key');
  if (!trajectory?.steps?.length) throw new Error('轨迹为空，不能进行模型纠正');
  if (trajectory.steps.length > MAX_STEPS) {
    throw new Error(`轨迹动作过多，最多支持 ${MAX_STEPS} 步`);
  }
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持模型请求');

  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: buildTrajectoryRepairPrompt(trajectory),
      store: false,
      max_output_tokens: 2000,
    }),
  });

  if (!response.ok) {
    throw new Error(`model request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const result = parseTrajectoryRepairJson(extractResponseText(data));
  return {
    steps: validateRepairedSteps(result.steps),
    changes: sanitizeChanges(result.changes),
    confidence: clampConfidence(result.confidence),
  };
}

export function buildTrajectoryRepairPrompt(trajectory) {
  return [
    '你是移动端动作轨迹调试器。',
    '你只能处理用户已经录制的点击、滑动和按键轨迹，不能访问设备，也不能执行命令。',
    '在不改变用户原始意图的前提下，删除明显重复或异常的误触，修正不合理的手势持续时间和时间间隔，保留必要的动作顺序。',
    '不要凭空添加打开 App、等待、输入文字、读取控件、截图、录屏、抓包或任何 shell/adb/hdc 命令。',
    '输出只能包含 tap、long_press、swipe、keyevent、input_text 五种动作。input_text 只能保留输入轨迹中已经出现的文本或 {{参数名}} 占位符，不能凭空生成新内容。',
    '输入动作附带的 context 和录制前后 contexts 只用于判断控件和页面语义，输出中不要复制这些诊断字段。',
    '如果无法确定某一步是否误触，保留该步骤，不要擅自改成语义动作。',
    '只输出 JSON，不要输出 Markdown，格式必须是：',
    '{"steps":[{"type":"tap","x":100,"y":200,"delayMs":0}],"changes":["..."],"confidence":0.0}',
    '输入轨迹：',
    JSON.stringify({
      appName: trajectory.appName,
      featureName: trajectory.featureName,
      screen: trajectory.screen,
      steps: trajectory.steps.slice(0, MAX_STEPS),
      contexts: Array.isArray(trajectory.contexts)
        ? trajectory.contexts.slice(0, 10)
        : [],
    }),
  ].join('\n');
}

export function parseTrajectoryRepairJson(text) {
  const source = String(text || '').trim();
  if (!source) throw new Error('model returned empty response');

  try {
    return JSON.parse(source);
  } catch {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1].trim());

    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw new Error(`model returned non-JSON response: ${source.slice(0, 200)}`);
  }
}

export function validateRepairedSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('模型没有返回有效的修正版轨迹');
  }
  if (steps.length > MAX_STEPS) throw new Error(`模型返回动作过多，最多支持 ${MAX_STEPS} 步`);

  return steps.map((step, index) => {
    const type = String(step?.type || '').toLowerCase();
    if (!ALLOWED_TYPES.has(type)) {
      throw new Error(`模型返回了不支持的动作类型: ${type || `第 ${index + 1} 步`}`);
    }

    if (type === 'tap') {
      const x = finiteNumber(step.x);
      const y = finiteNumber(step.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`模型返回的点击坐标无效: 第 ${index + 1} 步`);
      }
      return { type, x: Math.round(x), y: Math.round(y), delayMs: normalizeDelay(step.delayMs) };
    }

    if (type === 'long_press') {
      const x = finiteNumber(step.x);
      const y = finiteNumber(step.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`模型返回的长按坐标无效: 第 ${index + 1} 步`);
      }
      return {
        type,
        x: Math.round(x),
        y: Math.round(y),
        durationMs: Math.min(
          40_000,
          Math.max(500, Math.round(finiteNumber(step.durationMs) || 800)),
        ),
        delayMs: normalizeDelay(step.delayMs),
      };
    }

    if (type === 'swipe') {
      const coordinates = ['x1', 'y1', 'x2', 'y2'].map((key) => finiteNumber(step[key]));
      if (coordinates.some((value) => !Number.isFinite(value))) {
        throw new Error(`模型返回的滑动坐标无效: 第 ${index + 1} 步`);
      }
      return {
        type,
        x1: Math.round(coordinates[0]),
        y1: Math.round(coordinates[1]),
        x2: Math.round(coordinates[2]),
        y2: Math.round(coordinates[3]),
        durationMs: Math.min(40_000, Math.max(50, Math.round(finiteNumber(step.durationMs) || 300))),
        delayMs: normalizeDelay(step.delayMs),
      };
    }

    if (type === 'input_text') {
      const text = String(step.text ?? '');
      if (!text) throw new Error(`模型返回的文本输入无效: 第 ${index + 1} 步`);
      return { type, text, delayMs: normalizeDelay(step.delayMs) };
    }

    const code = String(step.code || '').trim();
    if (!code) throw new Error(`模型返回的按键编码无效: 第 ${index + 1} 步`);
    return { type, code, delayMs: normalizeDelay(step.delayMs) };
  });
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if ((content.type === 'output_text' || content.type === 'text') && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join('').trim();
}

function sanitizeChanges(changes) {
  return Array.isArray(changes)
    ? changes.map((change) => String(change || '').trim()).filter(Boolean).slice(0, 20)
    : [];
}

function normalizeDelay(value) {
  return Math.min(5 * 60 * 1000, Math.max(0, Math.round(finiteNumber(value) || 0)));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function clampConfidence(value) {
  const number = finiteNumber(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : null;
}
