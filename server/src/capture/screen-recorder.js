import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function startScreenRecorder({
  device,
  outputDir,
  outputFile,
  ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg',
  fps = 1,
  runEncoder = runFfmpeg,
}) {
  if (!device?.screenshotPng) throw new Error('device.screenshotPng is required');
  if (!outputDir) throw new Error('outputDir is required');
  if (!outputFile) throw new Error('outputFile is required');

  const frameRate = Math.max(1, Math.min(10, Number(fps) || 1));
  const framesDir = join(outputDir, 'screen_frames');
  const errors = [];
  let stopped = false;
  let finished = false;
  let finalStatus = 'recording';
  let frameCount = 0;
  let stopPromise = null;

  const loopPromise = captureFrames();

  return {
    stop() {
      if (!stopPromise) {
        stopped = true;
        stopPromise = finishRecording();
      }
      return stopPromise;
    },
    snapshot,
  };

  function snapshot() {
    return {
      outputFile,
      framesDir,
      frameCount,
      errors: errors.slice(),
      status: finished ? finalStatus : stopPromise ? 'stopping' : 'recording',
    };
  }

  async function captureFrames() {
    await mkdir(framesDir, { recursive: true });
    const intervalMs = Math.round(1000 / frameRate);

    while (!stopped) {
      const startedAt = Date.now();
      try {
        const png = await device.screenshotPng();
        frameCount += 1;
        const frameFile = join(framesDir, `frame-${String(frameCount).padStart(6, '0')}.png`);
        await writeFile(frameFile, png);
      } catch (error) {
        errors.push(`截图失败: ${error.message}`);
      }

      const remaining = intervalMs - (Date.now() - startedAt);
      if (!stopped && remaining > 0) await sleep(remaining);
    }
  }

  async function finishRecording() {
    await loopPromise;
    if (frameCount === 0) {
      errors.push('没有采集到有效屏幕帧');
      await rm(framesDir, { recursive: true, force: true }).catch(() => {});
      finalStatus = 'empty';
      finished = true;
      return snapshot();
    }

    try {
      await runEncoder({
        ffmpeg,
        framesDir,
        outputFile,
        frameRate,
      });
      await rm(framesDir, { recursive: true, force: true });
      finalStatus = 'completed';
    } catch (error) {
      errors.push(`合成屏幕录制失败: ${error.message}`);
      finalStatus = 'failed';
    }

    finished = true;
    return snapshot();
  }
}

export function buildFfmpegArgs({ framesDir, outputFile, frameRate }) {
  return [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    String(frameRate),
    '-i',
    join(framesDir, 'frame-%06d.png'),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputFile,
  ];
}

function runFfmpeg({ ffmpeg, framesDir, outputFile, frameRate }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      buildFfmpegArgs({ framesDir, outputFile, frameRate }),
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const stderr = [];

    child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.join('').trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
