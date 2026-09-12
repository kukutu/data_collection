import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDeviceController,
  resolvePointCoordinates,
  resolveSwipeCoordinates,
} from '../server/src/device-controller.js';

test('scales legacy coordinates from their reference resolution', () => {
  assert.deepEqual(
    resolvePointCoordinates(
      {
        x: 628,
        y: 1380,
        referenceScreen: { width: 1256, height: 2760 },
      },
      { width: 1280, height: 2832 },
    ),
    {
      x: 640,
      y: 1416,
      referenceScreen: { width: 1256, height: 2760 },
    },
  );

  const swipe = resolveSwipeCoordinates(
    {
      x1: 100,
      y1: 200,
      x2: 400,
      y2: 800,
      referenceScreen: { width: 1000, height: 2000 },
    },
    { width: 1200, height: 2400 },
  );
  assert.deepEqual(
    {
      x1: swipe.x1,
      y1: swipe.y1,
      x2: swipe.x2,
      y2: swipe.y2,
    },
    { x1: 120, y1: 240, x2: 480, y2: 960 },
  );
});

test('supports normalized coordinates for future skills', () => {
  const point = resolvePointCoordinates(
    { normalizedX: 0.5, normalizedY: 0.75 },
    { width: 1280, height: 2832 },
  );
  assert.equal(point.x, 640);
  assert.equal(point.y, 2124);
});

test('uses HDC when ADB has no connected device', async () => {
  const calls = [];
  const controller = createDeviceController({
    adbAdapter: {
      async getDeviceStatus() {
        return { connected: false, provider: 'adb' };
      },
      async launchPackage() {
        calls.push('adb');
      },
    },
    hdcAdapter: {
      async getDeviceStatus() {
        return { connected: true, provider: 'hdc', serial: 'harmony-1' };
      },
      async launchPackage() {
        calls.push('hdc');
      },
    },
  });

  const status = await controller.getDeviceStatus();
  await controller.launchPackage('com.ss.android.ugc.aweme');

  assert.equal(status.provider, 'hdc');
  assert.deepEqual(calls, ['hdc']);
});

test('prefers ADB when both transports have connected devices', async () => {
  const calls = [];
  const controller = createDeviceController({
    adbAdapter: {
      async getDeviceStatus() {
        return { connected: true, provider: 'adb', serial: 'android-1' };
      },
      async keyevent() {
        calls.push('adb');
      },
    },
    hdcAdapter: {
      async getDeviceStatus() {
        return { connected: true, provider: 'hdc', serial: 'harmony-1' };
      },
      async keyevent() {
        calls.push('hdc');
      },
    },
  });

  const status = await controller.getDeviceStatus();
  await controller.keyevent('KEYCODE_HOME');

  assert.equal(status.provider, 'adb');
  assert.deepEqual(calls, ['adb']);
});

test('reuses the last connected transport before probing the other adapter', async () => {
  const statusCalls = [];
  const controller = createDeviceController({
    adbAdapter: {
      async getDeviceStatus() {
        statusCalls.push('adb');
        return { connected: false, provider: 'adb' };
      },
      async keyevent() {},
    },
    hdcAdapter: {
      async getDeviceStatus() {
        statusCalls.push('hdc');
        return { connected: true, provider: 'hdc', serial: 'harmony-1' };
      },
      async keyevent() {},
    },
  });

  await controller.getDeviceStatus();
  await controller.keyevent('Home');

  assert.deepEqual(statusCalls, ['adb', 'hdc']);
});

test('does not run a full device probe before every adapter command', async () => {
  let statusCalls = 0;
  let taps = 0;
  const controller = createDeviceController({
    adbAdapter: {
      async getDeviceStatus() {
        statusCalls += 1;
        return { connected: false, provider: 'adb' };
      },
    },
    hdcAdapter: {
      async getDeviceStatus() {
        statusCalls += 1;
        return { connected: true, provider: 'hdc', serial: 'harmony-1' };
      },
      async tap() {
        taps += 1;
      },
    },
  });

  await controller.getDeviceStatus();
  await controller.tap({ x: 100, y: 200 });
  await controller.tap({ x: 200, y: 300 });

  assert.equal(statusCalls, 2);
  assert.equal(taps, 2);
});

