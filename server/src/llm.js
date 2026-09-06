import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { config } from './config.js';
import { parseTaskFallback } from './task-parser.js';

const taskSchemaPath = fileURLToPath(new URL('task-schema.json', import.meta.url));

export async function parseTaskWithModel({ taskText, apiKey, apps }) {
  if (!apiKey) return parseTaskFallback(taskText, apps);

  const prompt = buildTaskParserPrompt({ taskText, apps });
  const response = await fetch(`${config.llm.baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.model,
      input: prompt,
      store: false,
      max_output_tokens: 300,
    }),
  });

  if (!response.ok) {
    throw new Error(`model request failed: ${response.status} ${await response.text()}`);
  }

  return parseModelJson(extractResponseText(await response.json()));
}

export async function parseTaskWithCodexCli({ taskText, apps, runCodex = runCodexExec }) {
  const prompt = buildTaskParserPrompt({ taskText, apps });
  return parseModelJson(await runCodex({ prompt }));
}

export function buildTaskParserPrompt({ taskText, apps }) {
  return [
    '你是 Android 手机控制任务解析器。',
    '只输出 JSON，不要输出 Markdown。',
    '允许的 intent: launch_app, watch_feed, watch_live, live_entry, play_tencent_video, play_generic_media, amap_navigation, wechat_channels_feed, wechat_send_messages, wechat_send_media, doubao_chat, ai_chat, back, home, missing_parameter, unsupported_flow, unknown。',
    'watch_feed 必须包含 appName 和 durationMs。',
    'watch_live 用于用户已在直播间内的被动观看和定时上滑切换，必须包含 appName、durationMs、switchIntervalMs、requiresCurrentLiveRoom: true。',
    'live_entry 用于从 App 首页进入直播入口并被动浏览，必须包含 appName、durationMs。',
    'play_tencent_video 用于腾讯视频，必须进入真实视频播放页，必须包含 appName: "腾讯视频"、durationMs、openFirstAvailable: true。',
    'play_generic_media 用于 B站、优酷等已安装长视频 App，必须包含 appName、durationMs、openFirstAvailable: true。',
    'amap_navigation 用于高德地图导航，必须包含 appName: "高德地图"、destination、durationMs。没有目的地时输出 missing_parameter，field 为 destination。',
    'wechat_channels_feed 用于微信视频号浏览，必须包含 appName: "微信"、durationMs。',
    'wechat_send_messages 用于进入微信聊天列表中的第一个会话并循环发送内置测试消息，必须包含 appName: "微信"、durationMs、intervalMs、targetMode: "first"。',
    'wechat_send_media 用于进入微信聊天列表中的第一个会话并循环发送媒体选择器中的第一项图片或视频，必须包含 appName: "微信"、targetMode: "first"、mediaIndex: 0、sendMode、sendCount、durationMs、intervalMs。按次数时 sendMode 为 "count"、sendCount 为正整数、durationMs 为 null；按时长时 sendMode 为 "duration"、durationMs 为正数、sendCount 为 null。',
    'doubao_chat 用于和豆包进行英文随机短句聊天，必须包含 appName: "豆包"、durationMs、intervalMs、language: "en"。',
    'ai_chat 用于和千问等已实现 AI 应用进行英文短句聊天，必须包含 appName、durationMs、intervalMs、language: "en"。',
    'For wechat_send_messages, wechat_send_media, doubao_chat and ai_chat, if the user does not specify an interval, set intervalMs to 8000. If the user specifies an interval below 3000, set intervalMs to 3000.',
    '涉及会议、音视频通话、票务、出行叫车/乘车、游戏对战、上传下载文件但没有真实目标参数和已实现 skill 时，输出 unsupported_flow，并包含 appName 和 reason。',
    'launch_app 必须包含 appName。',
    '禁止输出 shell、adb、坐标点击或任何自由文本命令。',
    '禁止把付款、支付、下单、提交订单、抢票、抢单、评论、私信、关注、点赞、打赏、验证码绕过解析为可执行意图。',
    '可用应用:',
    apps.map((app) => `${app.name}: ${(app.aliases || []).join('/')}`).join('\n'),
    `用户任务: ${taskText}`,
  ].join('\n');
}

export function parseModelJson(text) {
  const source = String(text || '').trim();
  if (!source) throw new Error('model returned empty response');

  try {
    return stripNullFields(JSON.parse(source));
  } catch {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return stripNullFields(JSON.parse(fenced[1].trim()));

    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start >= 0 && end > start) return stripNullFields(JSON.parse(source.slice(start, end + 1)));

    throw new Error(`model returned non-JSON response: ${source.slice(0, 200)}`);
  }
}

function stripNullFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
}

async function runCodexExec({ prompt }) {
  const tempDir = await mkdtemp(join(tmpdir(), 'android-task-parser-'));
  const outputPath = join(tempDir, 'last-message.txt');
  const args = buildCodexArgs({ outputPath });

  try {
    const result = await runProcess(config.codex.command, args, {
      input: prompt,
      timeoutMs: config.codex.timeoutMs,
    });
    const lastMessage = await readFile(outputPath, 'utf8').catch(() => '');
    return lastMessage.trim() || result.stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildCodexArgs({ outputPath }) {
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--output-schema',
    taskSchemaPath,
    '--output-last-message',
    outputPath,
  ];

  if (config.codex.model) args.push('-m', config.codex.model);
  args.push('-');
  return args;
}

function runProcess(command, args, { input, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnCommand(command, args, buildCodexEnv());
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      child.kill('SIGTERM');
      reject(new Error(`codex exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`codex exec failed with code ${code}: ${stderr || stdout}`.trim()));
    });

    child.stdin.end(input, 'utf8');
  });
}

function buildCodexEnv() {
  return {
    ...process.env,
    ...(config.codex.home ? { CODEX_HOME: config.codex.home } : {}),
  };
}

function spawnCommand(command, args, env) {
  if (process.platform !== 'win32') return spawn(command, args, { env, windowsHide: true });

  if (command.toLowerCase().endsWith('codex.cmd')) {
    const codexJs = join(dirname(command), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    return spawn(process.execPath, [codexJs, ...args], { env, windowsHide: true });
  }

  const commandLine = [command, ...args].map(quoteCmdArg).join(' ');
  return spawn('cmd.exe', ['/d', '/c', commandLine], { env, windowsHide: true });
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function extractResponseText(data) {
  if (typeof data.output_text === 'string') return data.output_text.trim();

  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) chunks.push(content.text);
      if (content.type === 'text' && content.text) chunks.push(content.text);
    }
  }
  return chunks.join('').trim();
}
