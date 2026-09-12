import { config } from '../config.js';
import { buildDouyinLiveManualPlan } from './douyin-live.js';

const DEFAULT_SCREEN = { width: config.screen.defaultWidth, height: config.screen.defaultHeight };
const DEFAULT_DURATION_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RANDOM_SWITCH_MIN_MS = 2 * 60 * 1000;
const DEFAULT_RANDOM_SWITCH_MAX_MS = 5 * 60 * 1000;
const MIN_SWITCH_INTERVAL_MS = 1000;
const SUPPORTED_LIVE_ENTRY_APP_IDS = new Set(['taobao', 'jd', 'wechat', 'xiaohongshu']);
const MANUAL_LIVE_ENTRY_APP_IDS = new Set(['migu-video', 'tencent-sports']);
const MANUAL_LIVE_ROOM_EVIDENCE = {
  'migu-video': [/直播间/, /正在直播/, /直播中/, /赛事直播/, /比赛直播/],
  'tencent-sports': [/直播间/, /正在直播/, /直播中/, /比赛直播/, /赛事直播/, /实时直播/],
};
const LIVE_EVIDENCE = [
  /直播间/,
  /正在直播/,
  /主播/,
  /连麦/,
  /送礼/,
  /礼物/,
  /粉丝团/,
  /小时榜/,
  /本场/,
  /讲解/,
  /购物袋/,
  /小黄车/,
  /热卖/,
  /开播/,
  /人气/,
  /观众/,
  /进来了/,
];
const TAOBAO_LIVE_ROOM_EVIDENCE = [
  /说点什么/,
  /观看/,
  /宝贝口袋/,
  /主播互动/,
  /来了/,
];
const JD_LIVE_ROOM_EVIDENCE = [
  /关闭直播间/,
  /直播间/,
  /正在直播/,
  /说点什么/,
  /主播/,
  /讲解/,
  /购物袋/,
  /热卖/,
  /马上抢/,
  /观看/,
  /人气/,
];
const WECHAT_LIVE_ROOM_CONTROL_EVIDENCE = /(欢迎来到直播间|说点什么|暂无法评论)/;
const WECHAT_LIVE_ROOM_EVIDENCE = [
  WECHAT_LIVE_ROOM_CONTROL_EVIDENCE,
  /(正在直播|直播间内|人看过|观众)/,
];
const XHS_LIVE_CHANNEL_EVIDENCE = [/直播中/];
const XHS_LIVE_ROOM_EVIDENCE = [
  /(欢迎来到直播间|更多直播)/,
  /说点什么/,
];

export function buildLiveEntryPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  switchIntervalMs = null,
  screen = DEFAULT_SCREEN,
}) {
  if (!app?.packageName) {
    throw new Error('live entry skill requires an app packageName');
  }
  if (app.id === 'douyin') {
    return buildDouyinLiveManualPlan({
      app,
      durationMs,
      switchIntervalMs,
      screen,
    });
  }
  if (MANUAL_LIVE_ENTRY_APP_IDS.has(app.id)) {
    return buildManualLiveEntryPlan({
      app,
      durationMs,
      roomEvidence: MANUAL_LIVE_ROOM_EVIDENCE[app.id],
    });
  }
  if (!SUPPORTED_LIVE_ENTRY_APP_IDS.has(app.id)) {
    throw new Error(`${app.name}当前没有稳定可验证的直播入口，已从自动直播功能中移除。`);
  }

  const safeDuration = Math.max(1000, Math.min(durationMs, MAX_DURATION_MS));
  const size = {
    width: Number(screen.width) || DEFAULT_SCREEN.width,
    height: Number(screen.height) || DEFAULT_SCREEN.height,
  };
  const x = Math.round(size.width * 0.5);
  const steps = [
    ...buildLiveEntrySteps({ app, size, x, safeDuration }),
    ...buildLiveValidationSteps(app),
    { type: 'start_capture', label: `开始采集${app.name}直播内容` },
  ];

  let elapsed = sumWaits(steps);
  let index = 0;
  while (elapsed < safeDuration) {
    const waitMs = Math.min(nextSwitchWaitMs(switchIntervalMs), safeDuration - elapsed);
    if (waitMs > 0) {
      steps.push({ type: 'wait', ms: waitMs, label: `观看直播 ${formatWaitLabel(waitMs)} 后切换` });
      elapsed += waitMs;
    }
    if (elapsed < safeDuration) {
      steps.push({
        type: 'swipe',
        x1: x,
        y1: Math.round(size.height * 0.78),
        x2: x,
        y2: Math.round(size.height * 0.22),
        durationMs: 420,
        label: `${
          hasConfiguredSwitchInterval(switchIntervalMs) ? '按设置间隔' : '随机间隔'
        }后下滑切换下一场直播 ${index + 1}`,
      });
      elapsed += 800;
    }
    index += 1;
  }

  steps.push({ type: 'complete', label: `${app.name}直播浏览完成` });
  return steps;
}