test('prefers a UI target center over fallback coordinates', async () => {
  const taps = [];
  const controller = createDeviceController({
    adbAdapter: {
      async getDeviceStatus() {
        return { connected: false, provider: 'adb' };
      },
    },
    hdcAdapter: {
      async getDeviceStatus() {
        return {
          connected: true,
          provider: 'hdc',
          serial: 'harmony-1',
          screen: { width: 1280, height: 2832 },
        };
      },
      async findTextNode() {
        return {
          bounds: { x1: 1069, y1: 1579, x2: 1252, y2: 1691 },
          centerX: 1161,
          centerY: 1635,
        };
      },
      async tap(point) {
        taps.push(point);
      },
    },
  });

  await controller.getDeviceStatus();
  await controller.tap({
    x: 1158,
    y: 1575,
    target: { texts: ['发送'] },
  });

  assert.equal(taps[0].x, 1161);
  assert.equal(taps[0].y, 1635);
  assert.equal(taps[0].resolvedBy, 'ui-node');
});

test('uses generic UI lookup when a duplicate resource node is outside the target region', async () => {
  const taps = [];
  const uiQueries = [];
  const controller = createDeviceController({
    adbAdapter: {
      async getDeviceStatus() {
        return { connected: false, provider: 'adb' };
      },
    },
    hdcAdapter: {
      async getDeviceStatus() {
        return {
          connected: true,
          provider: 'hdc',
          serial: 'harmony-1',
          screen: { width: 1000, height: 2000 },
        };
      },
      async findResourceNode() {
        return {
          attributes: { id: 'send_button', type: 'Button' },
          centerX: 80,
          centerY: 80,
        };
      },
      async findUiNode(query) {
        uiQueries.push(query);
        return {
          attributes: { resourceId: 'send_button', type: 'Button' },
          centerX: 800,
          centerY: 1600,
        };
      },
      async tap(point) {
        taps.push(point);
      },
    },
  });

  await controller.getDeviceStatus();
  await controller.tap({
    x: 500,
    y: 1000,
    target: {
      id: 'send_button',
      types: ['Button'],
      region: { minX: 600, minY: 1400, maxX: 1000, maxY: 1900 },
    },
  });

  assert.deepEqual(uiQueries[0].ids, ['send_button']);
  assert.deepEqual(uiQueries[0].region, {
    minX: 600,
    minY: 1400,
    maxX: 1000,
    maxY: 1900,
  });
  assert.equal(taps[0].x, 800);
  assert.equal(taps[0].y, 1600);
  assert.equal(taps[0].resolvedBy, 'ui-node');
});

test('locks the selected device for a session and releases it afterward', async () => {
  const targetSerials = [];
  let activeSerial = 'harmony-1';
  const controller = createDeviceController({
    adbAdapter: {
      async getDeviceStatus() {
        return { connected: false, provider: 'adb' };
      },
    },
    hdcAdapter: {
      async getDeviceStatus() {
        return {
          connected: true,
          provider: 'hdc',
          serial: activeSerial,
          screen: { width: 1000, height: 2000 },
        };
      },
      setTargetSerial(serial) {
        targetSerials.push(serial);
      },
      async tap() {},
    },
  });

  const session = await controller.beginSession({ owner: 'test-task' });
  activeSerial = 'harmony-2';
  const status = await controller.getDeviceStatus();

  assert.equal(session.serial, 'harmony-1');
  assert.equal(status.connected, false);
  assert.equal(status.lockedSerial, 'harmony-1');
  assert.deepEqual(targetSerials, ['harmony-1']);

  await controller.endSession(session);
  assert.deepEqual(targetSerials, ['harmony-1', '']);
});
