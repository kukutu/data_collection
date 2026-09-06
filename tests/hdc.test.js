import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSerialTaskQueue,
  encodeHarmonyKeyText,
  mapHarmonyKeyEvent,
  parseBundleLaunchInfo,
  parseHdcTargets,
  parseHarmonyForeground,
  parseHarmonyScreenSize,
} from '../server/src/hdc.js';

test('serial task queue prevents concurrent Harmony layout operations', async () => {
  const enqueue = createSerialTaskQueue();
  const order = [];
  let active = 0;
  let maxActive = 0;

  const run = (id) =>
    enqueue(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start-${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end-${id}`);
      active -= 1;
      return id;
    });

  assert.deepEqual(await Promise.all([run(1), run(2), run(3)]), [1, 2, 3]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    'start-1',
    'end-1',
    'start-2',
    'end-2',
    'start-3',
    'end-3',
  ]);

  await assert.rejects(enqueue(async () => {
    throw new Error('expected failure');
  }));
  assert.equal(await enqueue(async () => 'recovered'), 'recovered');
});

test('parses connected HDC USB targets and ignores UART placeholders', () => {
  const targets = parseHdcTargets([
    '6YB0126127000269\t\tUSB\tConnected\tlocalhost\thdc',
    'COM3\t\tUART\tReady\tunknown...\thdc',
  ].join('\n'));

  assert.deepEqual(targets, [
    {
      serial: '6YB0126127000269',
      transport: 'USB',
      state: 'Connected',
    },
  ]);
});

test('extracts the main Harmony ability from bm dump JSON', () => {
  const launch = parseBundleLaunchInfo(JSON.stringify({
    entryModuleName: 'entry',
    mainEntry: 'entry',
    hapModuleInfos: [
      {
        moduleName: 'entry',
        mainAbility: 'MainAbility',
        mainElementName: 'MainAbility',
      },
    ],
  }));

  assert.deepEqual(launch, {
    moduleName: 'entry',
    abilityName: 'MainAbility',
  });
});

test('parses the foreground Harmony ability and maps it to the Android identity', () => {
  const focus = parseHarmonyForeground(
    [
      'AbilityRecord ID #1000',
      '  main name [OldAbility]',
      '  bundle name [com.example.old]',
      '  state #BACKGROUND',
      '  app state #FOREGROUND',
      'AbilityRecord ID #1347',
      '  main name [MainAbility]',
      '  bundle name [com.ss.hm.ugc.aweme]',
      '  state #FOREGROUND',
    ].join('\n'),
    [
      {
        packageName: 'com.ss.android.ugc.aweme',
        harmonyBundleName: 'com.ss.hm.ugc.aweme',
      },
    ],
  );

  assert.equal(focus.packageName, 'com.ss.android.ugc.aweme');
  assert.equal(focus.bundleName, 'com.ss.hm.ugc.aweme');
  assert.equal(focus.activity, 'MainAbility');
});

test('does not treat app state as the ability foreground state', () => {
  const focus = parseHarmonyForeground([
    'AbilityRecord ID #1000',
    '  main name [OldAbility]',
    '  bundle name [com.example.old]',
    '  state #BACKGROUND',
    '  app state #FOREGROUND',
  ].join('\n'));

  assert.equal(focus, null);
});

test('parses Harmony screen size from a layout root node', () => {
  const size = parseHarmonyScreenSize('{"attributes":{"bounds":"[0,0][1256,2760]"}}');
  assert.deepEqual(size, { width: 1256, height: 2760 });
});

test('maps Android key event names to Harmony UI input names', () => {
  assert.equal(mapHarmonyKeyEvent('KEYCODE_BACK'), 'Back');
  assert.equal(mapHarmonyKeyEvent('KEYCODE_HOME'), 'Home');
});

test('encodes ASCII text as Harmony hardware key codes', () => {
  assert.deepEqual(encodeHarmonyKeyText('Fact9'), [2022, 2017, 2019, 2036, 2009]);
  assert.throws(() => encodeHarmonyKeyText('two words'), /without spaces/);
});
