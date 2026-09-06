import { config } from '../config.js';

const DEFAULT_SCREEN = { width: config.screen.defaultWidth, height: config.screen.defaultHeight };
const DEFAULT_DURATION_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_RANDOM_SWITCH_MIN_MS = 2 * 60 * 1000;
const DEFAULT_RANDOM_SWITCH_MAX_MS = 5 * 60 * 1000;
const MIN_SWITCH_INTERVAL_MS = 30 * 1000;
const SUPPORTED_LIVE_ENTRY_APP_IDS = new Set(['douyin', 'taobao', 'jd', 'wechat', 'xiaohongshu']);
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
const DOUYIN_LIVE_ROOM_EVIDENCE = [
  /欢迎来到直播间/,
  /在线观众/,
  /说点什么/,
  /本场点赞/,
  /商品列表/,
  /连线/,
  /礼物/,
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

export function buildLiveEntryPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  switchIntervalMs = null,
  screen = DEFAULT_SCREEN,
}) {
  if (!app?.packageName) {
    throw new Error('live entry skill requires an app packageName');
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
    const waitMs = Math.min(nextRandomSwitchWaitMs(switchIntervalMs), safeDuration - elapsed);
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
        label: `随机间隔后下滑切换下一场直播 ${index + 1}`,
      });
      elapsed += 800;
    }
    index += 1;
  }

  steps.push({ type: 'complete', label: `${app.name}直播浏览完成` });
  return steps;
}

function buildLiveEntrySteps({ app, size, x, safeDuration }) {
  if (app.id === 'douyin') {
    return buildDouyinLiveEntrySteps({ app, size, safeDuration });
  }
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

function nextRandomSwitchWaitMs(switchIntervalMs) {
  const base = Number(switchIntervalMs);
  if (Number.isFinite(base) && base > 0) {
    const safeBase = Math.max(MIN_SWITCH_INTERVAL_MS, base);
    return randomInt(Math.round(safeBase * 0.7), Math.round(safeBase * 1.3));
  }

  return randomInt(DEFAULT_RANDOM_SWITCH_MIN_MS, DEFAULT_RANDOM_SWITCH_MAX_MS);
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

function buildDouyinLiveEntrySteps({ app, size, safeDuration }) {
  const topY = Math.round(size.height * 0.08);
  const previewX = Math.round(size.width * 0.5);
  const previewY = Math.round(size.height * 0.69);
  const topRegion = {
    minX: 0,
    maxX: size.width,
    minY: 0,
    maxY: Math.round(size.height * 0.18),
  };
  const liveActivity = [/Live/i];

  return [
    { type: 'launch_app', packageName: app.packageName, label: '打开抖音' },
    { type: 'wait', ms: Math.min(5000, safeDuration), label: '等待抖音首页加载' },
    { type: 'keyevent', code: 'KEYCODE_MEDIA_PAUSE', label: '暂停当前视频以稳定顶部频道识别' },
    { type: 'wait', ms: 800, label: '等待当前视频暂停' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'tap_text_region',
      texts: ['直播'],
      optional: true,
      region: topRegion,
      label: '点击顶部直播频道文本',
    },
    { type: 'wait', ms: 1000, label: '等待直播频道选中' },
    {
      type: 'swipe_if_ui_text_not_matches',
      activityAny: liveActivity,
      matches: [/已选中，直播/],
      x1: Math.round(size.width * 0.78),
      y1: topY,
      x2: Math.round(size.width * 0.22),
      y2: topY,
      durationMs: 280,
      label: '横滑顶部频道栏查找直播',
    },
    { type: 'wait', ms: 600, label: '等待顶部频道栏移动' },
    {
      type: 'tap_text_region',
      texts: ['直播'],
      optional: true,
      region: topRegion,
      label: '再次点击顶部直播频道文本',
    },
    { type: 'wait', ms: 1000, label: '等待直播频道再次选中' },
    {
      type: 'assert_ui_text_or_activity',
      packageName: app.packageName,
      activityAny: liveActivity,
      any: [/已选中，直播/],
      label: '确认已选中抖音直播频道',
      message: '抖音未选中顶部直播频道，停止以避免误点普通内容',
    },
    { type: 'wait', ms: 9000, label: '等待抖音直播频道加载' },
    {
      type: 'tap_if_activity_not_matches',
      activityAny: liveActivity,
      x: previewX,
      y: previewY,
      label: '点击直播预览画面',
    },
    { type: 'wait', ms: 8000, label: '等待抖音直播间加载' },
    {
      type: 'tap_if_activity_not_matches',
      activityAny: liveActivity,
      x: previewX,
      y: previewY,
      label: '再次点击直播预览画面',
    },
    { type: 'wait', ms: 6000, label: '等待直播间稳定' },
  ];
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
  return [
    { type: 'launch_app', packageName: app.packageName, label: '打开小红书' },
    { type: 'wait', ms: Math.min(4000, safeDuration), label: '等待小红书首页加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和权限弹窗' },
    {
      type: 'manual_confirm',
      label: '等待人工接管小红书直播',
      message: '请在手机上手动进入要观看的小红书直播间，然后在前端点击“我已点入视频，继续”。',
    },
    { type: 'wait', ms: 3000, label: '等待小红书直播间稳定' },
  ];
}

function buildLiveValidationSteps(app) {
  if (app.id === 'douyin') {
    return [
      {
        type: 'assert_foreground_package',
        packageName: app.packageName,
        activityAny: [/Live/i],
        label: '确认进入抖音直播 Activity',
        message: '抖音未进入直播 Activity，不能判定为真实直播播放',
      },
      {
        type: 'assert_ui_text',
        any: DOUYIN_LIVE_ROOM_EVIDENCE,
        optional: true,
        label: '辅助确认抖音直播间文本证据',
        message: '抖音未出现直播间控件或直播间提示，不能判定为真实直播播放',
      },
      {
        type: 'assert_screen_changes',
        intervalMs: 1500,
        minDiffRatio: 0.0005,
        label: '确认抖音直播画面在变化',
        message: '抖音直播画面变化不足，不能判定为真实直播播放',
      },
    ];
  }

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
        activityAny: [/AlphaAudienceActivity/i, /alpha.*audience/i],
        label: '确认进入小红书直播间 Activity',
        message: '小红书未进入真实直播间 Activity，不能判定为真实直播播放',
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
