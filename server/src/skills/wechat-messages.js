import { config } from '../config.js';

const DEFAULT_SCREEN = {
  width: config.screen.defaultWidth,
  height: config.screen.defaultHeight,
};
const DEFAULT_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 8 * 1000;
const MAX_DURATION_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 3 * 1000;
const MAX_INTERVAL_MS = 10 * 60 * 1000;

export const DEFAULT_WECHAT_MESSAGES = Object.freeze([
  '自动化传输测试消息 01 正在验证微信文本发送链路',
  '自动化传输测试消息 02 当前消息用于循环发送功能测试',
  '自动化传输测试消息 03 正在检查中文输入和空格处理',
  '自动化传输测试消息 04 正在检查输入框聚焦状态',
  '自动化传输测试消息 05 正在检查发送按钮点击结果',
  '自动化传输测试消息 06 正在检查消息列表轮换逻辑',
  '自动化传输测试消息 07 正在检查发送间隔控制',
  '自动化传输测试消息 08 正在检查任务持续时间控制',
  '自动化传输测试消息 09 正在检查消息发送后的清空状态',
  '自动化传输测试消息 10 正在检查聊天页面保持状态',
  '自动化传输测试消息 11 正在检查前台应用状态',
  '自动化传输测试消息 12 正在检查长时间运行稳定性',
  '自动化传输测试消息 13 正在检查设备输入响应',
  '自动化传输测试消息 14 正在检查消息顺序是否正确',
  '自动化传输测试消息 15 正在检查循环回到列表开头',
  '自动化传输测试消息 16 正在检查任务停止响应',
  '自动化传输测试消息 17 正在检查采集启动边界',
  '自动化传输测试消息 18 正在检查屏幕录制同步状态',
  '自动化传输测试消息 19 正在检查网络抓包同步状态',
  '自动化传输测试消息 20 正在检查端口映射记录状态',
  '自动化传输测试消息 21 正在检查发送时间记录',
  '自动化传输测试消息 22 正在检查页面加载等待',
  '自动化传输测试消息 23 正在检查首个会话选择',
  '自动化传输测试消息 24 正在检查键盘弹出状态',
  '自动化传输测试消息 25 正在检查文本覆盖输入',
  '自动化传输测试消息 26 正在检查连续发送稳定性',
  '自动化传输测试消息 27 正在检查短间隔任务表现',
  '自动化传输测试消息 28 正在检查长间隔任务表现',
  '自动化传输测试消息 29 正在检查消息气泡显示',
  '自动化传输测试消息 30 正在检查页面布局变化',
  '自动化传输测试消息 31 正在检查异常恢复能力',
  '自动化传输测试消息 32 正在检查设备连接状态',
  '自动化传输测试消息 33 正在检查鸿蒙输入接口',
  '自动化传输测试消息 34 正在检查聊天编辑器状态',
  '自动化传输测试消息 35 正在检查发送坐标适配',
  '自动化传输测试消息 36 正在检查不同屏幕尺寸适配',
  '自动化传输测试消息 37 正在检查消息内容完整性',
  '自动化传输测试消息 38 正在检查数字字符输入',
  '自动化传输测试消息 39 正在检查中文字符输入',
  '自动化传输测试消息 40 正在检查空格字符输入',
  '自动化传输测试消息 41 正在检查消息列表边界',
  '自动化传输测试消息 42 正在检查循环计数结果',
  '自动化传输测试消息 43 正在检查运行日志输出',
  '自动化传输测试消息 44 正在检查任务完成状态',
  '自动化传输测试消息 45 正在检查采集文件收尾',
  '自动化传输测试消息 46 正在检查页面证据读取',
  '自动化传输测试消息 47 正在检查消息发送确认',
  '自动化传输测试消息 48 本轮消息列表测试即将循环',
]);

export function buildWechatMessagesPlan({
  app,
  durationMs = DEFAULT_DURATION_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  messages = DEFAULT_WECHAT_MESSAGES,
  platform = 'harmony',
  screen = DEFAULT_SCREEN,
}) {
  if (app?.id !== 'wechat' || !app.packageName) {
    throw new Error('WeChat messages skill requires the WeChat app');
  }
  if (platform !== 'harmony') {
    throw new Error('WeChat messages skill currently requires a HarmonyOS device');
  }

  const safeDuration = Math.max(1000, Math.min(Number(durationMs) || DEFAULT_DURATION_MS, MAX_DURATION_MS));
  const safeInterval = Math.max(
    MIN_INTERVAL_MS,
    Math.min(Number(intervalMs) || DEFAULT_INTERVAL_MS, MAX_INTERVAL_MS),
  );
  const safeMessages = normalizeMessages(messages);
  const size = {
    width: Number(screen.width) || DEFAULT_SCREEN.width,
    height: Number(screen.height) || DEFAULT_SCREEN.height,
  };

  return [
    { type: 'force_stop', packageName: app.packageName, label: '关闭微信旧页面' },
    { type: 'launch_app', packageName: app.packageName, label: '打开微信' },
    { type: 'wait', ms: 3500, label: '等待微信聊天列表加载' },
    { type: 'assert_no_sensitive_prompt', label: '检查协议和安全验证弹窗' },
    {
      type: 'tap_text',
      texts: ['稍后', '取消', '暂不', '跳过', '我知道了'],
      optional: true,
      partial: true,
      label: '关闭非必要提示',
    },
    { type: 'assert_foreground_package', packageName: app.packageName, label: '确认仍在微信' },
    {
      type: 'assert_ui_text',
      any: [/微信/, /通讯录/, /发现/, /我/],
      label: '确认微信聊天列表已显示',
      message: '微信未显示聊天列表，不能默认选择第一个会话',
    },
    {
      type: 'tap',
      x: Math.round(size.width * 0.5),
      y: Math.round(size.height * 0.217),
      label: '进入聊天列表中的第一个会话',
    },
    { type: 'wait', ms: 1800, label: '等待微信聊天页面加载' },
    { type: 'assert_foreground_package', packageName: app.packageName, label: '确认仍在微信会话内' },
    {
      type: 'assert_ui_node',
      types: ['RichEditor'],
      label: '确认微信消息输入框已显示',
      message: '微信首个会话未出现消息输入框，停止发送',
    },
    { type: 'start_capture', label: '开始采集微信消息传输' },
    {
      type: 'loop_text_messages',
      durationMs: safeDuration,
      intervalMs: safeInterval,
      messages: safeMessages,
      input: {
        x: Math.round(size.width * 0.44),
        y: Math.round(size.height * 0.929),
        target: {
          types: ['RichEditor'],
        },
      },
      send: {
        x: Math.round(size.width * 0.905),
        y: Math.round(size.height * 0.556),
        target: {
          texts: ['发送'],
          partial: false,
        },
      },
      editorTypes: ['RichEditor'],
      label: '循环发送微信测试消息',
    },
    { type: 'complete', label: '微信循环发消息完成' },
  ];
}

function normalizeMessages(messages) {
  const source = Array.isArray(messages) && messages.length ? messages : DEFAULT_WECHAT_MESSAGES;
  const normalized = source
    .map((message) => String(message || '').replace(/\s+/g, ' ').trim().slice(0, 120))
    .filter(Boolean);
  if (!normalized.length) {
    throw new Error('WeChat messages skill requires at least one message');
  }
  return normalized;
}
