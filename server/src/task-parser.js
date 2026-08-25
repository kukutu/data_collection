import { findAppByName } from './app-registry.js';

const SUPPORTED_LIVE_ENTRY_APP_IDS = new Set(['douyin', 'taobao', 'jd', 'wechat', 'xiaohongshu']);
const DEFAULT_AI_CHAT_INTERVAL_MS = 8 * 1000;

const CHINESE_DIGITS = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

export function parseTaskFallback(taskText, apps = []) {
  const text = String(taskText || '').trim();
  if (!text) return { intent: 'unknown', originalText: text };

  if (/^(返回|后退|退回)$/.test(text)) {
    return { intent: 'back' };
  }

  if (/回到桌面|返回桌面|打开桌面|主页|home/i.test(text)) {
    return { intent: 'home' };
  }

  const app = findAppByName(apps, text);
  const appName = app?.name || null;

  if (
    app?.id === 'wechat' &&
    /(视频号|微信号视频|微信视频)/.test(text) &&
    !/直播/.test(text) &&
    /(刷|浏览|看|观看|播放|进入|打开)/.test(text)
  ) {
    return {
      intent: 'wechat_channels_feed',
      appName,
      durationMs: parseDurationMs(text) ?? 5 * 60 * 1000,
    };
  }

  if (/豆包|doubao/i.test(text) && /(聊天|对话|聊|chat)/i.test(text)) {
    return {
      intent: 'doubao_chat',
      appName: appName || '豆包',
      durationMs: parseDurationMs(text) ?? 10 * 60 * 1000,
      intervalMs: parseSwitchIntervalMs(text) ?? DEFAULT_AI_CHAT_INTERVAL_MS,
      language: 'en',
      random: /随机|random/i.test(text),
    };
  }

  if (/直播/.test(text) && /(刷|浏览|看|观看|播放|切换|进入|打开)/.test(text) && appName) {
    if (!SUPPORTED_LIVE_ENTRY_APP_IDS.has(app?.id)) {
      return {
        intent: 'unsupported_flow',
        appName,
        reason: `${app.name}当前没有稳定可验证的直播入口，已从自动直播功能中移除。`,
      };
    }
    return {
      intent: 'live_entry',
      appName,
      durationMs: parseDurationMs(text) ?? 10 * 60 * 1000,
      switchIntervalMs: parseSwitchIntervalMs(text),
    };
  }

  if (app?.id === 'tencent-video' && /(看|观看|播放)/.test(text)) {
    return {
      intent: 'play_tencent_video',
      appName,
      durationMs: parseDurationMs(text) ?? 10 * 60 * 1000,
      openFirstAvailable: true,
    };
  }

  if (app?.id === 'amap' && /导航/.test(text)) {
    const destination = extractNavigationDestination(text);
    if (!destination) {
      return {
        intent: 'missing_parameter',
        appName,
        field: 'destination',
        message: '高德导航任务需要包含目的地，例如：高德地图导航到北京站',
      };
    }
    return {
      intent: 'amap_navigation',
      appName,
      destination,
      durationMs: parseDurationMs(text) ?? 5 * 60 * 1000,
    };
  }

  if (isInstalledGenericMediaApp(app) && /(刷|看|观看|播放)/.test(text)) {
    return {
      intent: 'play_generic_media',
      appName,
      durationMs: parseDurationMs(text) ?? 10 * 60 * 1000,
      openFirstAvailable: true,
    };
  }

  if (isAiChatApp(app) && /(聊天|对话|聊|提问|问|chat)/i.test(text)) {
    return {
      intent: 'ai_chat',
      appName,
      durationMs: parseDurationMs(text) ?? 10 * 60 * 1000,
      intervalMs: parseSwitchIntervalMs(text) ?? DEFAULT_AI_CHAT_INTERVAL_MS,
      language: 'en',
    };
  }

  const unsupportedReason = detectUnsupportedBusinessFlow(text, app);
  if (unsupportedReason) {
    return {
      intent: 'unsupported_flow',
      appName,
      reason: unsupportedReason,
    };
  }

  if (/(刷|浏览|看|观看|播放)/.test(text) && appName) {
    if (app.skill !== 'short_video_feed') {
      return {
        intent: 'unsupported_flow',
        appName,
        reason: `${app.name} 暂未实现真实可验证的自动浏览或播放 skill。`,
      };
    }
    return {
      intent: 'watch_feed',
      appName,
      durationMs: parseDurationMs(text) ?? 5 * 60 * 1000,
    };
  }

  if (/(打开|启动|进入|开启)/.test(text) && appName) {
    return { intent: 'launch_app', appName };
  }

  return { intent: 'unknown', originalText: text };
}