export function buildManualLiveEntryPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  roomEvidence = [/直播间/, /正在直播/, /直播中/],
} = {}) {
  if (!app?.packageName || !MANUAL_LIVE_ENTRY_APP_IDS.has(app.id)) {
    throw new Error('人工直播接管计划只支持已登记的咪咕视频或腾讯体育');
  }
  const safeDuration = Math.max(1000, Math.min(Number(durationMs) || DEFAULT_DURATION_MS, MAX_DURATION_MS));
  return [
    {
      type: 'manual_confirm',
      label: `等待用户进入${app.name}直播间`,
      message: `请在手机上手动进入${app.name}的具体直播间，然后在前端点击“我已进入直播，继续”。`,
      confirmLabel: '我已进入直播，继续',
    },
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      label: `确认当前前台为${app.name}`,
      message: `当前未停留在${app.name}，请重新进入直播间。`,
    },
    {
      type: 'assert_ui_text',
      any: roomEvidence,
      retries: 8,
      retryIntervalMs: 1000,
      label: `确认已进入${app.name}真实直播间`,
      message: `${app.name}未出现直播间证据，请确认已经进入具体直播间。`,
    },
    {
      type: 'assert_screen_changes',
      intervalMs: 1500,
      minDiffRatio: 0.0005,
      label: `确认${app.name}直播画面持续变化`,
      message: `${app.name}直播画面没有持续变化，请确认直播正在播放。`,
    },
    { type: 'start_capture', label: `开始采集${app.name}直播内容` },
    { type: 'wait', ms: safeDuration, silent: true },
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      label: `确认仍在${app.name}直播间`,
      message: `观看期间已经离开${app.name}，任务停止。`,
    },
    { type: 'complete', label: `${app.name}直播浏览完成` },
  ];
}

function buildLiveEntrySteps({ app, size, x, safeDuration }) {
  if (app.id === 'jd') {
    return buildJdLiveEntrySteps({ app, size, safeDuration });
  }
  if (app.id === 'wechat') {
    return buildWechatLiveEntrySteps({ app, size, safeDuration });
  }
  if (app.id === 'xiaohongshu') {
    return buildXhsLiveEntrySteps({ app, size, safeDuration });
  }
  const roomActivityAny = getLiveRoomActivityMatchers(app);

  return [
    { type: 'launch_app', packageName: app.packageName, label: `打开${app.name}` },
    { type: 'wait', ms: Math.min(5000, safeDuration), label: '等待首页加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'tap_text',
      texts: ['稍后', '取消', '暂不', '跳过', '我知道了'],
      optional: true,
      partial: true,
      label: '关闭非必要提示',
    },
    ...buildAppSpecificLivePopupClosers({ app, size }),
    { type: 'tap_text', texts: ['直播'], optional: true, partial: true, label: '进入直播入口' },
    { type: 'wait', ms: 4000, label: '等待直播内容加载' },
    {
      type: 'tap_text',
      texts: ['点击进入直播间', '进入直播间', '直播中', '去看直播'],
      optional: true,
      partial: true,
      label: '点击直播间入口',
    },
    ...buildAppSpecificLiveEntryTaps({ app, size, roomActivityAny }),
    { type: 'wait', ms: 1500, label: '等待直播间入口响应' },
    {
      type: roomActivityAny.length ? 'tap_if_activity_not_matches' : 'tap',
      activityAny: roomActivityAny,
      x,
      y: Math.round(size.height * 0.38),
      label: '尝试进入直播内容',
    },
    { type: 'wait', ms: 3000, label: '等待直播间稳定' },
    { type: 'assert_no_sensitive_prompt', label: '检查直播页弹窗' },
  ];
}

