import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskFallback } from '../server/src/task-parser.js';
import { loadApps } from '../server/src/app-registry.js';
import { applyWorkflowParameters } from '../server/src/harness.js';
import {
  executeXunleiUploadMedia,
  XUNLEI_UPLOAD_MEDIA_VALIDATION_MODE,
} from '../server/src/skills/xunlei-upload.js';

const screen = { width: 1280, height: 2832 };
const app = {
  id: 'xunlei',
  name: '迅雷',
  packageName: 'com.xunlei.downloadprovider',
  harmonyBundleName: 'com.xunlei.thunder',
};

function layout(nodes) {
  return { children: nodes.map((attributes) => ({ attributes })) };
}

const home = layout([
  { text: '传输', clickable: 'true', bounds: '[400,2500][600,2800]', type: 'Text' },
]);
const transfer = layout([
  { text: '传输', bounds: '[320,2538][640,2832]', type: 'Text' },
  { text: '上传', clickable: 'true', bounds: '[574,185][743,283]', type: 'Text' },
  { id: '__Common__', clickable: 'true', bounds: '[902,150][1070,318]', type: '__Common__' },
]);
const menu = layout([{ text: '上传至云盘', clickable: 'true', bounds: '[700,700][1100,850]', type: 'Text' }]);
const cloud = layout([{ text: '相册', clickable: 'true', bounds: '[100,300][500,500]', type: 'Text' }]);
const picker = layout([
  { text: '图片和视频', bounds: '[250,220][650,350]', type: 'Text' },
  { id: 'Selector_0', type: 'Checkbox', clickable: 'true', bounds: '[553,1139][623,1209]' },
  { text: '已选 0/100', bounds: '[56,2505][333,2571]', type: 'Text' },
  { text: '完成', bounds: '[1048,2510][1147,2567]', type: 'Text' },
]);
const selectedPicker = layout([
  { text: '图片和视频', bounds: '[250,220][650,350]', type: 'Text' },
  { id: 'Selector_0', type: 'Checkbox', clickable: 'true', bounds: '[553,1139][623,1209]' },
  { text: '已选 1/100', bounds: '[56,2505][333,2571]', type: 'Text' },
  { text: '完成', bounds: '[1048,2510][1147,2567]', type: 'Text' },
]);
const path = layout([
  { text: '请选择云盘路径', bounds: '[224,192][714,274]', type: 'Text' },
  { text: '确认', clickable: 'true', bounds: '[661,2594][1224,2734]', type: 'Text' },
]);
const success = layout([
  { text: '上传任务创建成功', bounds: '[300,500][900,600]', type: 'Text' },
  { text: '已完成·4', bounds: '[523,360][779,458]', type: 'Button' },
]);

test('Xunlei upload parser and workflow parameters select the first media item', () => {
  assert.deepEqual(parseTaskFallback('迅雷上传图片', loadApps()), {
    intent: 'xunlei_upload_media',
    appName: '迅雷',
  });
  assert.equal(
    applyWorkflowParameters({}, { workflowId: 'upload-download:xunlei:upload-media' }).intent,
    'xunlei_upload_media',
  );
});

test('Xunlei upload navigates through cloud album and confirms the upload path', async () => {
  let state = 'home';
  const calls = [];
  const device = {
    async getDeviceStatus() { return { connected: true, screen }; },
    async getScreenSize() { return screen; },
    async forceStopPackage(value) { calls.push(['stop', value]); },
    async launchPackage(value) { calls.push(['launch', value]); state = 'home'; },
    async getCurrentFocus() { return { packageName: app.packageName, bundleName: app.harmonyBundleName }; },
    async getUiTextSnapshot() {
      const current = { home, transfer, upload: transfer, menu, cloud, picker, selectedPicker, path, success }[state];
      return { values: flattenValues(current), layout: current };
    },
    async tap(node) {
      calls.push(['tap', node.centerX, node.centerY]);
      if (state === 'home') state = 'transfer';
      else if (state === 'transfer') state = 'upload';
      else if (state === 'upload') state = 'menu';
      else if (state === 'menu') state = 'cloud';
      else if (state === 'cloud') state = 'picker';
      else if (state === 'picker') state = 'selectedPicker';
      else if (state === 'selectedPicker') state = 'path';
      else if (state === 'path') state = 'success';
    },
  };

  const result = await executeXunleiUploadMedia({
    device,
    app,
    sleep: async () => {},
    timings: { startupMs: 0, pageMs: 0, pickerMs: 0, resultMs: 0 },
  });

  assert.equal(result.validationMode, XUNLEI_UPLOAD_MEDIA_VALIDATION_MODE);
  assert.equal(result.validationChecks.every((check) => check.status === 'passed'), true);
  assert.equal(state, 'success');
  assert.deepEqual(calls.slice(0, 2), [
    ['stop', app.packageName],
    ['launch', app.packageName],
  ]);
  assert.equal(calls.length, 10);
});

function flattenValues(value) {
  const values = [];
  function visit(node) {
    for (const child of node.children || []) {
      const attributes = child.attributes || child;
      if (attributes.text) values.push(attributes.text);
      visit(child);
    }
  }
  visit(value);
  return values;
}
