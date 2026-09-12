import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenUriArgs, findUiNodeInXml } from '../server/src/adb.js';

test('quotes URI arguments so Android shell does not split ampersands', () => {
  const args = buildOpenUriArgs({
    uri: 'androidamap://route?sourceApplication=x&dname=%E5%8C%97%E4%BA%AC%E7%AB%99&dev=0&t=0',
    packageName: 'com.autonavi.minimap',
  });

  const uriArg = args[6];
  assert.equal(uriArg.startsWith("'"), true);
  assert.equal(uriArg.endsWith("'"), true);
  assert.match(uriArg, /&dname=/);
});

test('finds an Android UI node by type, id, clickability, and region', () => {
  const xml = [
    '<hierarchy>',
    '<node class="android.widget.Button" resource-id="send_button" clickable="true" bounds="[10,20][110,120]" />',
    '<node class="android.widget.Button" resource-id="send_button" clickable="true" bounds="[700,1500][900,1700]" />',
    '</hierarchy>',
  ].join('');

  const node = findUiNodeInXml(xml, {
    types: ['android.widget.Button'],
    ids: ['send_button'],
    clickable: true,
    region: { minX: 600, minY: 1400, maxX: 1000, maxY: 1900 },
  });

  assert.equal(node.centerX, 800);
  assert.equal(node.centerY, 1600);
  assert.equal(node.attributes['resource-id'], 'send_button');
});