function getLiveRoomActivityMatchers(app) {
  if (app.id === 'taobao') return [/taolive\.room/i, /TaoLiveVideoActivity/i];
  if (app.id === 'jd') return [/VideoLiveRoomActivity/i, /LiveRoom/i, /mylive/i];
  if (app.id === 'wechat') return [/FinderLiveVisitor/i];
  if (app.id === 'xiaohongshu') return [/AlphaAudienceActivity/i, /alpha.*audience/i];
  return [];
}

function buildAppSpecificLivePopupClosers({ app, size }) {
  return [];
}

function buildAppSpecificLiveEntryTaps({ app, size, roomActivityAny }) {
  if (app.id === 'taobao') {
    return [
      {
        type: 'tap_if_activity_not_matches',
        activityAny: roomActivityAny,
        x: Math.round(size.width * 0.84),
        y: Math.round(size.height * 0.73),
        label: '点击淘宝直播卡片入口',
      },
    ];
  }

  return [];
}

function sumWaits(steps) {
  return steps.filter((step) => step.type === 'wait').reduce((sum, step) => sum + step.ms, 0);
}

function nextSwitchWaitMs(switchIntervalMs) {
  const base = Number(switchIntervalMs);
  if (Number.isFinite(base) && base > 0) {
    return Math.max(MIN_SWITCH_INTERVAL_MS, Math.round(base));
  }

  return randomInt(DEFAULT_RANDOM_SWITCH_MIN_MS, DEFAULT_RANDOM_SWITCH_MAX_MS);
}

function hasConfiguredSwitchInterval(switchIntervalMs) {
  return Number.isFinite(Number(switchIntervalMs)) && Number(switchIntervalMs) > 0;
}

function randomInt(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return low + Math.floor(Math.random() * (high - low + 1));
}

