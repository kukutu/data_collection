import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executeBaiduNetdiskUpload,
} from '../server/src/skills/baidu-netdisk-upload.js';

const app = {
  id: 'baidu-netdisk',
  packageName: 'com.baidu.netdisk',
};

function node(text, bounds, attributes = {}) {
  return {
    attributes: { text, bounds, ...attributes },
    children: [],
  };
}

test('Baidu Netdisk upload starts synchronized capture after the upload is submitted', async () => {
  const layout = {
    children: [
      node('文件', '[0,2600][200,2800]'),
      node('', '[1080,2200][1260,2450]', { clickable: 'true' }),
      node('图片', '[200,900][500,1050]'),
      node('所有图片', '[200,900][550,1050]'),
      node('全选', '[950,150][1150,300]'),
      node('完成', '[950,2400][1150,2600]'),
      node('', '[1120,100][1270,350]'),
      node('最近文件', '[400,500][800,700]'),
      node('删除', '[950,2400][1150,2600]'),
      node('确定', '[500,1300][800,1500]'),
    ],
  };
  const events = [];
  const device = {
    async getScreenSize() {
      return { width: 1280, height: 2832 };
    },
    async forceStopPackage() {
      events.push('stop');
    },
    async launchPackage() {
      events.push('launch');
    },
    async getUiTextSnapshot() {
      return { layout };
    },
    async tap() {
      events.push('tap');
    },
  };
  let captureCalls = 0;
  const result = await executeBaiduNetdiskUpload({
    device,
    app,
    mediaType: 'image',
    startCapture: async () => {
      captureCalls += 1;
      events.push('capture-start');
    },
    sleep: async () => {},
    onStep: (step, label) => events.push(`step-${step}:${label}`),
  });

  assert.equal(captureCalls, 1);
  assert.equal(result.validationChecks.length, 8);
  assert.ok(events.indexOf('capture-start') > events.indexOf('step-5:全选待上传文件'));
  assert.ok(events.indexOf('capture-start') < events.indexOf('step-6:等待上传完成'));
});
