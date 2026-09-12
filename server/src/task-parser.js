import { findAppByName } from './app-registry.js';

const SUPPORTED_LIVE_ENTRY_APP_IDS = new Set([
  'douyin',
  'taobao',
  'jd',
  'wechat',
  'xiaohongshu',
  'kuaishou',
  'bilibili',
  'huya',
  'douyu',
  'weibo',
  'iqiyi',
  'yangshipin',
  'migu-video',
  'tencent-sports',
]);
const DEFAULT_AI_CHAT_INTERVAL_MS = 8 * 1000;
const DEFAULT_WECHAT_MESSAGE_INTERVAL_MS = 8 * 1000;
const DEFAULT_WECHAT_MEDIA_INTERVAL_MS = 8 * 1000;
const DEFAULT_WECHAT_MEDIA_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_WECHAT_CALL_DURATION_MS = 30 * 1000;
const DEFAULT_XUNLEI_MAGNET =
  'magnet:?xt=urn:btih:8C9F4DB08497563EF6EB01CF81199F645DA0954B';
const DEFAULT_APP_STORE_TARGET = '王者荣耀';

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

  if (/(应用市场|应用商店)/.test(text) && /(下载|安装)/.test(text)) {
    const target = findTargetApp(text, apps);
    return {
      intent: 'app_store_download',
      appName: apps.find((candidate) => candidate.id === 'app-store')?.name || '应用市场',
      targetApp: target?.name || DEFAULT_APP_STORE_TARGET,
      durationMs: parseDurationMs(text) ?? 30000,
    };
  }

  if (app?.id === 'xunlei' && /(下载|磁力|magnet)/i.test(text)) {
    return {
      intent: 'xunlei_download',
      appName,
      magnetUrl: text.match(/magnet:\?\S+/i)?.[0] || DEFAULT_XUNLEI_MAGNET,
      durationMs: parseDurationMs(text) ?? 30000,
    };
  }

  if (app?.id === 'xunlei' && /(上传|相册|云盘)/.test(text)) {
    return { intent: 'xunlei_upload_media', appName };
  }

  if (app?.id === 'baidu-netdisk' && /(下载|网盘)/.test(text)) {
    return {
      intent: 'baidu_netdisk_download',
      appName,
      durationMs: parseDurationMs(text) ?? 30000,
    };
  }
  if (app?.id === 'baidu-netdisk' && /上传/.test(text)) {
    return { intent: 'baidu_netdisk_upload', appName, mediaType: /文档/.test(text) ? 'document' : /视频/.test(text) ? 'video' : 'image' };
  }

  if (['dingtalk', 'wecom'].includes(app?.id) && /语音通话|音频通话|视频通话/.test(text) && !/音视频通话/.test(text)) {
    const video = /视频通话/.test(text);
    return { intent: app.id === 'wecom' ? 'wecom_voip_call' : 'dingtalk_voip_call', appName, targetMode: 'first', callType: video ? 'video' : 'audio',
      durationMs: parseDurationMs(text) ?? 30000,
      camera: video && /开启摄像头|开摄像头|摄像头开启/.test(text) && !/不开摄像头/.test(text),
      shareScreen: video && /共享屏幕/.test(text) && !/不共享屏幕|共享屏幕关闭/.test(text) };
  }

  if (app?.id === 'welink' && /语音通话|音频通话|视频通话/.test(text) && !/音视频通话/.test(text)) {
    const video = /视频通话/.test(text);
    return {
      intent: 'welink_voip_call',
      appName,
      targetMode: 'first',
      callType: video ? 'video' : 'audio',
      durationMs: parseDurationMs(text) ?? DEFAULT_WECHAT_CALL_DURATION_MS,
      camera: /开启视频|开视频|开启摄像头|开摄像头/.test(text),
      shareScreen: /共享屏幕/.test(text),
    };
  }

  if (app?.id === 'feishu' && /加入会议/.test(text)) {
    const meetingId = text.match(/(?:会议号|加入会议)\s*((?:\d[ -]?){8}\d)(?!\d)/)?.[1]?.replace(/[\s-]/g, '') || '';
    if (!meetingId) return { intent: 'missing_parameter', appName, field: 'meetingId', message: '请输入9位飞书会议号' };
    return { intent: 'feishu_join_meeting', appName, meetingId, durationMs: parseDurationMs(text) ?? 30000,
      camera: /开启摄像头|开摄像头|摄像头开启/.test(text) && !/不开摄像头/.test(text),
      shareScreen: /共享屏幕/.test(text) && !/不共享屏幕|共享屏幕关闭/.test(text) };
  }

  if (app?.id === 'feishu' && /快速会议|发起.*会议/.test(text) && !/加入会议/.test(text)) {
    return { intent: 'feishu_quick_meeting', appName, durationMs: parseDurationMs(text) ?? 30000,
      camera: /开启摄像头|开摄像头|摄像头开启/.test(text) && !/不开摄像头/.test(text),
      shareScreen: /共享屏幕/.test(text) && !/不共享屏幕|共享屏幕关闭/.test(text) };
  }

  if (app?.id === 'dingtalk' && /加入会议/.test(text)) {
    const meetingId = text.match(/(?:会议号|加入会议)\s*((?:\d[ -]?){9}\d)(?!\d)/)?.[1]?.replace(/[\s-]/g, '') || '';
    if (!meetingId) return { intent: 'missing_parameter', appName, field: 'meetingId', message: '请输入钉钉会议号' };
    return { intent: 'dingtalk_join_meeting', appName, meetingId, meetingType: 'video',
      durationMs: parseDurationMs(text) ?? 30000,
      camera: /开启摄像头|开摄像头|摄像头开启/.test(text) && !/不开摄像头/.test(text),
      shareScreen: /共享屏幕/.test(text) && !/不共享屏幕|共享屏幕关闭/.test(text) };
  }

  if (app?.id === 'dingtalk' && /快速会议|发起.*会议/.test(text) && !/加入会议/.test(text)) {
    const meetingType = /语音会议|类型audio/.test(text) ? 'audio' : 'video';
    return { intent: 'dingtalk_quick_meeting', appName, meetingType,
      durationMs: parseDurationMs(text) ?? 30000,
      camera: meetingType === 'video' && /开启摄像头|开摄像头|摄像头开启/.test(text) && !/不开摄像头/.test(text),
      shareScreen: /共享屏幕/.test(text) && !/不共享屏幕|共享屏幕关闭/.test(text) };
  }

  if (
    ['wechat', 'qq'].includes(app?.id) &&
    !/音视频通话/.test(text) &&
    /(音频通话|语音通话|视频通话)/.test(text)
  ) {
    return {
      intent: app.id === 'qq' ? 'qq_voip_call' : 'wechat_voip_call',
      appName,
      targetMode: 'first',
      callType: /视频通话/.test(text) ? 'video' : 'audio',
      durationMs: parseDurationMs(text) ?? DEFAULT_WECHAT_CALL_DURATION_MS,
    };
  }

  if (
    app?.id === 'wechat' &&
    /(发图|发送图片|发视频|发送视频|图片或视频|发图\/发视频)/.test(text)
  ) {
    const sendCount = parseSendCount(text);
    const durationMs = parseDurationMs(text);
    const sendMode =
      sendCount != null
        ? 'count'
        : durationMs != null || /循环|按时长/.test(text)
          ? 'duration'
          : 'count';
    return {
      intent: 'wechat_send_media',
      appName,
      targetMode: 'first',
      mediaIndex: 0,
      sendMode,
      sendCount: sendMode === 'count' ? sendCount ?? 1 : null,
      durationMs:
        sendMode === 'duration'
          ? durationMs ?? DEFAULT_WECHAT_MEDIA_DURATION_MS
          : null,
      intervalMs: parseSwitchIntervalMs(text) ?? DEFAULT_WECHAT_MEDIA_INTERVAL_MS,
    };
  }

  if (
    app?.id === 'wechat' &&
    /(发消息|发送消息|收发消息|循环发消息|循环发送消息)/.test(text)
  ) {
    return {
      intent: 'wechat_send_messages',
      appName,
      durationMs: parseDurationMs(text) ?? 5 * 60 * 1000,
      intervalMs: parseSwitchIntervalMs(text) ?? DEFAULT_WECHAT_MESSAGE_INTERVAL_MS,
      targetMode: 'first',
    };
  }

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

  if (app?.id === 'bilibili' && !/直播/.test(text) && /刷|短视频|竖屏|人工|手动/.test(text)) {
    return { intent: 'watch_feed', appName, durationMs: parseDurationMs(text) ?? 300000 };
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
  return ['ai_chat', 'deepseek_chat', 'qianwen_chat', 'xiaoyi_chat'].includes(app?.skill);
}

function findTargetApp(text, apps) {
  return apps
    .filter((candidate) => candidate.id !== 'app-store')
    .flatMap((candidate) =>
      [candidate.name, ...(candidate.aliases || [])]
        .filter(Boolean)
        .map((alias) => ({ app: candidate, alias: String(alias) })),
    )
    .filter(({ alias }) => String(text).includes(alias))
    .sort((left, right) => right.alias.length - left.alias.length)[0]?.app || null;
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

export function parseSendCount(text) {
  const source = String(text || '').replace(
    /(?:每|间隔|隔)\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)?\s*(?:小时|分钟|秒)\s*(?:发送|发)?\s*一次/g,
    '',
  );
  const match = source.match(
    /(?:发送|发)?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)\s*(?:次|条)/,
  );
  if (!match) return null;

  const amount = parseAmount(match[1]);
  if (amount == null || amount <= 0) return null;
  return Math.max(1, Math.round(amount));
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
