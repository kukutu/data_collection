import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  buildPortMappingScript,
  buildPullMappingArgs,
} from '../server/src/capture/device-log.js';
import {
  findInterfaceByName,
  parseTsharkInterfaces,
} from '../server/src/capture/interface.js';
import { CaptureManager } from '../server/src/capture/manager.js';

test('matches WLAN3 to a tshark interface named WLAN 3', () => {
  const interfaces = parseTsharkInterfaces(
    '1. \\Device\\NPF_{ABC} (WLAN 3)\n2. \\Device\\NPF_{DEF} (Ethernet)',
  );

  assert.equal(findInterfaceByName(interfaces, 'WLAN3')?.name, 'WLAN 3');
  assert.equal(findInterfaceByName(interfaces, 'wlan-3')?.device, '\\Device\\NPF_{ABC}');
});

test('builds package-specific port mapping and HDC pull commands', () => {
  const script = buildPortMappingScript({
    packageName: 'com.ss.hm.ugc.aweme',
    intervalSec: 0.5,
  });

  assert.match(script, /TIME, PROTO, LOCAL_IP, REMOTE_IP, STATE, PID_PROGRAM/);
  assert.match(script, /grep -F "com\.ss\.hm\.ugc\.aweme"/);
  assert.match(script, /sleep 0\.5/);
  assert.deepEqual(
    buildPullMappingArgs({
      transport: 'hdc',
      serial: 'harmony-1',
      remoteFile: '/data/local/tmp/port_mapping.txt',
      localFile: 'D:\\capture\\port_mapping.txt',
    }),
    [
      '-t',
      'harmony-1',
      'file',
      'recv',
      '/data/local/tmp/port_mapping.txt',
      'D:\\capture\\port_mapping.txt',
    ],
  );
});

test('CaptureManager creates App/Business/Session output and uses Harmony bundle matching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-manager-'));
  const calls = [];

  try {
    const manager = new CaptureManager({
      sessionsRoot: root,
      device: {
        async getDeviceStatus() {
          return { connected: true, provider: 'hdc', serial: 'harmony-1' };
        },
      },
      hdcPath: 'hdc.exe',
      listInterfaces: async () => [
        { name: 'WLAN 3', device: '\\Device\\NPF_{ABC}' },
      ],
      startCapture(options) {
        calls.push({ type: 'pcap', options });
        return new FakeChild();
      },
      startLogger(options) {
        calls.push({ type: 'logger', options });
        return new FakeChild();
      },
      async pullMapping(options) {
        calls.push({ type: 'pull', options });
        await writeFile(options.localFile, 'TIME, PROTO\n', 'utf8');
      },
      async createSystemScreenRecorder(options) {
        calls.push({ type: 'system-screen', options });
        return {
          snapshot: () => ({ mode: 'harmony_system', status: 'recording' }),
          async stop() {
            return {
              mode: 'harmony_system',
              status: 'completed',
              errors: [],
              diagnostics: [],
            };
          },
        };
      },
      createScreenRecorder() {
        throw new Error('frame fallback should not start');
      },
    });

    const started = await manager.start({
      taskId: 'task-1',
      appName: '抖音',
      businessName: '短视频',
      packageName: 'com.ss.android.ugc.aweme',
      bundleName: 'com.ss.hm.ugc.aweme',
      interfaceName: 'WLAN3',
    });

    assert.match(started.outputDir, /抖音[\\/]短视频[\\/]\d{8}_\d{2}-\d{2}-\d{2}-/);
    assert.equal(calls.find((call) => call.type === 'logger').options.packageName, 'com.ss.hm.ugc.aweme');
    assert.equal(calls.find((call) => call.type === 'logger').options.serial, 'harmony-1');
    assert.equal(started.screenRecordingMode, 'harmony_system');
    assert.equal(calls.find((call) => call.type === 'system-screen').options.serial, 'harmony-1');

    const stopped = await manager.stop(started.id);
    assert.equal(stopped.status, 'completed');
    assert.equal(await readFile(stopped.mappingFile, 'utf8'), 'TIME, PROTO\n');
    assert.match(await readFile(stopped.reportFile, 'utf8'), /Harmony Bundle: com\.ss\.hm\.ugc\.aweme/);
    assert.match(await readFile(stopped.reportFile, 'utf8'), /Screen Recording Mode: harmony_system/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CaptureManager falls back to frame capture when Harmony system recording cannot start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-manager-fallback-'));
  let fallbackStarts = 0;

  try {
    const manager = new CaptureManager({
      sessionsRoot: root,
      device: {
        async getDeviceStatus() {
          return { connected: true, provider: 'hdc', serial: 'harmony-1' };
        },
      },
      listInterfaces: async () => [
        { name: 'WLAN 3', device: '\\Device\\NPF_{ABC}' },
      ],
      startCapture: () => new FakeChild(),
      startLogger: () => new FakeChild(),
      pullMapping: async () => {},
      async createSystemScreenRecorder() {
        throw new Error('system recorder unavailable');
      },
      createScreenRecorder() {
        fallbackStarts += 1;
        return {
          snapshot: () => ({ status: 'recording', frameCount: 1 }),
          async stop() {
            return { status: 'completed', frameCount: 1, errors: [] };
          },
        };
      },
    });

    const started = await manager.start({
      appName: '抖音',
      businessName: '短视频',
      packageName: 'com.ss.android.ugc.aweme',
      bundleName: 'com.ss.hm.ugc.aweme',
      interfaceName: 'WLAN3',
      recordPortMapping: false,
    });

    assert.equal(started.screenRecordingMode, 'screenshot_fallback');
    assert.equal(fallbackStarts, 1);
    assert.match(started.diagnostics.join('\n'), /system recorder unavailable/);
    await manager.stop(started.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 100;
    this.exitCode = null;
    this.stderr = new PassThrough();
  }

  kill() {
    if (this.exitCode !== null) return false;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}