function formatWaitLabel(ms) {
  if (ms >= 60 * 1000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
}

function buildJdLiveEntrySteps({ app, size, safeDuration }) {
  const bottomRegion = {
    minX: 0,
    maxX: size.width,
    minY: Math.round(size.height * 0.82),
    maxY: size.height,
  };
  const roomActivityAny = getLiveRoomActivityMatchers(app);

  return [
    { type: 'force_stop', packageName: app.packageName, label: '重启京东以回到稳定首页' },
    { type: 'launch_app', packageName: app.packageName, label: '打开京东' },
    { type: 'wait', ms: Math.min(5000, safeDuration), label: '等待京东首页加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'tap_text',
      texts: ['稍后', '取消', '暂不', '跳过', '我知道了'],
      optional: true,
      partial: true,
      label: '关闭非必要提示',
    },
    {
      type: 'tap_text_region',
      texts: ['逛', '逛逛'],
      optional: true,
      partial: true,
      region: bottomRegion,
      label: '点击底部逛入口',
    },
    {
      type: 'tap',
      x: Math.round(size.width * 0.3),
      y: Math.round(size.height * 0.955),
      label: '兜底点击底部逛入口',
    },
    { type: 'wait', ms: 3500, label: '等待京东逛页面加载' },
    {
      type: 'tap',
      x: Math.round(size.width * 0.8),
      y: Math.round(size.height * 0.083),
      label: '点击京东视频频道',
    },
    { type: 'wait', ms: 1500, label: '等待京东视频频道稳定' },
    {
      type: 'tap',
      x: Math.round(size.width * 0.29),
      y: Math.round(size.height * 0.083),
      label: '从视频切到京东直播频道',
    },
    { type: 'wait', ms: 5000, label: '等待京东直播频道加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查京东直播频道风控验证' },
    {
      type: 'tap_if_activity_not_matches',
      activityAny: roomActivityAny,
      x: Math.round(size.width * 0.24),
      y: Math.round(size.height * 0.3),
      label: '点击京东直播卡片',
    },
    { type: 'wait', ms: 6000, label: '等待京东直播间加载' },
    {
      type: 'tap_if_activity_not_matches',
      activityAny: roomActivityAny,
      x: Math.round(size.width * 0.24),
      y: Math.round(size.height * 0.3),
      label: '再次点击京东直播卡片',
    },
    { type: 'wait', ms: 3000, label: '等待京东直播间稳定' },
    {
      type: 'tap_if_ui_text_matches',
      matches: [/悬浮窗权限/, /请开启重要权限/],
      x: Math.round(size.width * 0.31),
      y: Math.round(size.height * 0.586),
      optional: true,
      label: '关闭京东直播悬浮窗权限提示',
    },
    { type: 'wait', ms: 1500, label: '等待京东直播权限提示关闭' },
    { type: 'assert_no_sensitive_prompt', label: '检查京东直播页弹窗' },
  ];
}

function buildWechatLiveEntrySteps({ app, size, safeDuration }) {
  const roomActivityAny = getLiveRoomActivityMatchers(app);

  return [
    {
      type: 'start_activity',
      packageName: app.packageName,
      activityName: '.ui.LauncherUI',
      label: '打开微信主界面',
    },
    { type: 'wait', ms: Math.min(3000, safeDuration), label: '等待微信主界面加载' },
    {
      type: 'tap',
      x: Math.round(size.width * 0.625),
      y: Math.round(size.height * 0.965),
      label: '点击底部发现',
    },
    { type: 'wait', ms: 1800, label: '等待微信发现页' },
    {
      type: 'tap',
      x: Math.round(size.width * 0.48),
      y: Math.round(size.height * 0.279),
      label: '点击微信发现页直播入口',
    },
    { type: 'wait', ms: 6000, label: '等待微信直播入口加载' },
    {
      type: 'tap_if_activity_not_matches',
      activityAny: roomActivityAny,
      x: Math.round(size.width * 0.25),
      y: Math.round(size.height * 0.32),
      label: '点击微信直播卡片',
    },
    { type: 'wait', ms: 8000, label: '等待微信直播间加载' },
    {
      type: 'tap_if_activity_not_matches',
      activityAny: roomActivityAny,
      x: Math.round(size.width * 0.25),
      y: Math.round(size.height * 0.32),
      label: '再次点击微信直播卡片',
    },
    { type: 'wait', ms: 3000, label: '等待微信直播间稳定' },
    {
      type: 'tap_if_ui_text_not_matches',
      matches: [WECHAT_LIVE_ROOM_CONTROL_EVIDENCE],
      x: Math.round(size.width * 0.5),
      y: Math.round(size.height * 0.31),
      label: '显示微信直播间控件',
    },
    { type: 'wait', ms: 800, label: '等待微信直播间控件显示' },
  ];
}

function buildXhsLiveEntrySteps({ app, size, safeDuration }) {
  const topRegion = {
    minX: 0,
    maxX: size.width,
    minY: 0,
    maxY: Math.round(size.height * 0.18),
  };

  return [
    { type: 'force_stop', packageName: app.packageName, label: '重启小红书以回到稳定首页' },
    { type: 'launch_app', packageName: app.packageName, label: '打开小红书' },
    { type: 'wait', ms: Math.min(5000, safeDuration), label: '等待小红书首页加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'tap_text',
      texts: ['稍后', '取消', '暂不', '跳过', '我知道了'],
      optional: true,
      partial: true,
      label: '关闭小红书非必要提示',
    },
    {
      type: 'tap_text_region',
      texts: ['发现'],
      region: topRegion,
      label: '点击小红书首页发现频道',
    },
    {
      type: 'tap',
      x: Math.round(size.width * 0.5),
      y: Math.round(size.height * 0.075),
      label: '兜底点击小红书首页发现频道',
    },
    { type: 'wait', ms: 1200, label: '等待小红书发现频道稳定' },
    {
      type: 'tap_text_region',
      texts: ['直播'],
      region: topRegion,
      label: '点击小红书顶部直播频道',
    },
    {
      type: 'tap',
      x: Math.round(size.width * 0.355),
      y: Math.round(size.height * 0.125),
      label: '兜底点击小红书顶部直播频道',
    },
    { type: 'wait', ms: 5000, label: '等待小红书直播频道加载' },
    {
      type: 'assert_ui_text',
      any: XHS_LIVE_CHANNEL_EVIDENCE,
      label: '确认小红书直播频道已加载',
      message: '小红书直播频道未出现直播卡片，停止以避免误点普通内容',
    },
    {
      type: 'tap',
      x: Math.round(size.width * 0.19),
      y: Math.round(size.height * 0.25),
      label: '点击小红书首张直播卡片',
    },
    { type: 'wait', ms: 6000, label: '等待小红书直播间稳定' },
    { type: 'assert_no_sensitive_prompt', label: '检查小红书直播页弹窗' },
  ];
}

function buildLiveValidationSteps(app) {
  if (app.id === 'taobao') {
    return [
      {
        type: 'assert_foreground_package',
        packageName: app.packageName,
        activityAny: [/taolive\.room/i, /TaoLiveVideoActivity/i],
        label: '确认进入淘宝直播间 Activity',
        message: '淘宝未进入真实直播间 Activity，不能判定为真实直播播放',
      },
      {
        type: 'assert_ui_text',
        any: TAOBAO_LIVE_ROOM_EVIDENCE,
        label: '确认淘宝直播间文本证据',
        message: '淘宝未出现直播间控件或观看信息，不能判定为真实直播播放',
      },
      {
        type: 'assert_screen_changes',
        intervalMs: 1500,
        minDiffRatio: 0.0005,
        label: '确认淘宝直播画面在变化',
        message: '淘宝直播画面变化不足，不能判定为真实直播播放',
      },
    ];
  }

  if (app.id === 'jd') {
    return [
      {
        type: 'assert_foreground_package',
        packageName: app.packageName,
        activityAny: [/VideoLiveRoomActivity/i, /LiveRoom/i, /mylive/i],
        label: '确认进入京东直播间 Activity',
        message: '京东未进入真实直播间 Activity，不能判定为真实直播播放',
      },
      {
        type: 'assert_ui_text',
        any: JD_LIVE_ROOM_EVIDENCE,
        label: '确认京东直播间文本证据',
        message: '京东未出现直播间控件或观看信息，不能判定为真实直播播放',
      },
      {
        type: 'assert_screen_changes',
        intervalMs: 1500,
        minDiffRatio: 0.0005,
        label: '确认京东直播画面在变化',
        message: '京东直播画面变化不足，不能判定为真实直播播放',
      },
    ];
  }

  if (app.id === 'wechat') {
    return [
      {
        type: 'assert_ui_text_or_activity',
        packageName: app.packageName,
        activityAny: [/FinderLiveVisitor/i],
        all: WECHAT_LIVE_ROOM_EVIDENCE,
        label: '确认进入微信真实直播间',
        message: '微信未出现真实直播间 Activity 或直播间控件，不能判定为真实直播播放',
      },
      {
        type: 'assert_screen_changes',
        intervalMs: 1500,
        minDiffRatio: 0.0005,
        label: '确认微信直播画面在变化',
        message: '微信直播画面变化不足，不能判定为真实直播播放',
      },
    ];
  }

  if (app.id === 'xiaohongshu') {
    return [
      {
        type: 'assert_foreground_package',
        packageName: app.packageName,
        label: '确认小红书仍在前台',
      },
      {
        type: 'assert_ui_text',
        all: XHS_LIVE_ROOM_EVIDENCE,
        label: '确认小红书直播间文本证据',
        message: '小红书未出现直播间欢迎信息和评论输入框，不能判定为真实直播播放',
      },
      {
        type: 'assert_screen_changes',
        intervalMs: 1500,
        minDiffRatio: 0.0005,
        label: '确认小红书直播画面在变化',
        message: '小红书直播画面变化不足，不能判定为真实直播播放',
      },
    ];
  }

  return [
    {
      type: 'assert_foreground_package',
      packageName: app.packageName,
      label: `确认仍在${app.name}`,
    },
    {
      type: 'assert_ui_text',
      any: LIVE_EVIDENCE,
      label: '确认直播间文本证据',
      message: `${app.name}未出现直播间证据，不能判定为真实直播播放`,
    },
    {
      type: 'assert_screen_changes',
      intervalMs: 1500,
      minDiffRatio: 0.0005,
      label: '确认直播画面在变化',
      message: `${app.name}直播画面变化不足，不能判定为真实直播播放`,
    },
  ];
}
