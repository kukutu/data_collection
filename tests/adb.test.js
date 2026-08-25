import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenUriArgs } from '../server/src/adb.js';

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