export function extractAppName(text, apps = []) {
  return findAppByName(apps, text)?.name || null;
}

function isInstalledGenericMediaApp(app) {
  return ['bilibili', 'youku'].includes(app?.id);
}

function isAiChatApp(app) {
  return ['qianwen'].includes(app?.id);
}

function detectUnsupportedBusinessFlow(text, app) {
  if (!app) return null;
  const source = String(text || '');

  if (/(音视频通话|视频通话|语音通话|通话|电话|VoIP)/i.test(source)) {
    return '音视频通话需要明确测试联系人或测试账号，当前不作为可自动执行功能。';
  }

  if (/(会议|入会|开会|加入会议)/.test(source)) {
    return '会议业务需要明确会议号和真实入会确认，当前不作为可自动执行功能。';
  }

  if (/(看票|查票|票务|演出|车票|火车票|抢票|购票|买票)/.test(source)) {
    return '票务业务需要具体车次、场次或订单目标，当前不作为可自动执行功能。';
  }

  if (/(出行|交通|公交|地铁|打车|骑行|单车|叫车|行程)/.test(source)) {
    return '出行业务需要具体路线、乘车码或订单目标，当前仅保留高德导航。';
  }

  if (/(玩|游戏|对战|匹配|挂机)/.test(source) && (app.categories || []).includes('游戏')) {
    return '游戏业务需要真实开局或对战流程，当前不把启动停留算作可用功能。';
  }

  if (/(下载|上传|传输|网盘|更新)/.test(source) && (app.categories || []).includes('上传下载')) {
    return '上传下载业务需要真实文件或下载目标，当前不把入口停留算作可用功能。';
  }

  return null;
}

export function parseDurationMs(text) {
  const source = String(text || '').replace(
    /(?:每|间隔|隔)\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)?\s*(小时|分钟|秒)/g,
    '',
  );
  let total = 0;

  for (const match of source.matchAll(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)\s*(小时|分钟|秒)/g)) {
    const amount = parseAmount(match[1]);
    if (amount == null) continue;
    total += amountToMs(amount, match[2]);
  }

  return total > 0 ? Math.round(total) : null;
}

export function parseSwitchIntervalMs(text) {
  const source = String(text || '');
  const match = source.match(/(?:每|间隔|隔)\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)?\s*(小时|分钟|秒)/);
  if (!match) return null;

  const amount = parseAmount(match[1] || '一');
  if (amount == null) return null;
  return Math.round(amountToMs(amount, match[2]));
}

export function extractNavigationDestination(text) {
  const source = String(text || '')
    .replace(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)\s*(小时|分钟|秒)/g, '')
    .trim();
  const match = source.match(/(?:导航到|导航去|去往|前往|到)([^，。,.！？!\s]+)$/);
  if (!match) return null;

  const destination = match[1]
    .replace(/^(高德地图|高德|地图)/, '')
    .replace(/导航$/, '')
    .trim();
  return destination || null;
}

function parseAmount(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === '半') return 0.5;
  return parseChineseNumber(raw);
}

function parseChineseNumber(value) {
  const text = String(value || '').replace(/两/g, '二');
  if (!text) return null;
  if (text === '半') return 0.5;

  if (text.includes('百')) {
    const [hundreds, rest = ''] = text.split('百');
    const hundredValue = hundreds ? parseChineseNumber(hundreds) : 1;
    const restValue = rest ? parseChineseNumber(rest) : 0;
    return hundredValue == null || restValue == null ? null : hundredValue * 100 + restValue;
  }

  if (text.includes('十')) {
    const [tens, ones = ''] = text.split('十');
    const tenValue = tens ? parseChineseNumber(tens) : 1;
    const oneValue = ones ? parseChineseNumber(ones) : 0;
    return tenValue == null || oneValue == null ? null : tenValue * 10 + oneValue;
  }

  if (text.length === 1) {
    return CHINESE_DIGITS[text] ?? null;
  }

  const digits = [...text].map((char) => CHINESE_DIGITS[char]);
  if (digits.some((digit) => digit == null)) return null;
  return Number(digits.join(''));
}

function amountToMs(amount, unit) {
  if (unit === '小时') return amount * 60 * 60 * 1000;
  if (unit === '分钟') return amount * 60 * 1000;
  return amount * 1000;
}
