import test from 'node:test';
import assert from 'node:assert/strict';

import { applyWorkflowParameters } from '../server/src/harness.js';
import { parseTaskFallback } from '../server/src/task-parser.js';
import {
  APP_STORE_DOWNLOAD_VALIDATION_MODE,
  executeAppStoreDownload,
} from '../server/src/skills/app-store-download.js';

const screen = { width: 1280, height: 2832 };
const store = {
  id: 'app-store',
  name: '应用市场',
  packageName: 'com.bbk.appstore',
  harmonyBundleName: 'com.huawei.hmsapp.appgallery',
};
const target = {
  id: 'honor-of-kings',
  name: '王者荣耀',
  packageName: 'com.tencent.tmgp.sgame',
};

function node(attributes, children = []) {
  return { attributes, children };
}

function homeLayout() {
  return node({}, [node({
    id: 'search_icon_button',
    type: 'Button',
    clickable: 'true',
    bounds: '[1084,164][1224,304]',
  })]);
}

function searchLayout() {
  return node({}, [
    node({ id: 'searchFrameInput0', type: 'Search', clickable: 'true', bounds: '[224,164][1224,304]' }),
    node({ id: '__SearchField__searchFrameInput0', type: 'SearchField', bounds: '[350,164][900,304]' }),
    node({ id: '__SearchField__Button__searchFrameInput0', type: 'Button', clickable: 'true', text: '搜索', bounds: '[1027,178][1210,290]' }),
  ]);
}

function resultLayout(status = '安装') {
  return node({}, [node({
    id: 'NormalCard398',
    type: 'Stack',
    clickable: 'true',
    bounds: '[56,332][1224,584]',
  }, [
    node({ text: target.name, bounds: '[294,390][518,464]' }),
    node({ id: 'DownloadButton.content.398', type: 'Stack', clickable: 'true', bounds: '[1000,409][1224,507]' }, [
      node({ id: 'download_button_text', text: status, bounds: '[1035,409][1190,507]' }),
    ]),
  ])]);
}

test('app store parser and structured parameters select 王者荣耀 by default', () => {
  const parsed = parseTaskFallback('应用商店下载王者荣耀5秒', [store, target]);
  assert.equal(parsed.intent, 'app_store_download');
  assert.equal(parsed.appName, '应用市场');
  assert.equal(parsed.targetApp, '王者荣耀');
  assert.equal(parsed.durationMs, 5000);

  const overridden = applyWorkflowParameters(parsed, {
    workflowId: 'upload-download:app-store:download-app',
    parameters: { targetApp: '王者荣耀', duration: { amount: 5, unit: '秒' } },
  });
  assert.equal(overridden.intent, 'app_store_download');
  assert.equal(overridden.targetApp, '王者荣耀');
  assert.equal(overridden.durationMs, 5000);
});

test('app store downloads the first exact result and uninstalls it after the time limit', async () => {
  let state = 'home';
  let installed = true;
  const calls = [];
  const device = {
    async getScreenSize() { return screen; },
    async forceStopPackage(value) { calls.push(['stop', value]); },
    async launchPackage(value) { calls.push(['launch', value]); },
    async getUiTextSnapshot() {
      const layout = state === 'home'
        ? homeLayout()
        : state === 'search'
          ? searchLayout()
          : resultLayout(state === 'progress' ? '22.5%' : '安装');
      return { layout };
    },
    async inputText(value) { calls.push(['input', value]); },
    async tap(value) {
      calls.push(['tap', value.centerX, value.centerY]);
      if (state === 'home') state = 'search';
      else if (state === 'search') state = 'result';
      else if (state === 'result') state = 'progress';
    },
    async getInstalledPackages() { return installed ? `package:${target.packageName}` : ''; },
    async uninstallPackage(value) { calls.push(['uninstall', value]); installed = false; },
  };

  const result = await executeAppStoreDownload({
    device,
    app: store,
    targetApp: target,
    durationMs: 1,
    sleep: async () => {},
  });

  assert.equal(result.validationMode, APP_STORE_DOWNLOAD_VALIDATION_MODE);
  assert.equal(result.validationChecks.every((check) => check.status === 'passed'), true);
  assert.equal(installed, false);
  assert.ok(calls.some((call) => call[0] === 'input' && call[1] === target.name));
  assert.ok(calls.some((call) => call[0] === 'uninstall' && call[1] === target.packageName));
});
