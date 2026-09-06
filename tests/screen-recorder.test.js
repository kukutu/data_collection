import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildFfmpegArgs,
  startScreenRecorder,
} from '../server/src/capture/screen-recorder.js';

test('screen recorder captures frames and invokes the ffmpeg encoder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screen-recorder-'));
  let resolveCaptured;
  const captured = new Promise((resolve) => {
    resolveCaptured = resolve;
  });
  const encoderCalls = [];

  try {
    const recorder = startScreenRecorder({
      device: {
        async screenshotPng() {
          resolveCaptured();
          return Buffer.from('png-frame');
        },
      },
      outputDir: root,
      outputFile: join(root, 'screen_record.mp4'),
      fps: 1,
      async runEncoder(options) {
        encoderCalls.push(options);
      },
    });

    await captured;
    const result = await recorder.stop();

    assert.equal(result.status, 'completed');
    assert.ok(result.frameCount >= 1);
    assert.equal(encoderCalls.length, 1);
    assert.equal(encoderCalls[0].frameRate, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('screen recorder handles a stop before the first frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'screen-recorder-empty-'));
  let encoderCalled = false;

  try {
    const recorder = startScreenRecorder({
      device: {
        async screenshotPng() {
          return Buffer.from('unused');
        },
      },
      outputDir: root,
      outputFile: join(root, 'screen_record.mp4'),
      async runEncoder() {
        encoderCalled = true;
      },
    });

    const result = await recorder.stop();
    assert.equal(result.status, 'empty');
    assert.equal(result.frameCount, 0);
    assert.equal(encoderCalled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ffmpeg arguments use numbered PNG frames and H.264 output', () => {
  const args = buildFfmpegArgs({
    framesDir: 'D:\\capture\\frames',
    outputFile: 'D:\\capture\\screen_record.mp4',
    frameRate: 2,
  });

  assert.deepEqual(args.slice(0, 7), [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    '2',
    '-i',
    'D:\\capture\\frames\\frame-%06d.png',
  ]);
  assert.ok(args.includes('libx264'));
  assert.equal(args.at(-1), 'D:\\capture\\screen_record.mp4');
});
