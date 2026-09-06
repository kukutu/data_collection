const DURATION_UNITS = ['秒', '分钟', '小时'];

const durationParam = (overrides = {}) => ({
  id: 'duration',
  label: '持续时间',
  type: 'duration',
  defaultValue: 30,
  defaultUnit: '秒',
  min: 1,
  units: DURATION_UNITS,
  ...overrides,
});

const booleanParam = (id, label, defaultValue = false) => ({
  id,
  label,
  type: 'boolean',
  defaultValue,
});

const textParam = (id, label, overrides = {}) => ({
  id,
  label,
  type: 'text',
  defaultValue: '',
  ...overrides,
});

const numberParam = (id, label, overrides = {}) => ({
  id,
  label,
  type: 'number',
  defaultValue: 1,
  min: 1,
  ...overrides,
});

const selectParam = (id, label, options, defaultValue) => ({
  id,
  label,
  type: 'select',
  options,
  defaultValue,
});

const CATEGORY_DEFINITIONS = [
  {
    id: 'voip',
    label: 'VoIP',
    items: [
      ['wechat', '音频通话'],
      ['wechat', '视频通话'],
      ['qq', '音频通话'],
      ['qq', '视频通话'],
      ['dingtalk', '音频通话'],
      ['dingtalk', '视频通话'],
      ['wecom', '音频通话'],
      ['wecom', '视频通话'],
      ['meetime', '音频通话'],
      ['meetime', '视频通话'],
    ],
    functionId: 'call',
    commandTemplate: '在{appName}向第一个联系人发起{functionName}',
    params: [],
    variants: {
      音频通话: {
        functionId: 'audio-call',
        commandTemplate: '在{appName}向第一个联系人发起音频通话',
      },
      视频通话: {
        functionId: 'video-call',
        commandTemplate: '在{appName}向第一个联系人发起视频通话',
      },
    },
  },
  {
    id: 'meeting',
    label: '会议',
    items: [
      ['tencent-meeting', '快速会议'],
      ['tencent-meeting', '加入会议'],
      ['dingtalk', '快速会议'],
      ['dingtalk', '加入会议'],
      ['feishu', '快速会议'],
      ['feishu', '加入会议'],
      ['welink', '快速会议'],
      ['welink', '加入会议'],
    ],
    functionId: 'meeting',
    commandTemplate: '在{appName}{functionName}{meetingParams}',
    params: [],
    variants: {
      '快速会议': {
        functionId: 'quick-meeting',
        params: [
          durationParam({ label: '会议时长' }),
          booleanParam('camera', '开启摄像头'),
          booleanParam('shareScreen', '共享屏幕'),
        ],
        commandTemplate: '在{appName}发起快速会议 {duration} 摄像头{camera} 共享屏幕{shareScreen}',
      },
      '加入会议': {
        functionId: 'join-meeting',
        params: [
          textParam('meetingId', '会议号', { required: true, placeholder: '输入会议号' }),
          textParam('meetingPassword', '会议密码', {
            required: true,
            sensitive: true,
            placeholder: '输入会议密码',
          }),
          booleanParam('camera', '开启摄像头'),
          booleanParam('shareScreen', '共享屏幕'),
        ],
        commandTemplate:
          '在{appName}加入会议 会议号{meetingId} 密码{meetingPassword} 摄像头{camera} 共享屏幕{shareScreen}',
      },
    },
  },
  {
    id: 'short-video',
    label: '短视频',
    items: [
      ['douyin', '抖音短视频'],
      ['wechat', '微信视频号'],
      ['kuaishou', '快手短视频'],
      ['bilibili', 'B站短视频'],
      ['xiaohongshu', '小红书视频'],
      ['xigua', '西瓜视频'],
      ['toutiao', '头条短视频'],
    ],
    functionId: 'short-video-feed',
    commandTemplate: '刷{duration}{appName}',
    params: [durationParam({ label: '观看时长' })],
  },
  {
    id: 'live',
    label: '直播',
    items: [
      ['douyin', '直播浏览'],
      ['wechat', '视频号直播'],
      ['kuaishou', '直播浏览'],
      ['bilibili', '直播浏览'],
      ['huya', '直播浏览'],
      ['douyu', '直播浏览'],
      ['taobao', '淘宝直播'],
      ['jd', '京东直播'],
      ['xiaohongshu', '小红书直播'],
      ['weibo', '微博直播'],
      ['migu-video', '咪咕直播'],
      ['iqiyi', '爱奇艺体育直播'],
      ['yangshipin', '央视频直播'],
      ['tencent-sports', '腾讯体育直播'],
    ],
    functionId: 'live-browse',
    commandTemplate: '看{duration}{appName}直播',
    params: [durationParam({ label: '观看时长' })],
  },
  {
    id: 'transfer',
    label: '传输',
    items: [
      ['wechat', '发图/发视频'],
      ['wechat', '发消息'],
      ['welink', '发图/发视频'],
    ],
    functionId: 'transfer',
    commandTemplate: '打开{appName}执行{functionName}',
    params: [textParam('target', '联系人或目标', { required: true })],
    variants: {
      'wechat:发图/发视频': {
        functionId: 'send-media',
        commandTemplate:
          '在{appName}向第一个会话发送第一项图片或视频 {count}次 每{interval}发送一次',
        commandTemplatesByMode: {
          count:
            '在{appName}向第一个会话发送第一项图片或视频 {count}次 每{interval}发送一次',
          duration:
            '在{appName}向第一个会话循环发送第一项图片或视频 {duration} 每{interval}发送一次',
        },
        params: [
          selectParam(
            'sendMode',
            '执行方式',
            [
              { value: 'count', label: '按次数' },
              { value: 'duration', label: '按时长' },
            ],
            'count',
          ),
          numberParam('count', '发送次数', {
            defaultValue: 3,
            visibleWhen: { parameterId: 'sendMode', equals: 'count' },
          }),
          durationParam({
            label: '发送时长',
            defaultValue: 5,
            defaultUnit: '分钟',
            visibleWhen: { parameterId: 'sendMode', equals: 'duration' },
          }),
          durationParam({
            id: 'interval',
            label: '发送间隔',
            defaultValue: 8,
            defaultUnit: '秒',
          }),
        ],
      },
      '发消息': {
        functionId: 'send-messages',
        commandTemplate: '在{appName}向第一个会话循环发消息 {duration} 每{interval}发送一次',
        params: [
          durationParam({ label: '发送时长', defaultValue: 5, defaultUnit: '分钟' }),
          durationParam({ id: 'interval', label: '发送间隔', defaultValue: 8, defaultUnit: '秒' }),
        ],
      },
    },
  },
  {
    id: 'upload-download',
    label: '上传下载',
    items: [
      ['app-store', '应用下载'],
      ['xunlei', '文件下载'],
      ['baidu-netdisk', '文件上传下载'],
    ],
    functionId: 'upload-download',
    commandTemplate: '打开{appName}执行{functionName} 目标{target}',
    params: [textParam('target', '文件或应用目标', { required: true })],
  },
  {
    id: 'ai',
    label: 'AI 应用',
    items: [
      ['doubao', 'AI 对话'],
      ['deepseek', 'AI 对话'],
      ['qianwen', 'AI 对话'],
      ['xiaoyi', 'AI 对话'],
    ],
    functionId: 'ai-chat',
    commandTemplate: '和{appName}聊天{duration} 每{interval}发送一次',
    params: [
      durationParam({ label: '对话时长', defaultValue: 5, defaultUnit: '分钟' }),
      durationParam({ id: 'interval', label: '消息间隔', defaultValue: 8, defaultUnit: '秒' }),
    ],
  },
];

