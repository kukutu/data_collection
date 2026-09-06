import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildHarmonyMediaQueryArgs,
  buildHarmonyRecorderStartArgs,
  buildHarmonyRecorderStopArgs,
  parseHarmonyMediaUri,
  startHarmonySystemScreenRecorder,
} from '../server/src/capture/harmony-screen-recorder.js';

test('builds Harmony system recorder start and stop commands', () => {
  const startArgs = buildHarmonyRecorderStartArgs({
    serial: 'harmony-1',
    fileName: 'capture-test.mp4',
  });
  const stopArgs = buildHarmonyRecorderStopArgs({ serial: 'harmony-1' });

  assert.deepEqual(startArgs.slice(0, 3), ['-t', 'harmony-1', 'shell']);
  assert.ok(startArgs.includes('com.huawei.hmos.screenrecorder'));
  assert.ok(startArgs.includes('CustomizedFileName'));
  assert.equal(startArgs.at(-1), 'capture-test.mp4');
  assert.ok(!stopArgs.includes('CustomizedFileName'));
  assert.deepEqual(
    buildHarmonyMediaQueryArgs({
      serial: 'harmony-1',
      fileName: 'capture-test.mp4',
    }),
    [
      '-t',
      'harmony-1',
      'shell',
      'mediatool',
      'query',
      'capture-test.mp4',
      '-u',
    ],
  );
});

test('parses the matching Harmony media URI', () => {
  const output = [
    'find 2 result',
    '"file://media/Photo/1/old.mp4"',
    '"file://media/Photo/2/capture-test.mp4"',
  ].join('\n');

  assert.equal(
    parseHarmonyMediaUri(output, 'capture-test.mp4'),
    'file://media/Photo/2/capture-test.mp4',
  );
});

test('records, pulls, verifies, and cleans up a Harmony system recording', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harmony-system-recorder-'));
  const outputFile = join(root, 'screen_record.mp4');
  const fileName = 'capture-test.mp4';
  const galleryUri = `file://media/Photo/2/${fileName}`;
  const calls = [];

  try {
    const recorder = await startHarmonySystemScreenRecorder({
      hdcPath: 'hdc.exe',
      serial: 'harmony-1',
      outputFile,
      fileName,
      queryIntervalMs: 1,
      async runHdc(command, args) {
        calls.push({ command, args });
        if (args.includes('query')) {
          return { stdout: `find 1 result\n"${galleryUri}"`, stderr: '' };
        }
        if (args[2] === 'file' && args[3] === 'recv') {
          await writeFile(outputFile, 'system-video');
        }
        return { stdout: 'ok', stderr: '' };
      },
    });

    assert.equal(recorder.snapshot().status, 'recording');
    const result = await recorder.stop();

    assert.equal(result.mode, 'harmony_system');
    assert.equal(result.status, 'completed');
    assert.equal(result.galleryUri, galleryUri);
    assert.equal(await readFile(outputFile, 'utf8'), 'system-video');
    assert.ok(calls.some((call) => call.args.includes('mediatool') && call.args.includes('recv')));
    assert.ok(calls.some((call) => call.args[2] === 'file' && call.args[3] === 'recv'));
    assert.ok(calls.some((call) => call.args.includes('rm') && call.args.includes('-f')));
    assert.ok(calls.some((call) => call.args.includes('delete') && call.args.includes(galleryUri)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
