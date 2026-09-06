import test from 'node:test';
import assert from 'node:assert/strict';

import { getWorkflowCatalog } from '../server/src/workflow-registry.js';

test('workflow catalog contains parameterized meeting variants and omits hidden categories', () => {
  const apps = [
    { id: 'douyin', name: '抖音', installed: true, skill: 'short_video_feed' },
    { id: 'wechat', name: '微信', installed: true, skill: 'wechat_channels_feed' },
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
  ]).filter((workflow) => workflow.categoryId === 'voip');
  assert.equal(voipWorkflows.length, 10);
  for (const workflow of voipWorkflows) {
    assert.deepEqual(workflow.params, []);
    assert.match(workflow.commandTemplate, /第一个联系人/);
    assert.doesNotMatch(workflow.commandTemplate, /\{contact\}/);
  }
  for (const appId of ['wechat', 'qq', 'dingtalk', 'wecom', 'meetime']) {
    const appWorkflows = voipWorkflows.filter((workflow) => workflow.appId === appId);
    assert.deepEqual(
      appWorkflows.map((workflow) => [workflow.functionId, workflow.featureName]),
      [
        ['audio-call', '音频通话'],
        ['video-call', '视频通话'],
      ],
    );
    assert.match(appWorkflows[0].commandTemplate, /音频通话/);
    assert.match(appWorkflows[1].commandTemplate, /视频通话/);
  }

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

  const wechat = workflows.find(
    (workflow) => workflow.id === 'short-video:wechat:short-video-feed',
  );
  assert.equal(wechat.status, 'verified');
  assert.equal(wechat.installed, true);

  const wechatLive = workflows.find(
    (workflow) => workflow.id === 'live:wechat:live-browse',
  );
  assert.equal(wechatLive.status, 'verified');
  assert.equal(wechatLive.installed, true);

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

  const quickMeeting = workflows.find(
    (workflow) => workflow.id === 'meeting:tencent-meeting:quick-meeting',
  );
  assert.deepEqual(
    quickMeeting.params.map((parameter) => parameter.id),
    ['duration', 'camera', 'shareScreen'],
  );

  const joinMeeting = workflows.find(
    (workflow) => workflow.id === 'meeting:tencent-meeting:join-meeting',
  );
  assert.equal(joinMeeting.params.find((parameter) => parameter.id === 'meetingPassword').sensitive, true);
  assert.equal(joinMeeting.status, 'pending');

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