const VERIFIED_WORKFLOW_IDS = new Set([
  'short-video:douyin:short-video-feed',
  'short-video:wechat:short-video-feed',
  'live:wechat:live-browse',
  'transfer:wechat:send-messages',
  'ai:doubao:ai-chat',
]);

export function getWorkflowCatalog(
  apps = [],
  { verifiedWorkflowIds = [] } = {},
) {
  const verifiedIds =
    verifiedWorkflowIds instanceof Set
      ? verifiedWorkflowIds
      : new Set(verifiedWorkflowIds);
  return CATEGORY_DEFINITIONS.flatMap((category) =>
    category.items.map(([appId, featureName]) => {
      const variant =
        category.variants?.[`${appId}:${featureName}`] ||
        category.variants?.[featureName];
      const functionId = variant?.functionId || category.functionId;
      const workflowId = `${category.id}:${appId}:${functionId}`;
      const app = apps.find((candidate) => candidate.id === appId);
      const params = clone(variant?.params || category.params);
      return {
        id: workflowId,
        categoryId: category.id,
        categoryLabel: category.label,
        appId,
        appName: app?.name || appId,
        featureName,
        functionId,
        commandTemplate: variant?.commandTemplate || category.commandTemplate,
        commandTemplatesByMode: clone(variant?.commandTemplatesByMode || null),
        params,
        status:
          VERIFIED_WORKFLOW_IDS.has(workflowId) || verifiedIds.has(workflowId)
            ? 'verified'
            : 'pending',
        installed: Boolean(app?.installed),
        installedVia: app?.installedVia || null,
        skill: app?.skill || 'launch_only',
      };
    }),
  );
}

export function findWorkflow(workflows, workflowId) {
  return (workflows || []).find((workflow) => workflow.id === workflowId) || null;
}

export function getWorkflowDefinition(workflowId) {
  return findWorkflow(getWorkflowCatalog(), workflowId);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
