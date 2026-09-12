import test from 'node:test';
import assert from 'node:assert/strict';

import { applyWorkflowParameters } from '../server/src/harness.js';
import { parseTaskFallback } from '../server/src/task-parser.js';
import {
  DEFAULT_XUNLEI_MAGNET,
  executeXunleiDownload,
  XUNLEI_DOWNLOAD_VALIDATION_MODE,
} from '../server/src/skills/xunlei-download.js';

const screen = { width: 1280, height: 2832 };
const app = {
  id: 'xunlei',
  name: '迅雷',
  packageName: 'com.xunlei.downloadprovider',
  harmonyBundleName: 'com.xunlei.thunder',
};
const title = '测试磁力任务';

function layout(nodes) {
  return {
    children: nodes.map((attributes) => ({
      attributes: { ...attributes, children: undefined },
      children: (attributes.children || []).map((child) => ({ attributes: child })),
    })),
  };
}

const states = {
  home: layout([
    { text: '新建下载', bounds: '[123,980][292,1029]' },
    { text: '传输', bounds: '[445,2689][516,2738]' },
  ]),
  newDownload: layout([{ text: '添加', bounds: '[923,1523][1175,1628]' }]),
  entered: layout([
    { text: DEFAULT_XUNLEI_MAGNET, bounds: '[174,1801][1102,1893]' },
    { text: '添加', bounds: '[923,1523][1175,1628]' },
  ]),
  select: layout([
    { text: title, bounds: '[252,1033][1224,1157]' },
    { text: '下载到手机', bounds: '[518,2580][764,2637]' },
  ]),
  transfer: layout([
    { text: '传输', bounds: '[445,2689][516,2738]' },
    { text: '全部', bounds: '[70,619][273,717]' },
    {
      clickable: 'true',
      bounds: '[0,735][1280,1049]',
      children: [{ text: title, bounds: '[210,777][1085,911]' }],
    },
    { text: '下载中·1', bounds: '[287,620][543,716]' },
  ]),
  menu: layout([{ text: '删除', bounds: '[605,2670][676,2711]' }]),
  confirm: layout([{ text: '彻底删除', bounds: '[140,2384][1140,2524]' }]),
  deleted: layout([{ text: '暂无进行中的任务', bounds: '[112,381][616,469]' }]),
};

test('Xunlei download parser and structured parameters keep the magnet URL and duration', () => {
  const parsed = parseTaskFallback('迅雷下载', [app]);
  assert.equal(parsed.intent, 'xunlei_download');
  assert.equal(parsed.magnetUrl, DEFAULT_XUNLEI_MAGNET);

  const overridden = applyWorkflowParameters(parsed, {
    workflowId: 'upload-download:xunlei:download-file',
    parameters: { magnetUrl: DEFAULT_XUNLEI_MAGNET, duration: { amount: 5, unit: '秒' } },
  });
  assert.equal(overridden.intent, 'xunlei_download');
  assert.equal(overridden.durationMs, 5000);
  assert.equal(overridden.magnetUrl, DEFAULT_XUNLEI_MAGNET);
});

test('Xunlei download starts from the magnet and permanently deletes the task after the duration', async () => {
  let state = 'home';
  const calls = [];
  const device = {
    async getDeviceStatus() { return { connected: true, screen }; },
    async getScreenSize() { return screen; },
    async forceStopPackage(value) { calls.push(['stop', value]); },
    async launchPackage(value) { calls.push(['launch', value]); },
    async getCurrentFocus() { return { packageName: app.packageName, bundleName: app.harmonyBundleName }; },
    async getUiTextSnapshot() { return { values: flattenValues(states[state]), layout: states[state] }; },
    async openUri(value) { calls.push(['openUri', value.uri]); state = 'select'; },
    async tap(node) {
      calls.push(['tap', node.centerX, node.centerY]);
      if (state === 'home') state = 'newDownload';
      else if (state === 'select') state = 'transfer';
      else if (state === 'menu') state = 'confirm';
      else if (state === 'confirm') state = 'deleted';
    },
    async longPress(node) { calls.push(['longPress', node.centerX, node.centerY]); state = 'menu'; },
  };

  const result = await executeXunleiDownload({
    device,
    app,
    durationMs: 1000,
    sleep: async () => {},
    timings: { startupMs: 0, pageMs: 0, taskMs: 0, cleanupMs: 0 },
  });

  assert.equal(result.validationMode, XUNLEI_DOWNLOAD_VALIDATION_MODE);
  assert.equal(result.validationChecks.every((check) => check.status === 'passed'), true);
  assert.equal(state, 'deleted');
  assert.ok(calls.some((call) => call[0] === 'openUri' && call[1] === DEFAULT_XUNLEI_MAGNET));
  assert.ok(calls.some((call) => call[0] === 'longPress'));
});

function flattenValues(value) {
  const values = [];
  function visit(node) {
    const attributes = node.attributes || node;
    if (attributes.text) values.push(attributes.text);
    for (const child of node.children || []) visit(child);
  }
  visit(value);
  return values;
}
