import test from 'node:test';
import assert from 'node:assert/strict';

import { getWorkflowCatalog } from '../server/src/workflow-registry.js';

test('workflow catalog contains parameterized meeting variants and omits hidden categories', () => {
  const apps = [
    { id: 'douyin', name: '抖音', installed: true, skill: 'short_video_feed' },
    { id: 'kuaishou', name: '快手', installed: true, skill: 'short_video_feed' },
    { id: 'wechat', name: '微信', installed: true, skill: 'wechat_channels_feed' },
    { id: 'xiaohongshu', name: '小红书', installed: true, skill: 'short_video_feed' },
    { id: 'xigua', name: '西瓜视频', installed: true, skill: 'short_video_feed' },
    { id: 'toutiao', name: '头条', installed: true, skill: 'short_video_feed' },
    { id: 'bilibili', name: 'B站', installed: true, skill: 'bilibili_playback' },
    { id: 'huya', name: '虎牙', installed: true, skill: 'live_entry' },
    { id: 'douyu', name: '斗鱼', installed: true, skill: 'live_entry' },
    { id: 'taobao', name: '淘宝', installed: true, skill: 'live_entry' },
    { id: 'weibo', name: '微博', installed: true, skill: 'live_entry' },
    { id: 'iqiyi', name: '爱奇艺', installed: true, skill: 'live_entry' },
    { id: 'welink', name: 'WeLink', installed: true },
    { id: 'tencent-meeting', name: '腾讯会议', installed: true },
    { id: 'feishu', name: '飞书', installed: false },
  ];
  const workflows = getWorkflowCatalog(apps);

  assert.equal(workflows.some((workflow) => workflow.categoryId === 'long-video'), false);
  assert.equal(workflows.some((workflow) => workflow.categoryId === 'navigation'), false);

  const voipWorkflows = getWorkflowCatalog([
    { id: 'wechat', name: '微信', installed: true },
    { id: 'qq', name: 'QQ', installed: true },
    { id: 'dingtalk', name: '钉钉', installed: true },
    { id: 'wecom', name: '企业微信', installed: true },
    { id: 'meetime', name: '畅连', installed: true },
    { id: 'welink', name: 'WeLink', installed: true },
  ]).filter((workflow) => workflow.categoryId === 'voip');
  const repeatParams = [
    { id: 'repeatCount', label: '重复次数', type: 'number', defaultValue: 1, min: 1, max: 20 },
    { id: 'repeatInterval', label: '重复间隔', type: 'duration', defaultValue: 5, defaultUnit: '秒', min: 1, units: ['秒', '分钟', '小时'] },
  ];
  assert.equal(voipWorkflows.length, 11);
  for (const workflow of voipWorkflows) {
    if (workflow.appId === 'meetime') {
      assert.deepEqual(workflow.params, [
        { id: 'phoneNumber', label: '电话号码', type: 'text', defaultValue: '', required: true },
        { id: 'duration', label: '通话时长', type: 'duration', defaultValue: 30, defaultUnit: '秒', min: 1, units: ['秒', '分钟', '小时'] },
        { id: 'video', label: '视频通话', type: 'boolean', defaultValue: false },
        ...repeatParams,
      ]);
      assert.match(workflow.commandTemplate, /\{phoneNumber\}/);
    } else {
      assert.deepEqual(workflow.params, [
        {
          id: 'duration',
          label: '通话时长',
          type: 'duration',
          defaultValue: 30,
          defaultUnit: '秒',
          min: 1,
          units: ['秒', '分钟', '小时'],
        },
        ...(['voip:dingtalk:video-call', 'voip:wecom:video-call', 'voip:welink:audio-call', 'voip:welink:video-call'].includes(workflow.id) ? [
          { id: 'camera', label: '开启摄像头', type: 'boolean', defaultValue: false },
          { id: 'shareScreen', label: '共享屏幕', type: 'boolean', defaultValue: false },
        ] : []),
        ...repeatParams,
      ]);
      assert.match(workflow.commandTemplate, /第一个(?:联系人|人)/);
    }
    assert.match(workflow.commandTemplate, /\{duration\}/);
    assert.doesNotMatch(workflow.commandTemplate, /\{contact\}/);
  }
  for (const appId of ['wechat', 'qq', 'dingtalk', 'wecom', 'meetime', 'welink']) {
    const appWorkflows = voipWorkflows.filter((workflow) => workflow.appId === appId);
    const expected = appId === 'meetime'
      ? [['audio-call', '音频通话']]
      : [['audio-call', '音频通话'], ['video-call', '视频通话']];
    assert.deepEqual(appWorkflows.map((workflow) => [workflow.functionId, workflow.featureName]), expected);
    if (appId !== 'meetime') assert.match(appWorkflows[0].commandTemplate, /音频通话/);
    if (appId !== 'meetime') assert.match(appWorkflows[1].commandTemplate, /视频通话/);
  }
  assert.deepEqual(
    voipWorkflows.filter((workflow) => workflow.appId === 'welink').map((workflow) => workflow.status),
    ['verified', 'verified'],
  );

  const douyin = workflows.find((workflow) => workflow.id === 'short-video:douyin:short-video-feed');
  assert.equal(douyin.status, 'verified');
  assert.equal(douyin.installed, true);
  assert.deepEqual(douyin.params[0], {
    id: 'duration',
    label: '观看时长',
    type: 'duration',
    defaultValue: 30,
    defaultUnit: '秒',
    min: 1,
    units: ['秒', '分钟', '小时'],
  });

  const douyinLive = workflows.find(
    (workflow) => workflow.id === 'live:douyin:live-browse',
  );
  assert.equal(douyinLive.status, 'verified');
  assert.equal(douyinLive.installed, true);
  assert.deepEqual(
    douyinLive.params.map((parameter) => parameter.id),
    ['duration', 'switchInterval'],
  );

  const kuaishou = workflows.find(
    (workflow) => workflow.id === 'short-video:kuaishou:short-video-feed',
  );
  assert.equal(kuaishou.status, 'verified');
  assert.equal(kuaishou.installed, true);
  assert.deepEqual(kuaishou.params[0], {
    id: 'duration',
    label: '观看时长',
    type: 'duration',
    defaultValue: 30,
    defaultUnit: '秒',
    min: 1,
    units: ['秒', '分钟', '小时'],
  });

  const wechat = workflows.find(
    (workflow) => workflow.id === 'short-video:wechat:short-video-feed',
  );
  assert.equal(wechat.status, 'verified');
  assert.equal(wechat.installed, true);

  const xhsVideo = workflows.find(
    (workflow) => workflow.id === 'short-video:xiaohongshu:short-video-feed',
  );
  assert.equal(xhsVideo.status, 'verified');
  assert.equal(xhsVideo.installed, true);
  assert.deepEqual(
    xhsVideo.params.map((parameter) => parameter.id),
    ['duration'],
  );

  const xiguaVideo = workflows.find(
    (workflow) => workflow.id === 'short-video:xigua:short-video-feed',
  );
  assert.equal(xiguaVideo.status, 'verified');
  assert.equal(xiguaVideo.installed, true);
  assert.deepEqual(
    xiguaVideo.params.map((parameter) => parameter.id),
    ['duration'],
  );

  const toutiaoVideo = workflows.find(
    (workflow) => workflow.id === 'short-video:toutiao:short-video-feed',
  );
  assert.equal(toutiaoVideo.status, 'verified');
  assert.equal(toutiaoVideo.installed, true);
  assert.deepEqual(
    toutiaoVideo.params.map((parameter) => parameter.id),
    ['duration'],
  );

  const wechatLive = workflows.find(
    (workflow) => workflow.id === 'live:wechat:live-browse',
  );
  assert.equal(wechatLive.status, 'verified');
  assert.equal(wechatLive.installed, true);
  assert.deepEqual(
    wechatLive.params.map((parameter) => parameter.id),
    ['duration', 'switchInterval'],
  );
  assert.deepEqual(
    wechatLive.params.find((parameter) => parameter.id === 'switchInterval'),
    {
      id: 'switchInterval',
      label: '下滑间隔',
      type: 'duration',
      defaultValue: 3,
      defaultUnit: '分钟',
      min: 1,
      units: ['秒', '分钟', '小时'],
    },
  );
  assert.match(wechatLive.commandTemplate, /\{switchInterval\}下滑一次/);

  const xhsLive = workflows.find(
    (workflow) => workflow.id === 'live:xiaohongshu:live-browse',
  );
  assert.equal(xhsLive.status, 'verified');
  assert.equal(xhsLive.installed, true);
  assert.deepEqual(
    xhsLive.params.map((parameter) => parameter.id),
    ['duration', 'switchInterval'],
  );

  const bilibiliLive = workflows.find(
    (workflow) => workflow.id === 'live:bilibili:live-browse',
  );
  assert.equal(bilibiliLive.status, 'verified');
  assert.equal(bilibiliLive.installed, true);
  assert.deepEqual(
    bilibiliLive.params.map((parameter) => parameter.id),
    ['duration', 'switchInterval'],
  );

  const huyaLive = workflows.find(
    (workflow) => workflow.id === 'live:huya:live-browse',
  );
  assert.equal(huyaLive.status, 'verified');
  assert.equal(huyaLive.installed, true);
  assert.equal(huyaLive.skill, 'live_entry');
  assert.deepEqual(
    huyaLive.params.map((parameter) => parameter.id),
    ['duration', 'switchInterval'],
  );

  const douyuLive = workflows.find(
    (workflow) => workflow.id === 'live:douyu:live-browse',
  );
  assert.equal(douyuLive.status, 'verified');
  assert.equal(douyuLive.installed, true);
  assert.equal(douyuLive.skill, 'live_entry');
  assert.deepEqual(
    douyuLive.params.map((parameter) => parameter.id),
    ['duration', 'switchInterval'],
  );

  const weiboLive = workflows.find(
    (workflow) => workflow.id === 'live:weibo:live-browse',
  );
  assert.equal(weiboLive.status, 'verified');
  assert.equal(weiboLive.installed, true);
  assert.equal(weiboLive.skill, 'live_entry');
  assert.deepEqual(
    weiboLive.params.map((parameter) => parameter.id),
    ['duration', 'switchInterval'],
  );

  const taobaoLive = workflows.find(
    (workflow) => workflow.id === 'live:taobao:live-browse',
  );
  assert.equal(taobaoLive.status, 'verified');
  assert.equal(taobaoLive.installed, true);
  assert.equal(taobaoLive.skill, 'live_entry');
  assert.deepEqual(
    taobaoLive.params.map((parameter) => parameter.id),
    ['duration', 'switchInterval'],
  );

  const iqiyiLive = workflows.find(
    (workflow) => workflow.id === 'live:iqiyi:live-browse',
  );
  assert.equal(iqiyiLive.featureName, '爱奇艺直播');
  assert.equal(iqiyiLive.status, 'verified');
  assert.equal(iqiyiLive.installed, true);
  assert.equal(iqiyiLive.skill, 'live_entry');
  assert.deepEqual(
    iqiyiLive.params.map((parameter) => parameter.id),
    ['duration', 'switchInterval'],
  );

  const wechatMessages = workflows.find(
    (workflow) => workflow.id === 'transfer:wechat:send-messages',
  );
  assert.equal(wechatMessages.status, 'verified');
  assert.deepEqual(
    wechatMessages.params.map((parameter) => parameter.id),
    ['duration', 'interval'],
  );
  assert.match(wechatMessages.commandTemplate, /第一个会话/);
  assert.equal(
    workflows.some(
      (workflow) =>
        workflow.featureName === '发图/发视频' &&
        workflow.id === 'transfer:wechat:send-media',
    ),
    true,
  );
  const wechatMedia = workflows.find(
    (workflow) => workflow.id === 'transfer:wechat:send-media',
  );
  assert.deepEqual(
    wechatMedia.params.map((parameter) => parameter.id),
    ['sendMode', 'count', 'duration', 'interval'],
  );
  assert.deepEqual(
    wechatMedia.params.find((parameter) => parameter.id === 'count').visibleWhen,
    { parameterId: 'sendMode', equals: 'count' },
  );
  assert.deepEqual(
    wechatMedia.params.find((parameter) => parameter.id === 'duration').visibleWhen,
    { parameterId: 'sendMode', equals: 'duration' },
  );
  assert.match(wechatMedia.commandTemplate, /第一个会话/);
  assert.match(wechatMedia.commandTemplatesByMode.duration, /循环发送/);

  const welinkMedia = workflows.find(
    (workflow) => workflow.id === 'transfer:welink:transfer',
  );
  assert.deepEqual(
    welinkMedia.params.map((parameter) => parameter.id),
    ['target'],
  );
  assert.equal(welinkMedia.params[0].required, true);

  const doubaoChat = getWorkflowCatalog([
    { id: 'doubao', name: '豆包', installed: true, skill: 'doubao_chat' },
  ]).find((workflow) => workflow.id === 'ai:doubao:ai-chat');
  assert.equal(doubaoChat.status, 'verified');
  assert.equal(doubaoChat.installed, true);
  assert.match(doubaoChat.commandTemplate, /\{duration\}.*\{interval\}/);

  const deepseekChat = getWorkflowCatalog([
    { id: 'deepseek', name: 'DeepSeek', installed: true, skill: 'deepseek_chat' },
  ]).find((workflow) => workflow.id === 'ai:deepseek:ai-chat');
  assert.equal(deepseekChat.skill, 'deepseek_chat');
  assert.equal(deepseekChat.status, 'verified');
  assert.equal(deepseekChat.installed, true);

  const qianwenChat = getWorkflowCatalog([
    { id: 'qianwen', name: '千问', installed: true, skill: 'qianwen_chat' },
  ]).find((workflow) => workflow.id === 'ai:qianwen:ai-chat');
  assert.equal(qianwenChat.skill, 'qianwen_chat');
  assert.equal(qianwenChat.status, 'verified');
  assert.equal(qianwenChat.installed, true);

  const xiaoyiChat = getWorkflowCatalog([
    { id: 'xiaoyi', name: '小艺', installed: true, skill: 'xiaoyi_chat' },
  ]).find((workflow) => workflow.id === 'ai:xiaoyi:ai-chat');
  assert.equal(xiaoyiChat.skill, 'xiaoyi_chat');
  assert.equal(xiaoyiChat.status, 'verified');
  assert.equal(xiaoyiChat.installed, true);

  const quickMeeting = workflows.find(
    (workflow) => workflow.id === 'meeting:tencent-meeting:quick-meeting',
  );
  assert.deepEqual(
    quickMeeting.params.map((parameter) => parameter.id),
    ['duration', 'camera', 'shareScreen', 'repeatCount', 'repeatInterval'],
  );

  const joinMeeting = workflows.find(
    (workflow) => workflow.id === 'meeting:tencent-meeting:join-meeting',
  );
  assert.deepEqual(
    joinMeeting.params.map((parameter) => parameter.id),
    ['meetingId', 'duration', 'meetingPassword', 'camera', 'shareScreen', 'repeatCount', 'repeatInterval'],
  );
  assert.equal(joinMeeting.params.find((parameter) => parameter.id === 'meetingPassword').sensitive, true);
  assert.equal(joinMeeting.params.find((parameter) => parameter.id === 'meetingPassword').required, false);
  assert.equal(joinMeeting.status, 'verified');

  const feishu = workflows.find(
    (workflow) => workflow.id === 'meeting:feishu:quick-meeting',
  );
  assert.equal(feishu.appName, '飞书');
  assert.equal(feishu.installed, false);
});

test('workflow catalog accepts strictly verified recorded workflows', () => {
  const workflows = getWorkflowCatalog(
    [{ id: 'tencent-meeting', name: '腾讯会议', installed: true }],
    {
      verifiedWorkflowIds: new Set([
        'meeting:tencent-meeting:quick-meeting',
      ]),
    },
  );
  const quickMeeting = workflows.find(
    (workflow) => workflow.id === 'meeting:tencent-meeting:quick-meeting',
  );

  assert.equal(quickMeeting.status, 'verified');
});
