import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHarmonyHomePageSwipe,
  findHarmonyHomeFolders,
  findHarmonyHomeTarget,
} from '../server/src/harmony-home.js';

const layout = {
  attributes: { bounds: '[0,0][1280,2832]' },
  children: [
    {
      attributes: {
        id: 'Folder_accessibility_1',
        bounds: '[20,800][620,1400]',
        clickable: 'true',
        visible: 'true',
        enabled: 'true',
      },
      children: [],
    },
    {
      attributes: {
        id: 'AppIconCommonView_com.huawei.hmos.vassistant.launcher.VoiceAbility',
        bounds: '[100,500][200,600]',
        clickable: 'true',
        visible: 'true',
        enabled: 'true',
      },
      children: [],
    },
    {
      attributes: {
        id: 'AppIconCommonView_com.huawei.hmos.vassistant.launcher.VoiceAbility',
        bounds: '[620,1600][900,1900]',
        clickable: 'true',
        visible: 'true',
        enabled: 'true',
      },
      children: [],
    },
  ],
};

test('finds the largest visible Harmony desktop app node by resource id', () => {
  const node = findHarmonyHomeTarget(layout, {
    resourceId:
      'AppIconCommonView_com.huawei.hmos.vassistant.launcher.VoiceAbility',
  });

  assert.equal(node.centerX, 760);
  assert.equal(node.centerY, 1750);
});

test('finds clickable Harmony desktop folders without duplicates', () => {
  const folders = findHarmonyHomeFolders(layout);

  assert.equal(folders.length, 1);
  assert.equal(folders[0].centerX, 320);
  assert.equal(folders[0].centerY, 1100);
});

test('builds proportional left and right desktop swipes', () => {
  const left = buildHarmonyHomePageSwipe({ width: 1280, height: 2832 }, 'left');
  const right = buildHarmonyHomePageSwipe({ width: 1280, height: 2832 }, 'right');

  assert.ok(left.x1 > left.x2);
  assert.ok(right.x1 < right.x2);
  assert.equal(left.y1, right.y1);
  assert.equal(left.y2, right.y2);
});
