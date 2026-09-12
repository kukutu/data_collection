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
      ['welink', '音频通话'],
      ['welink', '视频通话'],
    ],
    functionId: 'call',
    commandTemplate: '在{appName}向第一个联系人发起{functionName} {duration}',
    params: [durationParam({ label: '通话时长' })],
    variants: {
      'dingtalk:视频通话': {
        functionId: 'video-call',
        commandTemplate: '在{appName}向消息页第一个人发起视频通话 {duration} 摄像头{camera} 共享屏幕{shareScreen}',
        params: [durationParam({ label: '通话时长' }), booleanParam('camera', '开启摄像头'), booleanParam('shareScreen', '共享屏幕')],
      },
      'wecom:视频通话': {
        functionId: 'video-call',
        commandTemplate: '在{appName}向消息页第一个人发起视频通话 {duration} 摄像头{camera} 共享屏幕{shareScreen}',
        params: [durationParam({ label: '通话时长' }), booleanParam('camera', '开启摄像头'), booleanParam('shareScreen', '共享屏幕')],
      },
      'welink:音频通话': {
        functionId: 'audio-call',
        commandTemplate: '在{appName}向消息页第一个联系人发起音频通话 {duration} 开视频{camera} 共享屏幕{shareScreen}',
        params: [durationParam({ label: '通话时长' }), booleanParam('camera', '开启摄像头'), booleanParam('shareScreen', '共享屏幕')],
      },
      'welink:视频通话': {
        functionId: 'video-call',
        commandTemplate: '在{appName}向消息页第一个联系人发起视频通话 {duration} 开视频{camera} 共享屏幕{shareScreen}',
        params: [durationParam({ label: '通话时长' }), booleanParam('camera', '开启摄像头'), booleanParam('shareScreen', '共享屏幕')],
      },
      音频通话: {
        functionId: 'audio-call',
        commandTemplate: '在{appName}向第一个联系人发起音频通话 {duration}',
      },
      视频通话: {
        functionId: 'video-call',
        commandTemplate: '在{appName}向第一个联系人发起视频通话 {duration}',
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
      'dingtalk:快速会议': {
        functionId: 'quick-meeting',
        commandTemplate: '在{appName}发起快速会议 类型{meetingType} {duration} 摄像头{camera} 共享屏幕{shareScreen}',
        params: [
          selectParam('meetingType', '会议类型', [
            { value: 'video', label: '视频会议' },
            { value: 'audio', label: '语音会议' },
          ], 'video'),
          durationParam({ label: '会议时长' }),
          { ...booleanParam('camera', '开启摄像头'), visibleWhen: { parameterId: 'meetingType', equals: 'video' } },
          booleanParam('shareScreen', '共享屏幕'),
        ],
      },
      'dingtalk:加入会议': {
        functionId: 'join-meeting',
        commandTemplate: '在{appName}加入会议 会议号{meetingId} {duration} 摄像头{camera} 共享屏幕{shareScreen}',
        params: [
          textParam('meetingId', '会议号', { required: true, placeholder: '输入会议号' }),
          durationParam({ label: '会议时长' }),
          booleanParam('camera', '开启摄像头'),
          booleanParam('shareScreen', '共享屏幕'),
        ],
      },
      'feishu:加入会议': {
        functionId: 'join-meeting',
        commandTemplate: '在{appName}加入会议 会议号{meetingId} {duration} 摄像头{camera} 共享屏幕{shareScreen}',
        params: [
          textParam('meetingId', '会议号', { required: true, placeholder: '输入9位会议号' }),
          durationParam({ label: '会议时长' }),
          booleanParam('camera', '开启摄像头'),
          booleanParam('shareScreen', '共享屏幕'),
        ],
      },
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
          durationParam({ label: '会议时长' }),
          textParam('meetingPassword', '会议密码', {
            required: false,
            sensitive: true,
            placeholder: '无密码可留空',
          }),
          booleanParam('camera', '开启摄像头'),
          booleanParam('shareScreen', '共享屏幕'),
        ],
        commandTemplate:
          '在{appName}加入会议 会议号{meetingId} {duration} 密码{meetingPassword} 摄像头{camera} 共享屏幕{shareScreen}',
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
      ['iqiyi', '爱奇艺直播'],
      ['yangshipin', '央视频直播'],
      ['tencent-sports', '腾讯体育直播'],
    ],
    functionId: 'live-browse',
    variants: {
      'migu-video:咪咕直播': {
        commandTemplate: '看{duration}{appName}直播，人工进入直播间后确认',
        params: [durationParam({ label: '观看时长' })],
      },
      'tencent-sports:腾讯体育直播': {
        commandTemplate: '看{duration}{appName}直播，人工进入直播间后确认',
        params: [durationParam({ label: '观看时长' })],
      },
      'yangshipin:央视频直播': {
        commandTemplate: '看{duration}{appName}直播，每{switchInterval}切换一次直播',
        params: [
          durationParam({ label: '观看时长' }),
          durationParam({ id: 'switchInterval', label: '切换间隔', defaultValue: 3, defaultUnit: '分钟' }),
        ],
      },
    },
    commandTemplate: '看{duration}{appName}直播，每{switchInterval}下滑一次',
    params: [
      durationParam({ label: '观看时长' }),
      durationParam({
        id: 'switchInterval',
        label: '下滑间隔',
        defaultValue: 3,
        defaultUnit: '分钟',
      }),
    ],
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
      ['xunlei', '上传图片或视频'],
      ['baidu-netdisk', '文件下载'],
      ['baidu-netdisk', '文件上传'],
    ],
    functionId: 'upload-download',
    commandTemplate: '打开{appName}执行{functionName} 目标{target}',
    params: [textParam('target', '文件或应用目标', { required: true })],
    variants: {
      'app-store:应用下载': {
        functionId: 'download-app',
        commandTemplate: '在{appName}下载{targetApp}，完成或运行{duration}后删除应用',
        params: [
          textParam('targetApp', '目标应用', {
            required: true,
            defaultValue: '王者荣耀',
          }),
          durationParam({ label: '下载时长', defaultValue: 30, defaultUnit: '秒' }),
        ],
      },
      'xunlei:上传图片或视频': {
        functionId: 'upload-media',
        commandTemplate: '在{appName}传输中上传相册第一项图片或视频',
        params: [],
      },
      'xunlei:文件下载': {
        functionId: 'download-file',
        commandTemplate: '在{appName}下载{magnetUrl}，运行{duration}后删除下载内容',
        params: [
          textParam('magnetUrl', '磁力链接', {
            required: true,
            defaultValue: 'magnet:?xt=urn:btih:8C9F4DB08497563EF6EB01CF81199F645DA0954B',
          }),
          durationParam({ label: '下载时长', defaultValue: 30, defaultUnit: '秒' }),
        ],
      },
      'baidu-netdisk:文件下载': {
        functionId: 'download-file',
        commandTemplate: '在{appName}文件页选择第一个文件夹下载，运行{duration}后清除并删除本地文件',
        params: [durationParam({ label: '下载时长', defaultValue: 30, defaultUnit: '秒' })],
      },
      'baidu-netdisk:文件上传': {
        functionId: 'upload-file',
        commandTemplate: '在{appName}上传{mediaType}',
        params: [{ id: 'mediaType', label: '上传类型', type: 'select', defaultValue: 'image', options: [{ value: 'image', label: '图片' }, { value: 'document', label: '文档' }, { value: 'video', label: '视频', disabled: true }] }],
      },
    },
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
  'voip:dingtalk:audio-call',
  'voip:dingtalk:video-call',
  'meeting:feishu:join-meeting',
  'meeting:feishu:quick-meeting',
  'meeting:dingtalk:join-meeting',
  'meeting:dingtalk:quick-meeting',
  'short-video:bilibili:short-video-feed',
  'voip:qq:audio-call',
  'voip:qq:video-call',
  'meeting:tencent-meeting:join-meeting',
  'short-video:douyin:short-video-feed',
  'short-video:kuaishou:short-video-feed',
  'short-video:wechat:short-video-feed',
  'short-video:xiaohongshu:short-video-feed',
  'short-video:xigua:short-video-feed',
  'short-video:toutiao:short-video-feed',
  'live:douyin:live-browse',
  'live:wechat:live-browse',
  'live:bilibili:live-browse',
  'live:huya:live-browse',
  'live:douyu:live-browse',
  'live:taobao:live-browse',
  'live:jd:live-browse',
  'live:yangshipin:live-browse',
  'live:weibo:live-browse',
  'live:xiaohongshu:live-browse',
  'live:iqiyi:live-browse',
  'live:migu-video:live-browse',
  'live:tencent-sports:live-browse',
  'transfer:wechat:send-messages',
  'ai:doubao:ai-chat',
  'ai:deepseek:ai-chat',
  'ai:qianwen:ai-chat',
  'ai:xiaoyi:ai-chat',
  'upload-download:xunlei:upload-media',
  'upload-download:xunlei:download-file',
  'upload-download:app-store:download-app',
  'upload-download:baidu-netdisk:download-file',
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
